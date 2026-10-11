// Perilla 5 — Admin / Founder / Early Access / Trial License Endpoint Hardening.
//
// Behavioral tests for the founder/internal trust boundary: who may reach
// founder-only surfaces (founder-actions, early-access invites, the internal
// summary/dashboard, trial license mutations) and what client-controlled
// input is never allowed to influence that decision.
//
// - evaluateFounderOrInternalAccess / isFounderOrInternalUser (src/lib/auth.ts)
//   are pure — exercised directly, same pattern as
//   tests/billing-authorization-workspace-membership.test.mjs.
// - requireNonEmptyId / isValidTrialExtensionDays / sanitizeAuditReason /
//   isValidInviteEmail (src/lib/early-access.ts) are pure validation helpers
//   extracted from the mutation functions so they're directly testable
//   without a live database.
// - The mutation functions themselves (approveEarlyAccessInvite, createEarlyAccessInvite,
//   etc.) call createSupabaseServiceRoleClient directly with no DI seam, same
//   constraint noted in tests/early-access-invite-email-boundary.test.mjs — so
//   the route/page wiring around them (auth → founder gate → parse → mutate
//   ordering, and that body.role/actorRole/isFounder/isAdmin are never read)
//   is covered here with source-level regression checks, consistent with that
//   file's precedent.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  evaluateFounderOrInternalAccess,
  isFounderOrInternalUser,
} from "../src/lib/auth.ts";
import {
  MAX_TRIAL_EXTENSION_DAYS,
  requireNonEmptyId,
  isValidTrialExtensionDays,
  sanitizeAuditReason,
  isValidInviteEmail,
} from "../src/lib/early-access.ts";

const readSource = (relativePath) => fs.readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// evaluateFounderOrInternalAccess / isFounderOrInternalUser (pure)
// ─────────────────────────────────────────────────────────────────────────────

test("evaluateFounderOrInternalAccess: missing/null/empty/whitespace email fails closed (test #6)", () => {
  for (const email of [undefined, null, "", "   "]) {
    const result = evaluateFounderOrInternalAccess({ email });
    assert.equal(result.allowed, false);
    assert.equal(result.decision, "deny_missing_email");
  }
});

test("evaluateFounderOrInternalAccess: malformed email shape fails closed", () => {
  for (const email of ["not-an-email", "user@localhost", "@pmfreak.ai", "justtext"]) {
    const result = evaluateFounderOrInternalAccess({ email });
    assert.equal(result.allowed, false);
    assert.equal(result.decision, "deny_invalid_email");
  }
});

test("evaluateFounderOrInternalAccess: internal domain exact match allows (test #4)", () => {
  const result = evaluateFounderOrInternalAccess({ email: "user@pmfreak.ai" });
  assert.equal(result.allowed, true);
  assert.equal(result.decision, "allow");
  assert.equal(result.source, "internal_domain");
  assert.equal(result.normalizedEmail, "user@pmfreak.ai");
});

test("evaluateFounderOrInternalAccess: internal domain match is case-insensitive", () => {
  assert.equal(evaluateFounderOrInternalAccess({ email: "User@PMFreak.AI" }).allowed, true);
  assert.equal(evaluateFounderOrInternalAccess({ email: "victor@OnChainFest.xyz" }).allowed, true);
});

test("evaluateFounderOrInternalAccess: domain-suffix spoof is rejected — attacker@pmfreak.ai.evil.com does not match (test #4)", () => {
  const result = evaluateFounderOrInternalAccess({ email: "attacker@pmfreak.ai.evil.com" });
  assert.equal(result.allowed, false);
  assert.equal(result.decision, "deny_not_founder_or_internal");
});

test("evaluateFounderOrInternalAccess: prefix-spoof subdomain is rejected — attacker@evilpmfreak.ai does not match", () => {
  const result = evaluateFounderOrInternalAccess({ email: "attacker@evilpmfreak.ai" });
  assert.equal(result.allowed, false);
  assert.equal(result.decision, "deny_not_founder_or_internal");
});

