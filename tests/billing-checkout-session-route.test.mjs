// Perilla 2 — Billing Authorization Must Use Workspace Membership Role.
//
// Behavioral, close-to-real-flow tests for POST /api/billing/create-checkout-session
// and POST /api/billing/create-portal-session. Dependencies (auth, Supabase,
// Stripe) are injected via each route's exported handle* function — the real
// route logic and the real requireBillingManageMembership / canManageBilling
// logic run unmodified, with no dependency on any experimental Node API.

import test from "node:test";
import assert from "node:assert/strict";
import { handleCreateCheckoutSession } from "../src/app/api/billing/create-checkout-session/route.ts";
import { handleCreatePortalSession } from "../src/app/api/billing/create-portal-session/route.ts";
import { requireBillingManageMembership } from "../src/lib/workspace-access.ts";

const state = {
  user: null,
  membershipRow: undefined,
  subscription: { plan: "free", subscriptionStatus: "inactive", stripeCustomerId: "cus_existing", stripeSubscriptionId: null, currentPeriodEnd: null },
  stripeCalls: [],
};

function fakeSupabaseClient() {
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
        maybeSingle: async () => ({ data: state.membershipRow }),
      };
    },
  };
}

// Runs the real requireBillingManageMembership logic against a fake Supabase client.
const requireBillingManageMembershipWithFakeDb = (input) => requireBillingManageMembership(input, async () => fakeSupabaseClient());

