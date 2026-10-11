#!/usr/bin/env node
// ============================================================================
// Live verification of the entitlement hardening (complete membership reads
// and atomic early-access activation) against a DISPOSABLE local Supabase
// stack with every migration applied.
//
// Exercises, through real PostgREST and real Postgres:
//   - resolveTrialEntitlement with 1 / 20 / 21 / 150 memberships, with and
//     without an expired/revoked trial outside the first page;
//   - accept_early_access_invite: success, repeat, concurrent acceptance,
//     revoked/expired/unapproved invites, email mismatch and a foreign token,
//     a license that is no longer pending, and an injected failure at every
//     write step (workspace, membership, license link, invite acceptance,
//     activation record) — each must leave no workspace or membership behind.
//
// Failure injection installs triggers in the disposable database through
// `docker exec <container> psql`; they are removed afterwards.
//
// Required:
//   ENTITLEMENT_LIVE_SUPABASE_URL          loopback API URL (e.g. http://127.0.0.1:56321)
//   ENTITLEMENT_LIVE_SERVICE_ROLE_KEY      the local stack's service-role key
//   ENTITLEMENT_LIVE_DB_CONTAINER          the local stack's db container name
//   ENTITLEMENT_LIVE_ALLOW_DESTRUCTIVE=true
//
// Never point this at a shared or production project: it refuses any
// non-loopback URL.
// ============================================================================

import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const supabaseUrl = process.env.ENTITLEMENT_LIVE_SUPABASE_URL;
const serviceRoleKey = process.env.ENTITLEMENT_LIVE_SERVICE_ROLE_KEY;
const dbContainer = process.env.ENTITLEMENT_LIVE_DB_CONTAINER;

if (!supabaseUrl || !serviceRoleKey || !dbContainer || process.env.ENTITLEMENT_LIVE_ALLOW_DESTRUCTIVE !== "true") {
  console.error("Set ENTITLEMENT_LIVE_SUPABASE_URL, ENTITLEMENT_LIVE_SERVICE_ROLE_KEY, ENTITLEMENT_LIVE_DB_CONTAINER and ENTITLEMENT_LIVE_ALLOW_DESTRUCTIVE=true.");
  process.exit(2);
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(supabaseUrl).hostname)) {
  console.error("SAFETY ABORT: ENTITLEMENT_LIVE_SUPABASE_URL must use a literal loopback host.");
  process.exit(2);
}
if (!/^supabase_db_[a-z0-9-]+$/.test(dbContainer)) {
  console.error("SAFETY ABORT: ENTITLEMENT_LIVE_DB_CONTAINER must be a local supabase_db_* container.");
  process.exit(2);
}

const { createClient } = await import("@supabase/supabase-js");
const { resolveTrialEntitlement } = await import("../src/lib/auth/resolve-onboarding-state.ts");

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const DAY = 24 * 60 * 60 * 1000;
let passed = 0;
const results = [];

