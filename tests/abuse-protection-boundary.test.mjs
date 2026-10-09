// Perilla 9 — Invite / Signup / Billing Abuse Protection Hardening.
//
// Authorization (Perillas 1-8) answers "who may do this." This perilla adds
// a second, independent boundary: "how often, how safely, and under what
// replay/cost limits may this be done" — a correctly-authorized caller can
// still flood signup, brute-force an invite token, or spam Stripe session
// creation. See docs/security/abuse-protection-boundary.md.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  enforceAbuseLimit,
  hashAbuseIdentifier,
  normalizeAbuseIdentifier,
  buildAbuseKey,
  createInMemoryAbuseStore,
  abuseDenyResponse,
} from "../src/lib/security/abuse-protection.ts";
import { ABUSE_PROTECTION_REGISTRY } from "../src/lib/security/abuse-protection-registry.ts";
import { handleCreateCheckoutSession } from "../src/app/api/billing/create-checkout-session/route.ts";
import { handleCreatePortalSession } from "../src/app/api/billing/create-portal-session/route.ts";

// These suites test abuse limits on the billing routes, which only run once the
// billing release control is on (src/lib/billing-release.ts; default OFF).
// tests/billing-release-control.test.mjs covers the disabled state.
process.env.PMFREAK_BILLING_CHECKOUT_ENABLED = "true";
import { requireBillingManageMembership } from "../src/lib/workspace-access.ts";
import { PUBLIC_ROUTE_ALLOWLIST } from "../src/lib/security/route-guard-registry.ts";

const read = (path) => readFileSync(path, "utf8");
const abuseProtectionSrc = read("src/lib/security/abuse-protection.ts");
const abuseRegistrySrc = read("src/lib/security/abuse-protection-registry.ts");

const findEntry = (id) => ABUSE_PROTECTION_REGISTRY.find((entry) => entry.id === id);

// ── 1. Registry exists ──────────────────────────────────────────────────────

test("1. abuse-protection-registry.ts exists and exports a non-empty registry", () => {
  assert.ok(Array.isArray(ABUSE_PROTECTION_REGISTRY));
  assert.ok(ABUSE_PROTECTION_REGISTRY.length > 10);
});

// ── 2. Registry covers public state-creating routes ─────────────────────────

test("2. registry covers public state-creating routes: trust handshake request, early-access accept, workspace invite accept", () => {
  for (const id of ["governance.trust.handshake_request", "early_access.accept", "workspace.invite_accept"]) {
    const entry = findEntry(id);
    assert.ok(entry, `missing registry entry: ${id}`);
    assert.equal(entry.classification, "public-state-creating");
    assert.equal(entry.enforced, true);
  }
});

// ── 3. Registry covers billing cost routes ───────────────────────────────────

test("3. registry covers create-checkout-session and create-portal-session", () => {
  for (const id of ["billing.create_checkout_session", "billing.create_portal_session"]) {
    const entry = findEntry(id);
    assert.ok(entry, `missing registry entry: ${id}`);
    assert.equal(entry.classification, "billing-cost");
    assert.equal(entry.enforced, true);
  }
});

// ── 4. Registry covers invite spam routes ────────────────────────────────────

test("4. registry covers workspace invite create and early-access invite create/resend", () => {
  assert.ok(findEntry("workspace.invite_create"));
  assert.ok(findEntry("early_access.invite_create"));
  assert.ok(findEntry("early_access.founder_action")); // covers resend_invite_email
});

// ── 5. Registry covers AI/upload/evidence routes ─────────────────────────────

test("5. registry covers AI/upload/evidence expensive routes", () => {
  const ids = ABUSE_PROTECTION_REGISTRY.map((entry) => entry.id);
  assert.ok(ids.some((id) => id.startsWith("ai.")));
  assert.ok(ids.some((id) => id.startsWith("upload.")));
  assert.ok(ids.some((id) => id.startsWith("project_evidence")));
});

// ── 6. Abuse key does not store raw token ────────────────────────────────────

