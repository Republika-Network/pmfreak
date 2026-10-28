import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAuthUserContext, isFounderOrInternalUser, toDisplayRole, DEFAULT_SIGNUP_ROLE } from "../src/lib/auth.ts";
import { buildSignupProfile } from "../src/app/signup/build-signup-profile.ts";
import { canManageWorkspace, canInviteMembers, canManageBilling } from "../src/lib/workspace-access.ts";

const signupPageSrc = readFileSync("src/app/signup/page.tsx", "utf8");
const signupActionsSrc = readFileSync("src/app/signup/actions.ts", "utf8");

const formData = (fields) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
};

const baseFields = { email: "person@example.com", password: "hunter22", fullName: "Person", companyName: "Acme" };

// ── Signup UI no longer offers a role selector ──────────────────────────────

test("signup page has no role selector", () => {
  assert.doesNotMatch(signupPageSrc, /name="role"/);
  assert.doesNotMatch(signupPageSrc, /<select/);
});

test("signup action source never reads a client-supplied role field", () => {
  assert.doesNotMatch(signupActionsSrc, /formData\.get\("role"\)/);
});

// ── buildSignupProfile: client role input is always ignored ────────────────

test("signup with role=admin in FormData is ignored — user gets the default minimum role", () => {
  const profile = buildSignupProfile(formData({ ...baseFields, role: "admin" }));
  assert.equal(profile.role, DEFAULT_SIGNUP_ROLE);
  assert.notEqual(profile.role, "admin");
});

test("signup with role=owner in FormData is ignored", () => {
  const profile = buildSignupProfile(formData({ ...baseFields, role: "owner" }));
  assert.equal(profile.role, DEFAULT_SIGNUP_ROLE);
  assert.notEqual(profile.role, "owner");
});

test("signup with role=pm in FormData is ignored — pm carries elevated permissions and must not be self-assignable", () => {
  const profile = buildSignupProfile(formData({ ...baseFields, role: "pm" }));
  assert.equal(profile.role, DEFAULT_SIGNUP_ROLE);
});

test("signup normally (no role field at all) still yields correct profile fields — no regression", () => {
  const profile = buildSignupProfile(formData(baseFields));
  assert.equal(profile.email, baseFields.email);
  assert.equal(profile.fullName, baseFields.fullName);
  assert.equal(profile.companyName, baseFields.companyName);
  assert.equal(profile.role, "viewer");
});

// ── toDisplayRole: historical/tampered metadata is degraded, never trusted ──

test("toDisplayRole degrades metadata role=admin to the minimum-privilege role", () => {
  assert.equal(toDisplayRole("admin"), "viewer");
});

test("toDisplayRole degrades metadata role=owner to the minimum-privilege role", () => {
  assert.equal(toDisplayRole("owner"), "viewer");
});

test("toDisplayRole still allows non-privileged display values through", () => {
  assert.equal(toDisplayRole("pm"), "pm");
  assert.equal(toDisplayRole("viewer"), "viewer");
});

test("toDisplayRole defaults unknown/garbage/missing metadata to viewer", () => {
  assert.equal(toDisplayRole(undefined), "viewer");
  assert.equal(toDisplayRole(null), "viewer");
  assert.equal(toDisplayRole(""), "viewer");
  assert.equal(toDisplayRole({ toString: () => "admin" }), "viewer");
});

// ── isFounderOrInternalUser: metadata role can never satisfy the gate ───────

const OPERATOR_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

// A server-verified context (as getAuthUser() builds it), then display-role /
// email fields overridden on the object — none of which the gate reads.
const actor = (overrides = {}) => {
  const { id = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d", ...fields } = overrides;
  const context = buildAuthUserContext(
    { id, email: "attacker@gmail.com", email_confirmed_at: "2026-10-01T12:00:00.000Z", user_metadata: { full_name: "Attacker", company_name: "Attacker Co" } },
    { verifiedByAuthServer: true },
  );
  return Object.assign(context, { role: "viewer", onboardingCompleted: true }, fields);
};

const withOperators = (value, fn) => {
  const previous = process.env.FOUNDER_OPERATOR_USER_IDS;
  process.env.FOUNDER_OPERATOR_USER_IDS = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.FOUNDER_OPERATOR_USER_IDS;
    else process.env.FOUNDER_OPERATOR_USER_IDS = previous;
  }
};

test("user_metadata.role=admin is NOT sufficient to pass the founder/internal gate", () => {
  withOperators(OPERATOR_ID, () => assert.equal(isFounderOrInternalUser(actor({ role: "admin" })), false));
});

test("user_metadata.role=owner is NOT sufficient to pass the founder/internal gate", () => {
  withOperators(OPERATOR_ID, () => assert.equal(isFounderOrInternalUser(actor({ role: "owner" })), false));
});

test("a normal user cannot access founder actions regardless of display role", () => {
  withOperators(OPERATOR_ID, () => {
    assert.equal(isFounderOrInternalUser(actor({ role: "viewer" })), false);
    assert.equal(isFounderOrInternalUser(actor({ role: "pm" })), false);
  });
});

test("an internal email domain no longer passes the gate (F6)", () => {
  withOperators(OPERATOR_ID, () => {
    assert.equal(isFounderOrInternalUser(actor({ email: "founder@pmfreak.ai", role: "viewer" })), false);
    assert.equal(isFounderOrInternalUser(actor({ email: "ops@onchainfest.xyz", role: "viewer" })), false);
  });
});

test("FOUNDER_OPERATOR_USER_IDS grants founder access by verified user id, even with role=viewer", () => {
  withOperators(OPERATOR_ID, () => {
    assert.equal(isFounderOrInternalUser(actor({ id: OPERATOR_ID, role: "viewer" })), true);
    assert.equal(isFounderOrInternalUser(actor({ role: "viewer" })), false);
  });
});

// ── No regression: workspace-role-based authorization is untouched ─────────

test("workspace membership role (server-side, DB-backed) still governs management capability", () => {
  assert.equal(canManageWorkspace("owner"), true);
  assert.equal(canManageWorkspace("admin"), true);
  assert.equal(canManageWorkspace("pm"), false);
  assert.equal(canManageWorkspace("viewer"), false);
});

test("workspace membership role still governs invite capability", () => {
  assert.equal(canInviteMembers("admin"), true);
  assert.equal(canInviteMembers("viewer"), false);
});

test("workspace owners and admins can manage billing; pm and viewer cannot", () => {
  assert.equal(canManageBilling("owner"), true);
  assert.equal(canManageBilling("admin"), true);
  assert.equal(canManageBilling("pm"), false);
  assert.equal(canManageBilling("viewer"), false);
});