function psql(sql) {
  const run = spawnSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-At"], { input: sql, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`psql failed: ${run.stderr}`);
  return run.stdout.trim();
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`PASS  ${name}`);
  } catch (error) {
    results.push(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const must = ({ data, error }, label) => {
  assert.ifError(error ? new Error(`${label}: ${error.message}`) : null);
  return data;
};

async function createUser(label) {
  const email = `entitlement-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password: `E-${randomUUID()}!`, email_confirm: true });
  assert.ifError(created.error);
  return { id: created.data.user.id, email };
}

async function createWorkspaces(user, n, label) {
  const ids = [];
  for (let offset = 0; offset < n; offset += 200) {
    const rows = Array.from({ length: Math.min(200, n - offset) }, (_, i) => ({ name: `${label}-${offset + i}`, created_by_user_id: user.id }));
    const inserted = must(await admin.from("workspaces").insert(rows).select("id"), "insert workspaces");
    ids.push(...inserted.map((r) => r.id));
  }
  for (let offset = 0; offset < ids.length; offset += 200) {
    must(await admin.from("workspace_memberships").insert(ids.slice(offset, offset + 200).map((workspace_id) => ({ workspace_id, user_id: user.id, role: "owner" }))), "insert memberships");
  }
  return ids;
}

async function createInvite(email, overrides = {}) {
  const token = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const inviter = await createUser(`inviter-${randomUUID().slice(0, 6)}`);
  const invite = must(
    await admin
      .from("early_access_invites")
      .insert({ invite_email: email, invite_token_hash: tokenHash, inviter_user_id: inviter.id, expires_at: new Date(Date.now() + 14 * DAY).toISOString(), ...overrides })
      .select("id")
      .single(),
    "insert invite",
  );
  const trial = must(await admin.from("trial_licenses").insert({ invite_id: invite.id, trial_status: "pending" }).select("id").single(), "insert trial");
  return { inviteId: invite.id, tokenHash, trialId: trial.id };
}

async function attachTrial(workspaceId, status, endOffsetMs) {
  const inviter = await createUser(`trial-inviter-${randomUUID().slice(0, 6)}`);
  const invite = must(
    await admin
      .from("early_access_invites")
      .insert({ invite_email: `nobody-${randomUUID()}@example.test`, invite_token_hash: randomUUID(), inviter_user_id: inviter.id, expires_at: new Date(Date.now() + DAY).toISOString(), accepted_at: new Date().toISOString(), workspace_id: workspaceId })
      .select("id")
      .single(),
    "insert trial invite",
  );
  must(
    await admin.from("trial_licenses").insert({
      invite_id: invite.id,
      workspace_id: workspaceId,
      trial_status: status,
      trial_start_at: new Date(Date.now() - 30 * DAY).toISOString(),
      trial_end_at: new Date(Date.now() + endOffsetMs).toISOString(),
    }),
    "insert trial license",
  );
}

const accept = (invite, user, workspaceName = null) =>
  admin.rpc("accept_early_access_invite", {
    p_invite_id: invite.inviteId,
    p_invite_token_hash: invite.tokenHash,
    p_user_id: user.id,
    p_user_email: user.email,
    p_workspace_name: workspaceName,
    p_trial_days: 90,
  });

async function footprint(user) {
  const memberships = must(await admin.from("workspace_memberships").select("workspace_id").eq("user_id", user.id), "memberships");
  const workspaces = must(await admin.from("workspaces").select("id").eq("created_by_user_id", user.id), "workspaces");
  return { memberships: memberships.length, workspaces: workspaces.length };
}

async function inviteState(invite) {
  const row = must(await admin.from("early_access_invites").select("accepted_at, workspace_id").eq("id", invite.inviteId).single(), "invite state");
  const trial = must(await admin.from("trial_licenses").select("trial_status, workspace_id").eq("id", invite.trialId).single(), "trial state");
  const activations = must(await admin.from("workspace_activations").select("id").eq("invite_id", invite.inviteId), "activations");
  return { accepted: row.accepted_at !== null, inviteWorkspace: row.workspace_id, trialStatus: trial.trial_status, trialWorkspace: trial.workspace_id, activations: activations.length };
}

const expectUntouched = async (user, invite) => {
  assert.deepEqual(await footprint(user), { memberships: 0, workspaces: 0 }, "no workspace or membership may remain");
  assert.deepEqual(await inviteState(invite), { accepted: false, inviteWorkspace: null, trialStatus: "pending", trialWorkspace: null, activations: 0 }, "invite and license must be unchanged");
};

const errorCode = (res) => res.error?.message?.split("::", 1)[0] ?? null;

// ─── Entitlement: complete membership reads ─────────────────────────────────

for (const n of [1, 20, 21, 150]) {
  await check(`${n} membership(s), no trial → entitled (Free)`, async () => {
    const user = await createUser(`free-${n}`);
    await createWorkspaces(user, n, `free-${n}`);
    assert.equal(await resolveTrialEntitlement(admin, user.id), "entitled");
  });
}

for (const [n, status, offset] of [[21, "expired", -DAY], [21, "revoked", 30 * DAY], [150, "expired", -DAY], [150, "revoked", 30 * DAY], [150, "active", -DAY]]) {
  await check(`${n} memberships, ${status}${status === "active" ? " (past end)" : ""} trial on a workspace outside the first 20 → blocked`, async () => {
    const user = await createUser(`blocked-${n}-${status}`);
    const ids = await createWorkspaces(user, n, `blocked-${n}`);
    // Workspace ids are random UUIDs and pages are ordered by workspace_id, so
    // attach to the workspace that sorts LAST — guaranteed outside any 20-row
    // (or 100-row) first page.
    const last = [...ids].sort().at(-1);
    await attachTrial(last, status, offset);
    assert.equal(await resolveTrialEntitlement(admin, user.id), "blocked");
  });
}

await check("150 memberships, active trial newest + expired older on later workspaces → entitled (most recent wins)", async () => {
  const user = await createUser("mixed-active");
  const ids = [...(await createWorkspaces(user, 150, "mixed-a"))].sort();
  await attachTrial(ids[140], "expired", -DAY);
  await attachTrial(ids[149], "active", 30 * DAY);
  assert.equal(await resolveTrialEntitlement(admin, user.id), "entitled");
});

await check("150 memberships, revoked trial newest + active older → blocked (most recent wins)", async () => {
  const user = await createUser("mixed-revoked");
  const ids = [...(await createWorkspaces(user, 150, "mixed-r"))].sort();
  await attachTrial(ids[5], "active", 30 * DAY);
  await attachTrial(ids[149], "revoked", 30 * DAY);
  assert.equal(await resolveTrialEntitlement(admin, user.id), "blocked");
});

await check("user with no memberships → blocked", async () => {
  const user = await createUser("no-membership");
  assert.equal(await resolveTrialEntitlement(admin, user.id), "blocked");
});

// ─── Atomic early-access activation ─────────────────────────────────────────

await check("successful activation creates workspace, owner membership, linked active trial, accepted invite and activation together", async () => {
  const user = await createUser("accept-ok");
  const invite = await createInvite(user.email);
  const res = await accept(invite, user, "Acme early access");
  assert.ifError(res.error);
  assert.equal(typeof res.data.workspace_id, "string");
  const state = await inviteState(invite);
  assert.deepEqual({ ...state, inviteWorkspace: state.inviteWorkspace === res.data.workspace_id, trialWorkspace: state.trialWorkspace === res.data.workspace_id }, { accepted: true, inviteWorkspace: true, trialStatus: "active", trialWorkspace: true, activations: 1 });
  const role = must(await admin.from("workspace_memberships").select("role").eq("workspace_id", res.data.workspace_id).eq("user_id", user.id).single(), "role");
  assert.equal(role.role, "owner");
  assert.equal(await resolveTrialEntitlement(admin, user.id), "entitled");
});

await check("repeated activation is rejected and creates nothing more", async () => {
  const user = await createUser("accept-repeat");
  const invite = await createInvite(user.email);
  assert.ifError((await accept(invite, user)).error);
  const before = await footprint(user);
  const again = await accept(invite, user);
  assert.equal(errorCode(again), "reused_token");
  assert.deepEqual(await footprint(user), before);
});

await check("10 concurrent activations: exactly one succeeds, the rest are reused_token, one workspace", async () => {
  const user = await createUser("accept-race");
  const invite = await createInvite(user.email);
  const all = await Promise.all(Array.from({ length: 10 }, () => accept(invite, user)));
  assert.equal(all.filter((r) => !r.error).length, 1);
  assert.deepEqual([...new Set(all.filter((r) => r.error).map(errorCode))], ["reused_token"]);
  assert.deepEqual(await footprint(user), { memberships: 1, workspaces: 1 });
  assert.equal((await inviteState(invite)).activations, 1);
});

await check("revoked invite → revoked_token, nothing written", async () => {
  const user = await createUser("accept-revoked");
  const invite = await createInvite(user.email, { revoked_at: new Date().toISOString() });
  assert.equal(errorCode(await accept(invite, user)), "revoked_token");
  await expectUntouched(user, invite);
});

await check("expired invite → expired_token, nothing written", async () => {
  const user = await createUser("accept-expired");
  const invite = await createInvite(user.email, { expires_at: new Date(Date.now() - DAY).toISOString() });
  assert.equal(errorCode(await accept(invite, user)), "expired_token");
  await expectUntouched(user, invite);
});

await check("invite requiring approval → pending_approval, nothing written", async () => {
  const user = await createUser("accept-approval");
  const invite = await createInvite(user.email, { requires_approval: true });
  assert.equal(errorCode(await accept(invite, user)), "pending_approval");
  await expectUntouched(user, invite);
});

await check("cross-tenant: another user cannot activate someone else's invite (email binding)", async () => {
  const owner = await createUser("tenant-a");
  const attacker = await createUser("tenant-b");
  const invite = await createInvite(owner.email);
  assert.equal(errorCode(await accept(invite, attacker)), "email_mismatch");
  await expectUntouched(attacker, invite);
});

await check("cross-tenant: a stale or wrong token hash for a real invite id is rejected", async () => {
  const user = await createUser("accept-wrong-hash");
  const invite = await createInvite(user.email);
  assert.equal(errorCode(await accept({ ...invite, tokenHash: "0".repeat(64) }, user)), "invalid_token");
  await expectUntouched(user, invite);
});

await check("license no longer pending (e.g. revoked before acceptance) → activation_unavailable, nothing written", async () => {
  const user = await createUser("accept-license-revoked");
  const invite = await createInvite(user.email);
  must(await admin.from("trial_licenses").update({ trial_status: "revoked" }).eq("id", invite.trialId), "revoke license");
  assert.equal(errorCode(await accept(invite, user)), "activation_unavailable");
  assert.deepEqual(await footprint(user), { memberships: 0, workspaces: 0 });
});

// Failure injection: each trigger raises only for workspaces named after it,
// so it cannot affect any other scenario.
psql(`
create or replace function public._hotfix_fail_if_named(p_workspace_id uuid, p_step text) returns void language plpgsql as $$
begin
  if exists (select 1 from public.workspaces where id = p_workspace_id and name = 'FAIL_AT_' || p_step) then
    raise exception 'injected failure at %', p_step;
  end if;
end $$;
-- One trigger function per table: PL/pgSQL does not short-circuit record
-- field access across tables, so each function only touches its own NEW.
create or replace function public._hotfix_fail_workspaces() returns trigger language plpgsql as $$
begin
  if new.name = 'FAIL_AT_WORKSPACE' then raise exception 'injected failure at WORKSPACE'; end if;
  return new;
end $$;
create or replace function public._hotfix_fail_memberships() returns trigger language plpgsql as $$
begin perform public._hotfix_fail_if_named(new.workspace_id, 'MEMBERSHIP'); return new; end $$;
create or replace function public._hotfix_fail_trials() returns trigger language plpgsql as $$
begin
  if new.workspace_id is not null then perform public._hotfix_fail_if_named(new.workspace_id, 'TRIAL_LINK'); end if;
  return new;
end $$;
create or replace function public._hotfix_fail_invites() returns trigger language plpgsql as $$
begin
  if new.workspace_id is not null then perform public._hotfix_fail_if_named(new.workspace_id, 'INVITE_ACCEPT'); end if;
  return new;
end $$;
create or replace function public._hotfix_fail_activations() returns trigger language plpgsql as $$
begin perform public._hotfix_fail_if_named(new.workspace_id, 'ACTIVATION'); return new; end $$;
create trigger _hotfix_fail before insert on public.workspaces for each row execute function public._hotfix_fail_workspaces();
create trigger _hotfix_fail before insert on public.workspace_memberships for each row execute function public._hotfix_fail_memberships();
create trigger _hotfix_fail before update on public.trial_licenses for each row execute function public._hotfix_fail_trials();
create trigger _hotfix_fail before update on public.early_access_invites for each row execute function public._hotfix_fail_invites();
create trigger _hotfix_fail before insert on public.workspace_activations for each row execute function public._hotfix_fail_activations();
`);

try {
  for (const step of ["WORKSPACE", "MEMBERSHIP", "TRIAL_LINK", "INVITE_ACCEPT", "ACTIVATION"]) {
    await check(`failure at ${step} rolls back every write and the invite stays acceptable`, async () => {
      const user = await createUser(`fail-${step.toLowerCase()}`);
      const invite = await createInvite(user.email);
      const res = await accept(invite, user, `FAIL_AT_${step}`);
      assert.ok(res.error, "activation must fail");
      assert.match(res.error.message, new RegExp(`injected failure at ${step}`));
      await expectUntouched(user, invite);
      // Retrying after the fault clears succeeds exactly once.
      const retry = await accept(invite, user, "Recovered workspace");
      assert.ifError(retry.error);
      assert.deepEqual(await footprint(user), { memberships: 1, workspaces: 1 });
      assert.equal((await inviteState(invite)).trialStatus, "active");
    });
  }
} finally {
  psql(`
drop trigger if exists _hotfix_fail on public.workspaces;
drop trigger if exists _hotfix_fail on public.workspace_memberships;
drop trigger if exists _hotfix_fail on public.trial_licenses;
drop trigger if exists _hotfix_fail on public.early_access_invites;
drop trigger if exists _hotfix_fail on public.workspace_activations;
drop function if exists public._hotfix_fail_workspaces();
drop function if exists public._hotfix_fail_memberships();
drop function if exists public._hotfix_fail_trials();
drop function if exists public._hotfix_fail_invites();
drop function if exists public._hotfix_fail_activations();
drop function if exists public._hotfix_fail_if_named(uuid, text);
`);
}

await check("orphaned pending license (invite never accepted) is never attached to the invitee's own workspace", async () => {
  // An invitee signs up through public /signup first (a Free account with its
  // own workspace) and only then opens the invite.
  const user = await createUser("orphan");
  await createWorkspaces(user, 1, "orphan-own");
  const invite = await createInvite(user.email);
  assert.equal(await resolveTrialEntitlement(admin, user.id), "entitled");
  const state = await inviteState(invite);
  assert.equal(state.trialWorkspace, null);
  assert.equal(state.trialStatus, "pending");
  // Accepting later moves the account under the trial.
  assert.ifError((await accept(invite, user)).error);
  must(await admin.from("trial_licenses").update({ trial_start_at: new Date(Date.now() - 91 * DAY).toISOString(), trial_end_at: new Date(Date.now() - DAY).toISOString() }).eq("id", invite.trialId), "age trial");
  assert.equal(await resolveTrialEntitlement(admin, user.id), "blocked");
});

await check("anon and authenticated roles cannot execute accept_early_access_invite", async () => {
  const out = psql(`select string_agg(r || '=' || has_function_privilege(r, 'public.accept_early_access_invite(uuid,text,uuid,text,text,integer)', 'execute'), ',' order by r) from unnest(array['anon','authenticated','service_role']) r;`);
  assert.equal(out, "anon=false,authenticated=false,service_role=true");
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