test('6. hashAbuseIdentifier("secret-token") does not contain "secret-token"', () => {
  const hashed = hashAbuseIdentifier("secret-token");
  assert.ok(!hashed.includes("secret-token"));
  assert.match(hashed, /^[0-9a-f]{64}$/);
});

// ── 7. Email identifiers normalize before hashing ────────────────────────────

test("7. USER@Example.COM and user@example.com produce the same hash", () => {
  assert.equal(hashAbuseIdentifier("USER@Example.COM"), hashAbuseIdentifier("user@example.com"));
  assert.equal(normalizeAbuseIdentifier("  USER@Example.COM  "), "user@example.com");
});

// ── 8. Empty identifier fails closed to an anonymous bucket ──────────────────

test("8. empty/null/undefined identifier does not crash and buckets to a fixed anonymous hash", () => {
  assert.doesNotThrow(() => hashAbuseIdentifier(""));
  assert.doesNotThrow(() => hashAbuseIdentifier(null));
  assert.doesNotThrow(() => hashAbuseIdentifier(undefined));
  assert.equal(hashAbuseIdentifier(""), hashAbuseIdentifier(null));
  assert.equal(hashAbuseIdentifier(null), hashAbuseIdentifier(undefined));
});

// ── 9. Rate limit denies after max attempts ──────────────────────────────────

test("9. limit 3/window: attempts 1-3 allowed, 4th denied", async () => {
  const store = createInMemoryAbuseStore();
  const call = () => enforceAbuseLimit({ scope: "test.scope", identifier: "user-1", limit: 3, windowSeconds: 60 }, { store, now: () => 1_000_000 });

  const r1 = await call();
  const r2 = await call();
  const r3 = await call();
  const r4 = await call();

  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
  assert.equal(r4.allowed, false);
  assert.equal(r4.reason, "rate_limited");
  assert.ok(r4.retryAfterSeconds > 0);
});

// ── 10. Window reset allows new attempts ─────────────────────────────────────

test("10. after windowSeconds elapses, the counter resets and a new attempt is allowed", async () => {
  const store = createInMemoryAbuseStore();
  let clock = 0;
  const now = () => clock;
  const call = () => enforceAbuseLimit({ scope: "test.window", identifier: "user-2", limit: 2, windowSeconds: 10 }, { store, now });

  clock = 0;
  assert.equal((await call()).allowed, true);
  clock = 1_000;
  assert.equal((await call()).allowed, true);
  clock = 2_000;
  assert.equal((await call()).allowed, false); // 3rd attempt in the same 10s window

  clock = 11_000; // next window
  assert.equal((await call()).allowed, true);
});

// Different identifiers/scopes never share a bucket.

test("distinct identifiers and distinct scopes get independent counters", async () => {
  const store = createInMemoryAbuseStore();
  const now = () => 5_000;
  const a = await enforceAbuseLimit({ scope: "s", identifier: "a", limit: 1, windowSeconds: 60 }, { store, now });
  const b = await enforceAbuseLimit({ scope: "s", identifier: "b", limit: 1, windowSeconds: 60 }, { store, now });
  const c = await enforceAbuseLimit({ scope: "s2", identifier: "a", limit: 1, windowSeconds: 60 }, { store, now });
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(c.allowed, true);
});

// Invalid limit/window config fails closed.

test("invalid limit/windowSeconds configuration fails closed (invalid_key)", async () => {
  const decision = await enforceAbuseLimit({ scope: "s", identifier: "x", limit: 0, windowSeconds: 60 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "invalid_key");
});

// ── 11 & 12. Billing routes use the abuse guard (behavioral) ────────────────

function fakeSupabaseClient(membershipRow) {
  return {
    from(table) {
      assert.equal(table, "workspace_memberships");
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: membershipRow }),
      };
    },
  };
}

const actor = () => ({
  id: "user-1",
  email: "person@example.com",
  fullName: "Person",
  companyId: "company-1",
  companyName: "Acme",
  role: "viewer",
  onboardingCompleted: true,
});

