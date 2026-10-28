// Perilla 5 — Admin / Founder / Early Access / Trial License Endpoint Hardening.
//
// Behavioral tests for the founder/internal trust boundary: who may reach
// founder-only surfaces (founder-actions, early-access invites, the internal
// summary/dashboard, trial license mutations) and what client-controlled
// input is never allowed to influence that decision.
//
// - evaluateFounderOrInternalAccess / isFounderOrInternalUser (src/lib/auth.ts)
//   are pure over a server-verified AuthUserContext and the server-only
//   FOUNDER_OPERATOR_USER_IDS env var (F6 / PR-4) — exercised directly, same
//   pattern as tests/billing-authorization-workspace-membership.test.mjs.
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
  buildAuthUserContext,
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

const OPERATOR_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const CONFIRMED_AT = "2026-10-01T12:00:00.000Z";

// A context exactly as getAuthUser() builds it from a GoTrue user.
const verifiedUser = (overrides = {}) =>
  buildAuthUserContext(
    { id: OPERATOR_ID, email: "operator@example.com", email_confirmed_at: CONFIRMED_AT, user_metadata: {}, ...overrides },
    { verifiedByAuthServer: true },
  );

const withEnv = (vars, fn) => {
  const previous = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};
const withOperators = (value, fn) => withEnv({ FOUNDER_OPERATOR_USER_IDS: value, FOUNDER_EMAIL_ALLOWLIST: undefined }, fn);

test("evaluateFounderOrInternalAccess: a verified, email-confirmed user listed in FOUNDER_OPERATOR_USER_IDS is allowed", () => {
  withOperators(`${OTHER_ID},${OPERATOR_ID}`, () => {
    assert.deepEqual(evaluateFounderOrInternalAccess(verifiedUser()), { allowed: true, decision: "allow" });
    assert.equal(isFounderOrInternalUser(verifiedUser()), true);
  });
});

test("evaluateFounderOrInternalAccess: id matching is exact, case-insensitive and whitespace-tolerant", () => {
  withOperators(`  ${OPERATOR_ID.toUpperCase()} , `, () => {
    assert.equal(isFounderOrInternalUser(verifiedUser()), true);
    assert.equal(evaluateFounderOrInternalAccess(verifiedUser({ id: OTHER_ID })).decision, "deny_not_operator");
  });
});

test("evaluateFounderOrInternalAccess: unlisted @pmfreak.ai / @onchainfest.xyz users are denied — email domains grant nothing (F6)", () => {
  withOperators(OPERATOR_ID, () => {
    for (const email of ["user@pmfreak.ai", "User@PMFreak.AI", "victor@onchainfest.xyz", "ops@OnChainFest.xyz"]) {
      const result = evaluateFounderOrInternalAccess(verifiedUser({ id: OTHER_ID, email }));
      assert.deepEqual(result, { allowed: false, decision: "deny_not_operator" }, email);
    }
  });
});

test("evaluateFounderOrInternalAccess: FOUNDER_EMAIL_ALLOWLIST is no longer read — naming an email grants nothing (F6)", () => {
  withEnv({ FOUNDER_OPERATOR_USER_IDS: OPERATOR_ID, FOUNDER_EMAIL_ALLOWLIST: "trusted@example.com" }, () => {
    assert.equal(evaluateFounderOrInternalAccess(verifiedUser({ id: OTHER_ID, email: "trusted@example.com" })).decision, "deny_not_operator");
  });
  withEnv({ FOUNDER_OPERATOR_USER_IDS: undefined, FOUNDER_EMAIL_ALLOWLIST: "operator@example.com" }, () => {
    assert.equal(evaluateFounderOrInternalAccess(verifiedUser()).decision, "deny_operators_not_configured");
  });
});

test("evaluateFounderOrInternalAccess: a listed user without a confirmed email is denied (F6)", () => {
  withOperators(OPERATOR_ID, () => {
    for (const email_confirmed_at of [null, undefined, "", "not-a-date"]) {
      const result = evaluateFounderOrInternalAccess(verifiedUser({ email_confirmed_at }));
      assert.deepEqual(result, { allowed: false, decision: "deny_email_unconfirmed" }, String(email_confirmed_at));
    }
  });
});

