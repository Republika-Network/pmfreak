/**
 * F6 — founder/operator authority derived from the email string (remediated by PR-4).
 *
 * `evaluateFounderOrInternalAccess` (src/lib/auth.ts) used to admit ANY address ending in
 * `@pmfreak.ai` or `@onchainfest.xyz`, or listed in FOUNDER_EMAIL_ALLOWLIST, and never looked
 * at email confirmation. It gates cross-tenant, service-role surfaces. Operator authority is
 * now the GoTrue-verified user id listed in the server-only FOUNDER_OPERATOR_USER_IDS, with a
 * confirmed email; absent or malformed configuration denies everyone.
 *
 * This file drives the real early-access founder routes — `/api/early-access/summary` (all
 * tenants' invites, trials and activations), `/api/early-access/invites` and
 * `/api/early-access/founder-actions` (cross-tenant trial / invite mutations) — and the
 * founder-program operator gate (`requireFounderProgramOperator`) as signed-in fixture users.
 * Every denial is checked against a snapshot of the early-access tables, so a refused call can
 * leave no partial cross-tenant write.
 *
 * Authorized operator: a confirmed @example.test user whose id is listed in
 * FOUNDER_OPERATOR_USER_IDS for this process only. Unauthorized: confirmed internal-domain
 * signups nobody listed, a listed-but-unconfirmed user, and ordinary tenant users. GoTrue
 * refuses to sign an unconfirmed user in at all, so that case is proven twice: no session can
 * be obtained, and the real (unconfirmed) GoTrue user record, built into a server-verified
 * context, is still denied by the decision itself. Local GoTrue never sends mail for
 * admin-created users, and RESEND_API_KEY is removed so no invite email can be sent.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();
delete process.env.RESEND_API_KEY;
delete process.env.FOUNDER_EMAIL_ALLOWLIST;

const { GET: earlyAccessSummaryGet } = await import("../../src/app/api/early-access/summary/route.ts");
const { POST: earlyAccessInvitesPost } = await import("../../src/app/api/early-access/invites/route.ts");
const { POST: founderActionsPost } = await import("../../src/app/api/early-access/founder-actions/route.ts");
const { GET: founderProgramDashboardGet } = await import("../../src/app/api/founder-program/operator/dashboard/route.ts");
const { buildAuthUserContext, evaluateFounderOrInternalAccess, isFounderOrInternalUser } = await import("../../src/lib/auth.ts");

const FOUNDER_PROGRAM_FLAG = "PMFREAK_FOUNDER_PROGRAM_ENABLED";

let fx;
let operator;
let unconfirmedOperator;
let targetInviteId;
let targetTrialId;
let originalProgramEnabled;
const sessions = {};
const createdInviteIds = [];

before(async () => {
  fx = await createTenantFixtures(env, { label: "f6" });
  operator = await fx.createUser("operator");
  const internalPmfreak = await fx.createUser("unlisted", { domain: "pmfreak.ai" });
  const internalOnchainfest = await fx.createUser("unlisted", { domain: "onchainfest.xyz" });
  unconfirmedOperator = await fx.createUser("unconfirmed-operator", { confirmed: false });
  process.env.FOUNDER_OPERATOR_USER_IDS = [operator.id, unconfirmedOperator.id].join(",");

  sessions.tenantUser = await fx.signIn(fx.users.bOwner);
  sessions.tenantAdmin = await fx.signIn(fx.users.bAdmin);
  sessions.operator = await fx.signIn(operator);
  sessions.internalPmfreak = await fx.signIn(internalPmfreak);
  sessions.internalOnchainfest = await fx.signIn(internalOnchainfest);

  // Cross-tenant target: an early-access invite and active trial attached to tenant B.
  const { data: invite, error: inviteError } = await fx.admin
    .from("early_access_invites")
    .insert({
      invite_email: `sec-target-${fx.tag}@example.test`,
      invite_token_hash: randomBytes(32).toString("hex"),
      inviter_user_id: operator.id,
      expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      workspace_id: fx.workspaces.B,
    })
    .select("id")
    .single();
  if (inviteError) throw new Error(`[security-regression] fixture step failed (target invite): ${inviteError.message}`);
  targetInviteId = invite.id;
  createdInviteIds.push(invite.id);
  const { data: trial, error: trialError } = await fx.admin
    .from("trial_licenses")
    .insert({
      invite_id: invite.id,
      workspace_id: fx.workspaces.B,
      trial_status: "active",
      trial_start_at: new Date().toISOString(),
      trial_end_at: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  if (trialError) throw new Error(`[security-regression] fixture step failed (target trial): ${trialError.message}`);
  targetTrialId = trial.id;

  // Founder program: enable it for this process (env flag + singleton settings row),
  // restored in after(), so requireFounderProgramOperator reaches its operator check.
  const { data: settings, error: settingsError } = await fx.admin.from("founder_program_settings").select("program_enabled").eq("singleton", true).single();
  if (settingsError) throw new Error(`[security-regression] fixture step failed (founder program settings): ${settingsError.message}`);
  originalProgramEnabled = settings.program_enabled;
  const { error: enableError } = await fx.admin.from("founder_program_settings").update({ program_enabled: true }).eq("singleton", true);
  if (enableError) throw new Error(`[security-regression] fixture step failed (enable founder program): ${enableError.message}`);
  process.env[FOUNDER_PROGRAM_FLAG] = "true";
});

after(async () => {
  delete process.env.FOUNDER_OPERATOR_USER_IDS;
  delete process.env[FOUNDER_PROGRAM_FLAG];
  if (!fx) return;
  const errors = [];
  if (originalProgramEnabled !== undefined) {
    const { error } = await fx.admin.from("founder_program_settings").update({ program_enabled: originalProgramEnabled }).eq("singleton", true);
    if (error) errors.push(`restore founder program settings: ${error.message}`);
  }
  const { data: invites } = await fx.admin.from("early_access_invites").select("id").eq("inviter_user_id", operator.id);
  const inviteIds = [...new Set([...createdInviteIds, ...(invites ?? []).map((row) => row.id)])];
  if (inviteIds.length) {
    // Events reference invites with ON DELETE SET NULL; remove them before the invites.
    for (const [table, column] of [["early_access_events", "invite_id"], ["early_access_invites", "id"]]) {
      const { error } = await fx.admin.from(table).delete().in(column, inviteIds);
      if (error) errors.push(`${table}: ${error.message}`);
    }
  }
  await fx.teardown();
  if (errors.length) throw new Error(`[security-regression] f6 cleanup incomplete: ${errors.join("; ")}`);
});

const withOperatorConfig = async (value, fn) => {
  const previous = process.env.FOUNDER_OPERATOR_USER_IDS;
  if (value === undefined) delete process.env.FOUNDER_OPERATOR_USER_IDS;
  else process.env.FOUNDER_OPERATOR_USER_IDS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FOUNDER_OPERATOR_USER_IDS;
    else process.env.FOUNDER_OPERATOR_USER_IDS = previous;
  }
};

const jsonRequest = (path, body) =>
  new Request(`http://127.0.0.1:3000${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const summaryAs = async (client) => {
  actAs(client);
  return earlyAccessSummaryGet();
};

const summaryStatusAs = async (client) => (await summaryAs(client)).status;

const createInviteAs = async (client, extra = {}) => {
  actAs(client);
  return earlyAccessInvitesPost(jsonRequest("/api/early-access/invites", { inviteEmail: `sec-invitee-${randomBytes(4).toString("hex")}-${fx.tag}@example.test`, ...extra }));
};

const founderActionAs = async (client, body) => {
  actAs(client);
  return founderActionsPost(jsonRequest("/api/early-access/founder-actions", body));
};

const dashboardStatusAs = async (client) => {
  actAs(client);
  return (await founderProgramDashboardGet()).status;
};

/** Everything a founder route could have written for this run, plus whole-table counts. */
const earlyAccessState = async () => {
  const count = async (table) => {
    const { count: rows, error } = await fx.admin.from(table).select("id", { count: "exact", head: true });
    if (error) throw new Error(`[security-regression] snapshot ${table}: ${error.message}`);
    return rows;
  };
  const row = async (table, id) => {
    const { data, error } = await fx.admin.from(table).select("*").eq("id", id).single();
    if (error) throw new Error(`[security-regression] snapshot ${table}: ${error.message}`);
    return data;
  };
  return {
    invite: await row("early_access_invites", targetInviteId),
    trial: await row("trial_licenses", targetTrialId),
    invites: await count("early_access_invites"),
    trials: await count("trial_licenses"),
    events: await count("early_access_events"),
  };
};