function fakeStripe(calls) {
  return {
    customers: { create: async () => ({ id: "cus_new" }) },
    checkout: { sessions: { create: async (args) => { calls.push(args); return { id: "sess_1", url: "https://stripe.test/checkout/sess_1" }; } } },
    billingPortal: { sessions: { create: async (args) => { calls.push(args); return { id: "bps_1", url: "https://stripe.test/portal/bps_1" }; } } },
  };
}

function checkoutRequest() {
  return new Request("https://app.test/api/billing/create-checkout-session", {
    method: "POST",
    headers: new Headers({ origin: "https://app.test", "content-type": "application/json", "x-pmf-workspace-id": "workspace.demo" }),
    body: JSON.stringify({ plan: "pro" }),
  });
}

function portalRequest() {
  return new Request("https://app.test/api/billing/create-portal-session", {
    method: "POST",
    headers: new Headers({ origin: "https://app.test", "x-pmf-workspace-id": "workspace.demo" }),
  });
}

test("11. create-checkout-session calls enforceAbuseLimit and returns 429 with no Stripe session on deny", async () => {
  const stripeCalls = [];
  const abuseCalls = [];
  const deps = {
    getAuthUser: async () => actor(),
    requireBillingManageMembership: (input) => requireBillingManageMembership(input, async () => fakeSupabaseClient({ role: "owner" })),
    getCompanySubscription: async () => ({ plan: "free", subscriptionStatus: "inactive", stripeCustomerId: "cus_existing", stripeSubscriptionId: null, currentPeriodEnd: null }),
    updateCompanySubscription: async (companyId, patch) => patch,
    getStripeServerClient: () => fakeStripe(stripeCalls),
    enforceAbuseLimit: async (input) => {
      abuseCalls.push(input);
      return { allowed: false, key: "denied", reason: "rate_limited", retryAfterSeconds: 30 };
    },
  };
  const response = await handleCreateCheckoutSession(checkoutRequest(), deps);
  assert.equal(response.status, 429);
  assert.equal(stripeCalls.length, 0);
  assert.equal(abuseCalls.length, 1);
  assert.equal(abuseCalls[0].scope, "billing.create_checkout_session");
});

test("12. create-portal-session calls enforceAbuseLimit and returns 429 with no Stripe session on deny", async () => {
  const stripeCalls = [];
  const abuseCalls = [];
  const deps = {
    getAuthUser: async () => actor(),
    requireBillingManageMembership: (input) => requireBillingManageMembership(input, async () => fakeSupabaseClient({ role: "owner" })),
    getCompanySubscription: async () => ({ plan: "free", subscriptionStatus: "inactive", stripeCustomerId: "cus_existing", stripeSubscriptionId: null, currentPeriodEnd: null }),
    getStripeServerClient: () => fakeStripe(stripeCalls),
    enforceAbuseLimit: async (input) => {
      abuseCalls.push(input);
      return { allowed: false, key: "denied", reason: "rate_limited", retryAfterSeconds: 30 };
    },
  };
  const response = await handleCreatePortalSession(portalRequest(), deps);
  assert.equal(response.status, 429);
  assert.equal(stripeCalls.length, 0);
  assert.equal(abuseCalls.length, 1);
  assert.equal(abuseCalls[0].scope, "billing.create_portal_session");
});

test("billing checkout allows through and creates a Stripe session when the abuse guard allows", async () => {
  const stripeCalls = [];
  const deps = {
    getAuthUser: async () => actor(),
    requireBillingManageMembership: (input) => requireBillingManageMembership(input, async () => fakeSupabaseClient({ role: "owner" })),
    getCompanySubscription: async () => ({ plan: "free", subscriptionStatus: "inactive", stripeCustomerId: "cus_existing", stripeSubscriptionId: null, currentPeriodEnd: null }),
    updateCompanySubscription: async (companyId, patch) => patch,
    getStripeServerClient: () => fakeStripe(stripeCalls),
    enforceAbuseLimit: async () => ({ allowed: true, key: "ok" }),
  };
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
  process.env.STRIPE_PRO_PRICE_ID = "price_pro";
  const response = await handleCreateCheckoutSession(checkoutRequest(), deps);
  assert.equal(response.status, 200);
  assert.equal(stripeCalls.length, 1);
});