function fakeStripe() {
  return {
    customers: {
      create: async (args) => {
        state.stripeCalls.push({ fn: "customers.create", args });
        return { id: "cus_new" };
      },
    },
    checkout: {
      sessions: {
        create: async (args, options) => {
          state.stripeCalls.push({ fn: "checkout.sessions.create", args, options });
          return { id: "sess_1", url: "https://stripe.test/checkout/sess_1" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (args) => {
          state.stripeCalls.push({ fn: "billingPortal.sessions.create", args });
          return { id: "bps_1", url: "https://stripe.test/portal/bps_1" };
        },
      },
    },
  };
}

// This suite tests authorization (Perilla 2), not abuse protection (Perilla
// 9) — a fake that always allows keeps it decoupled from rate-limit state.
// Abuse-limit behavior for these routes is covered by
// tests/abuse-protection-boundary.test.mjs.
const alwaysAllowAbuseLimit = async () => ({ allowed: true, key: "test" });

const checkoutDeps = {
  getAuthUser: async () => state.user,
  requireBillingManageMembership: requireBillingManageMembershipWithFakeDb,
  getCompanySubscription: async () => state.subscription,
  updateCompanySubscription: async (companyId, patch) => {
    state.subscription = { ...state.subscription, ...patch };
    return state.subscription;
  },
  getStripeServerClient: fakeStripe,
  enforceAbuseLimit: alwaysAllowAbuseLimit,
};

const portalDeps = {
  getAuthUser: async () => state.user,
  requireBillingManageMembership: requireBillingManageMembershipWithFakeDb,
  getCompanySubscription: async () => state.subscription,
  getStripeServerClient: fakeStripe,
  enforceAbuseLimit: alwaysAllowAbuseLimit,
};

const createCheckoutSession = (request) => handleCreateCheckoutSession(request, checkoutDeps);
const createPortalSession = (request) => handleCreatePortalSession(request, portalDeps);

const actor = (overrides = {}) => ({
  id: "user-1",
  email: "person@example.com",
  fullName: "Person",
  companyId: "company-1",
  companyName: "Acme",
  role: "viewer",
  onboardingCompleted: true,
  ...overrides,
});

function checkoutRequest({ workspaceId, body = { plan: "pro" }, includeWorkspaceHeader = true } = {}) {
  const headers = new Headers({ origin: "https://app.test", "content-type": "application/json" });
  if (includeWorkspaceHeader && workspaceId !== undefined) headers.set("x-pmf-workspace-id", workspaceId);
  return new Request("https://app.test/api/billing/create-checkout-session", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function portalRequest({ workspaceId, includeWorkspaceHeader = true } = {}) {
  const headers = new Headers({ origin: "https://app.test" });
  if (includeWorkspaceHeader && workspaceId !== undefined) headers.set("x-pmf-workspace-id", workspaceId);
  return new Request("https://app.test/api/billing/create-portal-session", { method: "POST", headers });
}

test.beforeEach(() => {
  state.user = actor();
  state.membershipRow = undefined;
  state.stripeCalls = [];
  state.subscription = { plan: "free", subscriptionStatus: "inactive", stripeCustomerId: "cus_existing", stripeSubscriptionId: null, currentPeriodEnd: null };
  // Authorization is tested with paid checkout released; the default-OFF state is
  // covered by tests/billing-release-control.test.mjs.
  process.env.PMFREAK_BILLING_CHECKOUT_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
  process.env.STRIPE_PRO_PRICE_ID = "price_pro";
  process.env.STRIPE_PMO_PRICE_ID = "price_pmo";
});

// ── 1. user_metadata role does not authorize billing ────────────────────────

test("1. user_metadata.role=admin (display role) does not authorize checkout when workspace membership is missing", async () => {
  state.user = actor({ role: "admin" }); // AuthUserContext.role can't actually be "admin" post-Perilla-1, but assert defense in depth anyway
  state.membershipRow = undefined;

  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

// ── 2. display role does not authorize billing ──────────────────────────────

test("2. AuthUserContext.role=admin does not authorize checkout when workspace membership is viewer", async () => {
  state.user = actor({ role: "admin" });
  state.membershipRow = { role: "viewer" };

  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

// ── 3. client-injected role/actorRole/billingRole/isOwner in body is ignored ─

test("3. role/actorRole/billingRole/isOwner injected in the request body do not authorize checkout", async () => {
  state.user = actor({ role: "viewer" });
  state.membershipRow = { role: "viewer" }; // actual workspace role is viewer — must stay denied

  const response = await createCheckoutSession(
    checkoutRequest({
      workspaceId: "workspace.demo",
      body: { workspaceId: "workspace.demo", plan: "pro", role: "admin", actorRole: "owner", billingRole: "admin", isOwner: true },
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

test("3b. body-supplied role fields cannot escalate an actually-authorized admin beyond what their real role grants", async () => {
  state.user = actor({ role: "viewer" });
  state.membershipRow = { role: "admin" }; // real workspace role is admin — should succeed on its own merits, not because of body fields

  const response = await createCheckoutSession(
    checkoutRequest({
      workspaceId: "workspace.demo",
      body: { plan: "pro", role: "totally-fake-role", actorRole: "not-a-real-role" },
    }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.url);
});

// ── 4. viewer cannot create checkout ─────────────────────────────────────────

test("4. workspace role viewer cannot create checkout", async () => {
  state.membershipRow = { role: "viewer" };
  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

// ── 5. pm cannot create checkout ─────────────────────────────────────────────

test("5. workspace role pm cannot create checkout", async () => {
  state.membershipRow = { role: "pm" };
  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

// ── 6. admin can create checkout ─────────────────────────────────────────────

test("6. workspace role admin can create checkout", async () => {
  state.membershipRow = { role: "admin" };
  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.url, "https://stripe.test/checkout/sess_1");
  assert.equal(state.stripeCalls.at(-1).fn, "checkout.sessions.create");
});

// ── 7. owner can create checkout ─────────────────────────────────────────────

test("7. workspace role owner can create checkout", async () => {
  state.membershipRow = { role: "owner" };
  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.url, "https://stripe.test/checkout/sess_1");
});

// ── 8. missing workspaceId fails closed ──────────────────────────────────────

test("8. missing workspaceId fails closed with no Stripe session created", async () => {
  const response = await createCheckoutSession(checkoutRequest({ includeWorkspaceHeader: false }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

test("8b. empty-string workspaceId fails closed with no Stripe session created", async () => {
  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "" }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

// ── 9. Stripe is never called when authorization fails ──────────────────────

test("9. Stripe is never invoked for any denied scenario (no membership, viewer, pm, metadata admin, body actorRole admin)", async () => {
  const denialScenarios = [
    { user: actor({ role: "viewer" }), membershipRow: undefined },
    { user: actor({ role: "viewer" }), membershipRow: { role: "viewer" } },
    { user: actor({ role: "pm" }), membershipRow: { role: "pm" } },
    { user: actor({ role: "admin" }), membershipRow: undefined },
    { user: actor({ role: "viewer" }), membershipRow: { role: "viewer" }, body: { plan: "pro", actorRole: "admin" } },
  ];

  for (const scenario of denialScenarios) {
    state.user = scenario.user;
    state.membershipRow = scenario.membershipRow;
    state.stripeCalls = [];
    const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo", body: scenario.body }));
    assert.equal(response.status, 403);
    assert.equal(state.stripeCalls.length, 0);
  }
});

// ── 10. no regression: authorized owner/admin flow still creates a session ──

test("10. no regression — authenticated workspace owner with a valid plan gets a real Stripe checkout session", async () => {
  state.membershipRow = { role: "owner" };
  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo", body: { plan: "pmo" } }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.url, "https://stripe.test/checkout/sess_1");
  const call = state.stripeCalls.find((c) => c.fn === "checkout.sessions.create");
  assert.ok(call);
  assert.equal(call.args.line_items[0].price, "price_pmo");
});

// ── unauthenticated request is rejected before any membership lookup ────────

test("unauthenticated request is rejected with 401 and never reaches Stripe", async () => {
  state.user = null;
  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 401);
  assert.equal(state.stripeCalls.length, 0);
});

// ── Stripe metadata does not carry client-provided role fields ──────────────

test("Stripe checkout/session metadata excludes any client-provided role fields", async () => {
  state.membershipRow = { role: "owner" };
  await createCheckoutSession(
    checkoutRequest({ workspaceId: "workspace.demo", body: { plan: "pro", role: "admin", actorRole: "owner", isAdmin: true } }),
  );
  const call = state.stripeCalls.find((c) => c.fn === "checkout.sessions.create");
  assert.ok(call);
  const metadataKeys = Object.keys(call.args.metadata);
  for (const forbidden of ["role", "actorRole", "billingRole", "isAdmin", "isOwner", "isFounder"]) {
    assert.ok(!metadataKeys.includes(forbidden), `metadata must not include ${forbidden}`);
  }
  assert.deepEqual(metadataKeys.sort(), ["companyId", "plan"]);
});

// ── missing/invalid plan fails before Stripe is touched ──────────────────────

test("unsupported plan fails before any Stripe call", async () => {
  state.membershipRow = { role: "owner" };
  const response = await createCheckoutSession(checkoutRequest({ workspaceId: "workspace.demo", body: { plan: "enterprise-forever" } }));
  assert.equal(response.status, 400);
  assert.equal(state.stripeCalls.length, 0);
});

// ── create-portal-session mirrors the same authorization boundary ───────────

test("create-portal-session: viewer is denied and Stripe billing portal is never called", async () => {
  state.membershipRow = { role: "viewer" };
  const response = await createPortalSession(portalRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

test("create-portal-session: display role admin without membership is denied", async () => {
  state.user = actor({ role: "admin" });
  state.membershipRow = undefined;
  const response = await createPortalSession(portalRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

test("create-portal-session: missing workspaceId fails closed", async () => {
  const response = await createPortalSession(portalRequest({ includeWorkspaceHeader: false }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});

test("create-portal-session: workspace admin can open the billing portal", async () => {
  state.membershipRow = { role: "admin" };
  const response = await createPortalSession(portalRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.url, "https://stripe.test/portal/bps_1");
});

test("create-portal-session: workspace owner can open the billing portal", async () => {
  state.membershipRow = { role: "owner" };
  const response = await createPortalSession(portalRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 200);
});

test("create-portal-session: pm cannot open the billing portal", async () => {
  state.membershipRow = { role: "pm" };
  const response = await createPortalSession(portalRequest({ workspaceId: "workspace.demo" }));
  assert.equal(response.status, 403);
  assert.equal(state.stripeCalls.length, 0);
});