/** Every founder surface refuses `client` (403) and leaves the early-access tables untouched. */
const assertNoOperatorAuthority = async (client, who) => {
  const snapshot = await earlyAccessState();
  assert.equal(await summaryStatusAs(client), 403, `${who} read the cross-tenant founder summary`);
  assert.equal((await createInviteAs(client)).status, 403, `${who} created an early-access invite`);
  assert.equal((await founderActionAs(client, { action: "revoke_trial", trialId: targetTrialId, reason: "f6 probe" })).status, 403, `${who} revoked another tenant's trial`);
  assert.equal((await founderActionAs(client, { action: "extend_trial", trialId: targetTrialId, extensionDays: 30 })).status, 403, `${who} extended another tenant's trial`);
  assert.equal((await founderActionAs(client, { action: "revoke_invite", inviteId: targetInviteId })).status, 403, `${who} revoked another tenant's invite`);
  assert.equal(await dashboardStatusAs(client), 403, `${who} opened the founder-program operator dashboard`);
  assert.deepEqual(await earlyAccessState(), snapshot, `a refused ${who} call changed early-access state`);
};

test("control: an ordinary tenant user is denied the founder summary (403)", async () => {
  assert.equal(await summaryStatusAs(sessions.tenantUser), 403);
});

test("control: an explicitly authorized operator is admitted to the founder summary (200)", async () => {
  assert.equal(await summaryStatusAs(sessions.operator), 200);
});