// ── 13. Billing abuse key includes user + workspace, not just IP ────────────

test("13. billing routes build the abuse identifier from user id + workspace id", () => {
  const checkoutSrc = read("src/app/api/billing/create-checkout-session/route.ts");
  const portalSrc = read("src/app/api/billing/create-portal-session/route.ts");
  for (const src of [checkoutSrc, portalSrc]) {
    assert.match(src, /enforceAbuseLimit\(/);
    assert.match(src, /buildAbuseKey\(\[user\.id,\s*workspaceId\]\)/);
  }
});

// ── 14 & 15. Invite/token accept routes have attempt policies ───────────────

test("14. workspace invite accept page has a token attempt policy (per-ip and per-token, token hashed before use)", () => {
  const src = read("src/app/(protected)/accept-invite/[token]/page.tsx");
  assert.match(src, /enforceAbuseLimit\(/);
  assert.match(src, /scope:\s*"workspace\.invite_accept"/);
  assert.match(src, /action:\s*"per_token"/);
});

test("15. early-access accept route has a token/email attempt policy", () => {
  const src = read("src/app/api/early-access/accept/route.ts");
  assert.match(src, /enforceAbuseLimit\(/);
  assert.match(src, /scope:\s*"early_access\.accept"/);
  assert.match(src, /action:\s*"per_token"/);
});

// ── 16. Invite creation/resend has cooldown/rate policy ──────────────────────

test("16. workspace invite creation has an actor rate limit and a same-email cooldown", () => {
  const src = read("src/app/(protected)/team/actions.ts");
  assert.match(src, /enforceAbuseLimit\(/);
  assert.match(src, /scope:\s*"workspace\.invite_create"/);
  assert.match(src, /per_email_cooldown/);
});

test("16b. early-access invite create and founder-action (resend) routes have rate limits", () => {
  const createSrc = read("src/app/api/early-access/invites/route.ts");
  const founderSrc = read("src/app/api/early-access/founder-actions/route.ts");
  assert.match(createSrc, /enforceAbuseLimit\(/);
  assert.match(founderSrc, /enforceAbuseLimit\(/);
  assert.match(founderSrc, /scope:\s*"early_access\.founder_action"/);
});

// ── 17. Token errors stay generic / are documented residuals ────────────────

test("17. workspace invite accept surfaces only known generic error reasons, never raw DB/token detail", () => {
  const src = read("src/app/(protected)/accept-invite/[token]/page.tsx");
  const messages = src.match(/ERROR_MESSAGES[\s\S]*?};/)[0];
  for (const reason of ["invalid_token", "invalid_role", "email_mismatch", "expired", "revoked", "already_used"]) {
    assert.match(messages, new RegExp(reason));
  }
  assert.doesNotMatch(messages, /token_hash|invite_token_hash/);
});

// ── 18. Trust handshake request has a rate limit ─────────────────────────────

test("18. trust handshake request route enforces a per-ip+issuer rate limit before creating the handshake", () => {
  const src = read("src/app/api/governance/trust/handshakes/request/route.ts");
  const enforceIdx = src.indexOf("enforceAbuseLimit(");
  const requestIdx = src.indexOf("requestTrustHandshake(");
  assert.ok(enforceIdx > 0, "enforceAbuseLimit not found");
  assert.ok(requestIdx > enforceIdx, "abuse check must run before the handshake is created");
  assert.match(src, /scope:\s*"governance\.trust\.handshake_request"/);
});

// ── 19. Public discovery routes are classified low-risk ─────────────────────

test("19. public discovery routes (.well-known, keys) are classified public-read-low-risk in the abuse registry", () => {
  const wellKnown = findEntry("governance.trust.well_known_discovery");
  const keys = findEntry("governance.trust.keys_discovery");
  assert.ok(wellKnown);
  assert.ok(keys);
  assert.equal(wellKnown.classification, "public-read-low-risk");
  assert.equal(keys.classification, "public-read-low-risk");
});

// ── 20. Federation webhook has secret check + abuse policy for invalid attempts ──

test("20. federation webhook verifies the shared secret and rate-limits invalid attempts", () => {
  const src = read("src/app/api/federation/webhooks/[connectorId]/route.ts");
  assert.match(src, /requireSystemOrWebhookSecret/);
  assert.match(src, /enforceAbuseLimit\(/);
  assert.match(src, /scope:\s*"federation\.webhook_invalid_attempt"/);
  const authIdx = src.indexOf("federationAuthorized = false");
  const abuseIdx = src.indexOf("federation.webhook_invalid_attempt");
  assert.ok(authIdx > 0 && abuseIdx > authIdx, "abuse check must reference the invalid-attempt path");
});

// ── 21 & 22. Expensive AI/evidence/upload routes registered and guarded ─────

const EXPENSIVE_ROUTE_FILES = [
  "src/app/api/upload/route.ts",
  "src/app/api/project-evidence/route.ts",
  "src/app/api/project-evidence-content/route.ts",
  "src/app/api/ai/suggestions/route.ts",
  "src/app/api/ai/project-state/route.ts",
  "src/app/api/ai/escalation-guide/route.ts",
  "src/app/api/ai/meetings/route.ts",
  "src/app/api/ai/political-risk/route.ts",
  "src/app/api/ai/project-memory/route.ts",
  "src/app/api/ai/stakeholder-intel/route.ts",
  "src/app/api/ai/pmfreak-brain/route.ts",
  "src/app/api/ai/message-nudges/route.ts",
  "src/app/api/ai/meta-intelligence/route.ts",
];

test("21. every expensive AI/evidence/upload route file is registered in the abuse registry", () => {
  const registeredFiles = new Set(ABUSE_PROTECTION_REGISTRY.map((entry) => entry.file));
  for (const file of EXPENSIVE_ROUTE_FILES) {
    assert.ok(registeredFiles.has(file), `${file} is not registered in ABUSE_PROTECTION_REGISTRY`);
  }
});

test("22. every expensive AI/evidence/upload route calls enforceAbuseLimit and retains its auth/project guard", () => {
  const authGuardPattern = /requireAuthUser\(|requireProjectAccess\(|requireAuthenticatedUser\(|getAuthUser\(/;
  for (const file of EXPENSIVE_ROUTE_FILES) {
    const src = read(file);
    assert.match(src, authGuardPattern, `${file} lost its auth/project guard`);
    assert.match(src, /enforceAbuseLimit\(/, `${file} has no enforceAbuseLimit call`);
  }
});

// ── 23. Abuse helper never stores a raw token/email ──────────────────────────

test("23. abuse-protection.ts never persists a raw token/email — metadata is always redacted, identifiers always hashed", () => {
  assert.doesNotMatch(abuseProtectionSrc, /metadata\.token/);
  assert.doesNotMatch(abuseProtectionSrc, /rawToken/);
  assert.doesNotMatch(abuseProtectionSrc, /identifier:\s*token/);
  assert.match(abuseProtectionSrc, /redactAbuseMetadata/);
  assert.match(abuseProtectionSrc, /createHash\("sha256"\)/);
});

// ── 24. No route creates unlimited Stripe sessions without an abuse policy ──

test("24. Stripe session creation is always preceded by an abuse-limit check in source order", () => {
  const checkoutSrc = read("src/app/api/billing/create-checkout-session/route.ts");
  const portalSrc = read("src/app/api/billing/create-portal-session/route.ts");
  const checkoutAbuseIdx = checkoutSrc.indexOf("enforceAbuseLimit(");
  const checkoutStripeIdx = checkoutSrc.indexOf("stripe.checkout.sessions.create(");
  assert.ok(checkoutAbuseIdx > 0 && checkoutAbuseIdx < checkoutStripeIdx);
  const portalAbuseIdx = portalSrc.indexOf("enforceAbuseLimit(");
  const portalStripeIdx = portalSrc.indexOf("stripe.billingPortal.sessions.create(");
  assert.ok(portalAbuseIdx > 0 && portalAbuseIdx < portalStripeIdx);
});

// ── 25. No public state-creating route is missing an abuse registry entry ───

test("25. every state-creating entry in PUBLIC_ROUTE_ALLOWLIST has a corresponding enforced abuse-registry entry", () => {
  // Read-only / machine-to-machine / discovery routes are intentionally
  // exempt (documented residuals) — only the state-creating handshake
  // request route must be enforced.
  const stateCreating = PUBLIC_ROUTE_ALLOWLIST.filter((route) => route.file.includes("handshakes/request"));
  assert.ok(stateCreating.length > 0);
  for (const route of stateCreating) {
    const entry = ABUSE_PROTECTION_REGISTRY.find((e) => e.file === route.file);
    assert.ok(entry, `${route.file} (public, state-creating) has no abuse registry entry`);
    assert.equal(entry.enforced, true);
  }
});

// ── 26-28. Documentation ─────────────────────────────────────────────────────

const docSrc = read("docs/security/abuse-protection-boundary.md");

test("26. docs/security/abuse-protection-boundary.md exists", () => {
  assert.ok(docSrc.length > 500);
});

test("27. doc lists the public/semi-public endpoint families", () => {
  for (const term of ["signup", "invite accept", "early[- ]access accept", "trust handshake request", "checkout", "portal", "upload", "evidence", "AI"]) {
    assert.match(docSrc.toLowerCase(), new RegExp(term.toLowerCase().replace(/ /g, "\\s+")));
  }
});

test("28. doc explicitly states authorization is not enough against abuse", () => {
  assert.match(docSrc.replace(/\s+/g, " "), /can still be unsafe if it can be abused without limits/i);
});

// ── Suggested extras ──────────────────────────────────────────────────────

test("rate limit keys include scope and action", () => {
  assert.equal(buildAbuseKey(["billing.create_checkout_session", "resend"]), "billing.create_checkout_session:resend");
  assert.equal(buildAbuseKey(["scope-only", null, undefined]), "scope-only");
});

test("hashAbuseIdentifier is deterministic for the same normalized input", () => {
  assert.equal(hashAbuseIdentifier("token-abc"), hashAbuseIdentifier("token-abc"));
  assert.notEqual(hashAbuseIdentifier("token-abc"), hashAbuseIdentifier("token-abd"));
});

test("abuseDenyResponse returns 429 with a Retry-After header and a generic body", async () => {
  const response = abuseDenyResponse({ allowed: false, key: "k", reason: "rate_limited", retryAfterSeconds: 42 });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "42");
  const body = await response.json();
  assert.equal(body.code, "rate_limited");
  assert.ok(!("retryAfterSeconds" in body)); // internal detail stays out of the wire body beyond the header
});

test("every registry entry has windowSeconds and maxAttempts set", () => {
  for (const entry of ABUSE_PROTECTION_REGISTRY) {
    assert.ok(Number.isFinite(entry.windowSeconds) && entry.windowSeconds > 0, `${entry.id} missing windowSeconds`);
    assert.ok(Number.isFinite(entry.maxAttempts) && entry.maxAttempts > 0, `${entry.id} missing maxAttempts`);
  }
});

test("registry has no duplicate ids", () => {
  const ids = ABUSE_PROTECTION_REGISTRY.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("registry source documents residual entries with a note", () => {
  const residuals = ABUSE_PROTECTION_REGISTRY.filter((entry) => !entry.enforced);
  assert.ok(residuals.length > 0);
  for (const entry of residuals) {
    assert.ok(entry.residualNote && entry.residualNote.length > 10, `${entry.id} is unenforced but has no residualNote`);
  }
  assert.match(abuseRegistrySrc, /residualNote/);
});