test("evaluateFounderOrInternalAccess: allowlist exact match allows, suffix spoof denied (test #5)", () => {
  const original = process.env.FOUNDER_EMAIL_ALLOWLIST;
  process.env.FOUNDER_EMAIL_ALLOWLIST = "victor@example.com, other@example.com";
  try {
    const allowed = evaluateFounderOrInternalAccess({ email: "victor@example.com" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.source, "allowlist");

    const spoofed = evaluateFounderOrInternalAccess({ email: "victor@example.com.evil.com" });
    assert.equal(spoofed.allowed, false);
    assert.equal(spoofed.decision, "deny_not_founder_or_internal");

    // case-insensitive match against the parsed allowlist
    assert.equal(evaluateFounderOrInternalAccess({ email: "VICTOR@EXAMPLE.COM" }).allowed, true);
  } finally {
    if (original === undefined) delete process.env.FOUNDER_EMAIL_ALLOWLIST;
    else process.env.FOUNDER_EMAIL_ALLOWLIST = original;
  }
});

test("evaluateFounderOrInternalAccess: allowlist parser trims whitespace and ignores empty entries", () => {
  const original = process.env.FOUNDER_EMAIL_ALLOWLIST;
  process.env.FOUNDER_EMAIL_ALLOWLIST = "  spaced@example.com  ,, ,another@example.com";
  try {
    assert.equal(evaluateFounderOrInternalAccess({ email: "spaced@example.com" }).allowed, true);
    assert.equal(evaluateFounderOrInternalAccess({ email: "another@example.com" }).allowed, true);
    assert.equal(evaluateFounderOrInternalAccess({ email: "" }).decision, "deny_missing_email");
  } finally {
    if (original === undefined) delete process.env.FOUNDER_EMAIL_ALLOWLIST;
    else process.env.FOUNDER_EMAIL_ALLOWLIST = original;
  }
});

test("evaluateFounderOrInternalAccess: a normal, non-allowlisted, non-internal email is denied", () => {
  const result = evaluateFounderOrInternalAccess({ email: "normal@example.com" });
  assert.equal(result.allowed, false);
  assert.equal(result.decision, "deny_not_founder_or_internal");
});

test("isFounderOrInternalUser: only reads user.email — user_metadata.role / display role on the object cannot influence the decision (tests #1, #2)", () => {
  // AuthUserContext.role is a display role only; even attaching role: "admin"/"owner"
  // directly on the object (as if metadata/display-role had somehow set it) changes
  // nothing, because isFounderOrInternalUser never reads `.role`.
  const normalUserWithAdminMetadataRole = { email: "normal@example.com", role: "admin" };
  assert.equal(isFounderOrInternalUser(normalUserWithAdminMetadataRole), false);

  const normalUserWithOwnerDisplayRole = { email: "normal@example.com", role: "owner" };
  assert.equal(isFounderOrInternalUser(normalUserWithOwnerDisplayRole), false);

  const founderRegardlessOfRoleField = { email: "user@pmfreak.ai", role: "viewer" };
  assert.equal(isFounderOrInternalUser(founderRegardlessOfRoleField), true);
});

test("evaluateFounderOrInternalAccess: extra caller-supplied fields (actorRole/isFounder/isAdmin) alongside email are ignored — signature only reads .email (test #3, #10)", () => {
  const spoofedInput = {
    email: "normal@example.com",
    actorRole: "owner",
    isFounder: true,
    isAdmin: true,
    role: "admin",
    permissions: ["all"],
  };
  const result = evaluateFounderOrInternalAccess(spoofedInput);
  assert.equal(result.allowed, false, "extra fields must not grant founder access to a non-founder email");
  assert.equal(result.decision, "deny_not_founder_or_internal");
});

// ─────────────────────────────────────────────────────────────────────────────
// requireNonEmptyId (pure) — target id validation for founder-actions
// ─────────────────────────────────────────────────────────────────────────────

test("requireNonEmptyId: rejects missing/empty/whitespace/non-string ids, fails closed", () => {
  for (const value of ["", "   ", undefined, null, 123, {}, ["id"]]) {
    assert.throws(() => requireNonEmptyId(value, "Trial id"), /missing_target::Trial id is required\./);
  }
});

test("requireNonEmptyId: trims and returns a valid id", () => {
  assert.equal(requireNonEmptyId("  trial.demo  ", "Trial id"), "trial.demo");
  assert.equal(requireNonEmptyId("invite-1", "Invite id"), "invite-1");
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidTrialExtensionDays (pure) — duration validation (test #22)
// ─────────────────────────────────────────────────────────────────────────────

test("isValidTrialExtensionDays: accepts whole numbers of days from 1 to MAX_TRIAL_EXTENSION_DAYS", () => {
  assert.equal(MAX_TRIAL_EXTENSION_DAYS, 60);
  assert.equal(isValidTrialExtensionDays(1), true);
  assert.equal(isValidTrialExtensionDays(7), true);
  assert.equal(isValidTrialExtensionDays(60), true);
});

test("isValidTrialExtensionDays: rejects invalid durations — negative, zero, absurdly large, non-integer, NaN, Infinity (test #22)", () => {
  for (const days of [-1, 0, 61, 999999, 1.5, NaN, Infinity, -Infinity, "7", null, undefined]) {
    assert.equal(isValidTrialExtensionDays(days), false, `expected ${days} to be rejected`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeAuditReason (pure)
// ─────────────────────────────────────────────────────────────────────────────

test("sanitizeAuditReason: trims and caps at 500 chars, never required to authorize anything", () => {
  assert.equal(sanitizeAuditReason("  trial extended per support ticket #42  "), "trial extended per support ticket #42");
  assert.equal(sanitizeAuditReason("x".repeat(600)).length, 500);
  assert.equal(sanitizeAuditReason(""), null);
  assert.equal(sanitizeAuditReason("   "), null);
  assert.equal(sanitizeAuditReason(undefined), null);
  assert.equal(sanitizeAuditReason(123), null);
  assert.equal(sanitizeAuditReason({ actorRole: "owner" }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidInviteEmail (pure) — invite creation target validation (tests #14, #15)
// ─────────────────────────────────────────────────────────────────────────────

test("isValidInviteEmail: accepts well-formed emails, rejects garbage/missing", () => {
  assert.equal(isValidInviteEmail("target@example.com"), true);
  for (const value of ["", "   ", "not-an-email", undefined, null, 123, {}]) {
    assert.equal(isValidInviteEmail(value), false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// founder-actions route — source-level ordering + no client-claim trust (tests #3, #7, #9, #10, #23, #24, #25)
// ─────────────────────────────────────────────────────────────────────────────

test("founder-actions route: requireAuthUser + isFounderOrInternalUser run before the body is parsed or any mutation is called (tests #7, #23, #24)", async () => {
  const source = await readSource("src/app/api/early-access/founder-actions/route.ts");
  const authIndex = source.indexOf("requireAuthUser()");
  const founderGateIndex = source.indexOf("isFounderOrInternalUser(user)");
  const bodyParseIndex = source.indexOf("request.json()");
  const firstMutationIndex = Math.min(
    ...["approveEarlyAccessInvite(", "revokeEarlyAccessInvite(", "resendEarlyAccessInviteEmail(", "revokeTrialLicense(", "extendTrialLicense("].map(
      (needle) => {
        const idx = source.indexOf(needle);
        return idx === -1 ? Infinity : idx;
      },
    ),
  );

  assert.ok(authIndex > -1, "requireAuthUser() call not found");
  assert.ok(founderGateIndex > authIndex, "founder gate must run after auth");
  assert.ok(bodyParseIndex > founderGateIndex, "body must not be parsed before the founder gate");
  assert.ok(firstMutationIndex > founderGateIndex, "no mutation function may be referenced before the founder gate");
});

test("founder-actions route: never reads body.role/actorRole/isFounder/isAdmin/isOwner/permissions (tests #3, #10)", async () => {
  const source = await readSource("src/app/api/early-access/founder-actions/route.ts");
  for (const field of ["body.role", "body.actorRole", "body.isFounder", "body.isAdmin", "body.isOwner", "body.permissions", "body.claims"]) {
    assert.doesNotMatch(source, new RegExp(field.replace(".", "\\.")), `route must never read ${field}`);
  }
});

test("founder-actions route: an unrecognized action falls through to a 400 with no mutation function called on that path (test #9)", async () => {
  const source = await readSource("src/app/api/early-access/founder-actions/route.ts");
  const unsupportedIndex = source.lastIndexOf('"Unsupported action."');
  assert.ok(unsupportedIndex > -1, "Unsupported action fallback not found");
  // The fallback must be the terminal branch of the if-chain, not reachable after a mutation call.
  const tailAfterFallback = source.slice(unsupportedIndex);
  for (const mutation of ["approveEarlyAccessInvite(", "revokeEarlyAccessInvite(", "resendEarlyAccessInviteEmail(", "revokeTrialLicense(", "extendTrialLicense("]) {
    assert.doesNotMatch(tailAfterFallback, new RegExp(mutation.replace(/[()]/g, "\\$&")), `${mutation} must not run after the unsupported-action fallback`);
  }
});

test("founder-actions route: malformed JSON body is rejected with 400, not an unhandled exception", async () => {
  const source = await readSource("src/app/api/early-access/founder-actions/route.ts");
  assert.match(source, /try\s*\{[\s\S]*?request\.json\(\)[\s\S]*?\}\s*catch/, "body parsing must be wrapped in try/catch");
});

// ─────────────────────────────────────────────────────────────────────────────
// early-access invites route — founder gate + no body-claim trust (tests #11, #12, #14, #15)
// ─────────────────────────────────────────────────────────────────────────────

test("invites route: requireAuthUser + isFounderOrInternalUser run before request.json()/createEarlyAccessInvite (tests #11, #12)", async () => {
  const source = await readSource("src/app/api/early-access/invites/route.ts");
  const authIndex = source.indexOf("requireAuthUser()");
  const founderGateIndex = source.indexOf("isFounderOrInternalUser(user)");
  const bodyParseIndex = source.indexOf("request.json()");
  const createInviteIndex = source.indexOf("createEarlyAccessInvite(");

  assert.ok(founderGateIndex > authIndex, "founder gate must run after auth");
  assert.ok(bodyParseIndex > founderGateIndex, "body must not be parsed before the founder gate");
  assert.ok(createInviteIndex > founderGateIndex, "invite creation must not run before the founder gate");
});

test("invites route: only inviteEmail/inviteNote/requiresApproval are read from the body — no role/isFounder/permissions grant (test #15)", async () => {
  const source = await readSource("src/app/api/early-access/invites/route.ts");
  const callSiteMatch = source.match(/createEarlyAccessInvite\(\{([\s\S]*?)\}\)/);
  assert.ok(callSiteMatch, "createEarlyAccessInvite call site not found");
  const fields = callSiteMatch[1];
  assert.match(fields, /inviteEmail:/);
  assert.match(fields, /inviterUserId:\s*user\.id/, "inviterUserId must come from the authenticated user, never the body");
  assert.doesNotMatch(fields, /body\.role|body\.isFounder|body\.isAdmin|body\.permissions/, "no elevated-identity field may be read from the body");
});

// ─────────────────────────────────────────────────────────────────────────────
// early-access summary route — founder gate precedes service-role instantiation (tests #16, #17)
// ─────────────────────────────────────────────────────────────────────────────

test("summary route: founder gate runs before the service-role client is instantiated or any query executes (tests #16, #17)", async () => {
  const source = await readSource("src/app/api/early-access/summary/route.ts");
  const founderGateIndex = source.indexOf("isFounderOrInternalUser(user)");
  const serviceRoleIndex = source.indexOf("createSupabaseServiceRoleClient(");
  assert.ok(founderGateIndex > -1 && serviceRoleIndex > founderGateIndex, "service-role client must not be created before the founder gate");
});

test("summary route: no longer calls a generic execute_sql RPC with an inline query string", async () => {
  const source = await readSource("src/app/api/early-access/summary/route.ts");
  assert.doesNotMatch(source, /execute_sql/, "raw-SQL-shaped RPC must not be used; use the scoped query builder instead");
  assert.match(source, /\.update\(\{\s*trial_status:\s*"expired"\s*\}\)/, "trial expiry sweep must use a parameterized update");
});

// ─────────────────────────────────────────────────────────────────────────────
// early-access founder dashboard page — the core Perilla 5 fix (dashboard summary case)
// ─────────────────────────────────────────────────────────────────────────────

test("early-access dashboard page: isFounderOrInternalUser gate runs before the service-role client is instantiated — CRITICAL regression check (previously any authenticated user could view this page)", async () => {
  const source = await readSource("src/app/(protected)/early-access/page.tsx");
  const authIndex = source.indexOf("requireAuthUser()");
  const founderGateIndex = source.indexOf("isFounderOrInternalUser(user)");
  const notFoundIndex = source.indexOf("notFound()");
  const serviceRoleIndex = source.indexOf("createSupabaseServiceRoleClient(");

  assert.ok(authIndex > -1, "requireAuthUser() call not found");
  assert.ok(founderGateIndex > authIndex, "founder gate must run after auth");
  assert.ok(notFoundIndex > founderGateIndex, "non-founder users must be turned away with notFound()");
  assert.ok(serviceRoleIndex > founderGateIndex, "service-role client must not be instantiated before the founder gate");
});

// ─────────────────────────────────────────────────────────────────────────────
// early-access accept route — separation from founder actions (tests #26, #27, #28)
// ─────────────────────────────────────────────────────────────────────────────

test("accept route: never reads body.isFounder/body.role — accepting an invite cannot grant founder/internal access (test #28)", async () => {
  const source = await readSource("src/app/api/early-access/accept/route.ts");
  assert.doesNotMatch(source, /body\.isFounder|body\.role|body\.isAdmin/, "accept route must not read identity/authority claims from the body");
  assert.doesNotMatch(source, /isFounderOrInternalUser/, "accepting an invite must not consult the founder gate at all — it is a separate permission");
});

test("accept route: userEmail passed to acceptEarlyAccessInvite always comes from the authenticated session, never the body (tests #26, #27)", async () => {
  const source = await readSource("src/app/api/early-access/accept/route.ts");
  assert.match(source, /userEmail:\s*user\.email/);
  assert.doesNotMatch(source, /userEmail:\s*body\./);
});

test("accept route: malformed JSON body is rejected with 400, not an unhandled exception", async () => {
  const source = await readSource("src/app/api/early-access/accept/route.ts");
  assert.match(source, /try\s*\{[\s\S]*?request\.json\(\)[\s\S]*?\}\s*catch/, "body parsing must be wrapped in try/catch");
});

test("acceptEarlyAccessInvite: email-mismatch guard exists before any workspace/membership mutation (test #27 — regression carried from Perilla 3)", async () => {
  const source = await readSource("src/lib/early-access.ts");
  const bodyStart = source.indexOf("export async function acceptEarlyAccessInvite");
  const emailCheckIndex = source.indexOf("email_mismatch::", bodyStart);
  // The workspace is created only inside the atomic accept_early_access_invite
  // RPC (migration 20261011000000), never by a separate application write.
  const activationRpcIndex = source.indexOf('rpc("accept_early_access_invite"', bodyStart);
  assert.ok(emailCheckIndex > bodyStart, "email_mismatch check not found");
  assert.ok(activationRpcIndex > emailCheckIndex, "email match must be validated before the activation RPC creates the workspace");
});

// ─────────────────────────────────────────────────────────────────────────────
// trial/license mutation wiring — target id + duration validated before mutation (tests #18-22)
// ─────────────────────────────────────────────────────────────────────────────

test("extendTrialLicense / revokeTrialLicense / revokeEarlyAccessInvite / approveEarlyAccessInvite / resendEarlyAccessInviteEmail all validate the target id via requireNonEmptyId before creating a service-role client", async () => {
  const source = await readSource("src/lib/early-access.ts");
  for (const fn of ["extendTrialLicense", "revokeTrialLicense", "revokeEarlyAccessInvite", "approveEarlyAccessInvite", "resendEarlyAccessInviteEmail"]) {
    const start = source.indexOf(`export async function ${fn}(`);
    assert.ok(start > -1, `${fn} not found`);
    const nextFnIndex = source.indexOf("export async function", start + 1);
    const body = source.slice(start, nextFnIndex === -1 ? undefined : nextFnIndex);
    const requireIdIndex = body.indexOf("requireNonEmptyId(");
    const serviceRoleIndex = body.indexOf("createSupabaseServiceRoleClient(");
    assert.ok(requireIdIndex > -1, `${fn} must validate its target id with requireNonEmptyId`);
    assert.ok(serviceRoleIndex > requireIdIndex, `${fn} must validate the target id before instantiating the service-role client`);
  }
});

test("extendTrialLicense validates duration via isValidTrialExtensionDays before creating a service-role client (test #22)", async () => {
  const source = await readSource("src/lib/early-access.ts");
  const start = source.indexOf("export async function extendTrialLicense(");
  const nextFnIndex = source.indexOf("export async function", start + 1);
  const body = source.slice(start, nextFnIndex);
  const durationCheckIndex = body.indexOf("isValidTrialExtensionDays(");
  const serviceRoleIndex = body.indexOf("createSupabaseServiceRoleClient(");
  assert.ok(durationCheckIndex > -1 && serviceRoleIndex > durationCheckIndex, "duration must be validated before the service-role client is created");
});

// ─────────────────────────────────────────────────────────────────────────────
// resolve-onboarding-state — trial-expiry bypass gate + raw-SQL removal
// ─────────────────────────────────────────────────────────────────────────────

test("resolveOnboardingState: isFounderOrInternalUser gates the trial-expiry check, and no longer uses a raw execute_sql RPC", async () => {
  const source = await readSource("src/lib/auth/resolve-onboarding-state.ts");
  assert.match(source, /isFounderOrInternalUser\(user\)/);
  assert.doesNotMatch(source, /execute_sql/, "raw-SQL-shaped RPC must not be used; use the scoped query builder instead");
  assert.match(source, /\.update\(\{\s*trial_status:\s*"expired"\s*\}\)/, "trial expiry must use a parameterized update");
});

// ─────────────────────────────────────────────────────────────────────────────
// privileged-access registry stays in sync
// ─────────────────────────────────────────────────────────────────────────────

test("privileged-access registry documents src/lib/auth/resolve-onboarding-state.ts", async () => {
  const source = await readSource("src/lib/security/privileged-access-registry.ts");
  assert.match(source, /"src\/lib\/auth\/resolve-onboarding-state\.ts"/);
});