test("an unlisted @pmfreak.ai signup is not an operator", async () => {
  assert.equal(await summaryStatusAs(sessions.internalPmfreak), 403, "unlisted @pmfreak.ai account read the cross-tenant founder summary");
});

test("an unlisted @onchainfest.xyz signup is not an operator", async () => {
  assert.equal(await summaryStatusAs(sessions.internalOnchainfest), 403, "unlisted @onchainfest.xyz account read the cross-tenant founder summary");
});

test("operator authority requires a confirmed email address", async () => {
  const unconfirmed = { id: operator.id, email: operator.email, email_confirmed_at: null };
  assert.equal(isFounderOrInternalUser(unconfirmed), false, "unconfirmed address was granted operator authority");
});

test("a listed operator whose email is unconfirmed can neither sign in nor pass the decision with its real GoTrue record", async () => {
  await assert.rejects(fx.signIn(unconfirmedOperator), /Email not confirmed/, "GoTrue issued a session to an unconfirmed address");

  const { data, error } = await fx.admin.auth.admin.getUserById(unconfirmedOperator.id);
  assert.ifError(error);
  assert.equal(data.user.email_confirmed_at ?? null, null, "fixture precondition: the listed operator is unconfirmed");
  const context = buildAuthUserContext(data.user, { verifiedByAuthServer: true });
  assert.deepEqual(evaluateFounderOrInternalAccess(context), { allowed: false, decision: "deny_email_unconfirmed" });

  const { data: confirmedOperator } = await fx.admin.auth.admin.getUserById(operator.id);
  assert.equal(isFounderOrInternalUser(buildAuthUserContext(confirmedOperator.user, { verifiedByAuthServer: true })), true, "control: the confirmed listed operator's record passes");
});

test("unlisted internal-domain signups have no operator authority on any founder surface and change nothing", async () => {
  await assertNoOperatorAuthority(sessions.internalPmfreak, "unlisted @pmfreak.ai user");
  await assertNoOperatorAuthority(sessions.internalOnchainfest, "unlisted @onchainfest.xyz user");
});