test("evaluateFounderOrInternalAccess: missing or empty operator configuration fails closed", () => {
  for (const value of [undefined, "", "   ", ",", " , ,"]) {
    withOperators(value, () => {
      assert.deepEqual(evaluateFounderOrInternalAccess(verifiedUser()), { allowed: false, decision: "deny_operators_not_configured" }, String(value));
    });
  }
});

test("evaluateFounderOrInternalAccess: any malformed entry (email, partial id) invalidates the whole operator configuration", () => {
  for (const value of [`${OPERATOR_ID},operator@example.com`, `${OPERATOR_ID},6f1c2a3b`, "operator@example.com", `${OPERATOR_ID};${OTHER_ID}`]) {
    withOperators(value, () => {
      assert.deepEqual(evaluateFounderOrInternalAccess(verifiedUser()), { allowed: false, decision: "deny_operators_misconfigured" }, value);
    });
  }
});

test("evaluateFounderOrInternalAccess: fabricated user objects are never operators, whatever fields they carry", () => {
  withOperators(OPERATOR_ID, () => {
    const fabricated = [
      undefined,
      null,
      OPERATOR_ID,
      { email: "user@pmfreak.ai" },
      { id: OPERATOR_ID, email: "operator@example.com", email_confirmed_at: CONFIRMED_AT },
      { id: OPERATOR_ID, email: "operator@example.com", fullName: "x", companyId: OPERATOR_ID, companyName: "x", role: "viewer", onboardingCompleted: true },
      { ...verifiedUser() },
      Object.assign(Object.create(null), verifiedUser()),
      JSON.parse(JSON.stringify(verifiedUser())),
    ];
    for (const candidate of fabricated) {
      assert.deepEqual(evaluateFounderOrInternalAccess(candidate), { allowed: false, decision: "deny_unverified_identity" });
    }
  });
});

test("evaluateFounderOrInternalAccess: a context built from an unverified (getSession cookie) user is never an operator", () => {
  withOperators(OPERATOR_ID, () => {
    const fromSession = buildAuthUserContext({ id: OPERATOR_ID, email: "operator@example.com", email_confirmed_at: CONFIRMED_AT });
    assert.equal(evaluateFounderOrInternalAccess(fromSession).decision, "deny_unverified_identity");
    const explicitFalse = buildAuthUserContext({ id: OPERATOR_ID, email: "operator@example.com", email_confirmed_at: CONFIRMED_AT }, { verifiedByAuthServer: false });
    assert.equal(evaluateFounderOrInternalAccess(explicitFalse).decision, "deny_unverified_identity");
  });
});

test("evaluateFounderOrInternalAccess: reassigning id / email on a verified context does not change the decision", () => {
  withOperators(OPERATOR_ID, () => {
    const ordinary = verifiedUser({ id: OTHER_ID, email: "normal@example.com" });
    ordinary.id = OPERATOR_ID;
    ordinary.companyId = OPERATOR_ID;
    ordinary.email = "user@pmfreak.ai";
    assert.equal(evaluateFounderOrInternalAccess(ordinary).decision, "deny_not_operator");

    const operator = verifiedUser();
    operator.id = OTHER_ID;
    assert.equal(isFounderOrInternalUser(operator), true, "the decision follows the verified id, not the mutable field");
  });
});

test("isFounderOrInternalUser: display role and caller-supplied fields cannot influence the decision (tests #1, #2, #3, #10)", () => {
  withOperators(OPERATOR_ID, () => {
    const ordinary = verifiedUser({ id: OTHER_ID, email: "normal@example.com", user_metadata: { role: "admin" } });
    for (const [field, value] of [["role", "admin"], ["role", "owner"], ["actorRole", "owner"], ["isFounder", true], ["isAdmin", true], ["permissions", ["all"]]]) {
      ordinary[field] = value;
      assert.equal(isFounderOrInternalUser(ordinary), false, `${field} must not grant founder access`);
    }
    const operator = verifiedUser();
    operator.role = "viewer";
    assert.equal(isFounderOrInternalUser(operator), true, "an operator with a viewer display role is still an operator");
  });
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