test("ordinary tenant owners and admins have no operator authority on any founder surface and change nothing", async () => {
  await assertNoOperatorAuthority(sessions.tenantUser, "tenant owner");
  await assertNoOperatorAuthority(sessions.tenantAdmin, "tenant admin");
});

test("a fabricated operator identity in the request body is ignored — the actor comes from the session only", async () => {
  const forged = {
    action: "revoke_trial",
    trialId: targetTrialId,
    userId: operator.id,
    email: operator.email,
    user: { id: operator.id, email: operator.email, email_confirmed_at: new Date().toISOString() },
    isFounder: true,
    isOperator: true,
    actorRole: "owner",
  };
  const snapshot = await earlyAccessState();
  assert.equal((await founderActionAs(sessions.internalPmfreak, forged)).status, 403);
  assert.equal((await createInviteAs(sessions.tenantUser, { userId: operator.id, email: operator.email, isFounder: true })).status, 403);
  assert.deepEqual(await earlyAccessState(), snapshot, "a forged-identity request changed early-access state");
});

test("missing, empty or malformed operator configuration fails closed — even for the configured operator", async () => {
  for (const value of [undefined, "", " , ", `${operator.id},${operator.email}`, "not-a-uuid"]) {
    await withOperatorConfig(value, () => assertNoOperatorAuthority(sessions.operator, `operator under FOUNDER_OPERATOR_USER_IDS=${JSON.stringify(value)}`));
  }
  assert.equal(await summaryStatusAs(sessions.operator), 200, "the operator is admitted again once the configuration is restored");
});

test("FOUNDER_EMAIL_ALLOWLIST no longer grants anything", async () => {
  process.env.FOUNDER_EMAIL_ALLOWLIST = [fx.users.bOwner.email, operator.email].join(",");
  try {
    assert.equal(await summaryStatusAs(sessions.tenantUser), 403, "an email allowlist entry granted operator authority");
    await withOperatorConfig(undefined, async () => {
      assert.equal(await summaryStatusAs(sessions.operator), 403, "an email allowlist entry substituted for FOUNDER_OPERATOR_USER_IDS");
    });
  } finally {
    delete process.env.FOUNDER_EMAIL_ALLOWLIST;
  }
});

test("the authorized operator keeps the founder workflows: summary, invite, cross-tenant trial extension, invite revocation, program dashboard", async () => {
  const summary = await summaryAs(sessions.operator);
  assert.equal(summary.status, 200);
  const body = await summary.json();
  assert.ok(body.activeTrials.some((trial) => trial.id === targetTrialId), "the operator summary spans tenants");

  const inviteResponse = await createInviteAs(sessions.operator);
  assert.equal(inviteResponse.status, 200);
  const invite = await inviteResponse.json();
  assert.ok(invite.inviteId, "the operator created an invite");
  createdInviteIds.push(invite.inviteId);
  assert.equal(invite.emailDelivery.ok, false, "no email provider is configured in this harness");

  const beforeExtension = await earlyAccessState();
  const extended = await founderActionAs(sessions.operator, { action: "extend_trial", trialId: targetTrialId, extensionDays: 7, reason: "f6 operator control" });
  assert.equal(extended.status, 200);
  const afterExtension = await earlyAccessState();
  assert.ok(Date.parse(afterExtension.trial.trial_end_at) > Date.parse(beforeExtension.trial.trial_end_at), "the operator extended tenant B's trial");
  assert.equal(afterExtension.trial.trial_status, "active");

  const revoked = await founderActionAs(sessions.operator, { action: "revoke_invite", inviteId: invite.inviteId, reason: "f6 operator control" });
  assert.equal(revoked.status, 200);
  const { data: revokedInvite } = await fx.admin.from("early_access_invites").select("revoked_at").eq("id", invite.inviteId).single();
  assert.ok(revokedInvite.revoked_at, "the operator revoked the invite it created");

  assert.equal(await dashboardStatusAs(sessions.operator), 200, "the operator opened the founder-program operator dashboard");
});
