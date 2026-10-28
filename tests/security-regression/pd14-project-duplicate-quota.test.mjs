/**
 * PD-14 — duplicating a project is creating a project, so it obeys the plan's project limit.
 *
 * Before 20261027000000_pd14_project_duplicate_quota.sql, POST /api/projects/[id]/duplicate
 * inserted the copy with no limit check, so a Free user (limit 3) could grow without bound.
 * Duplication now runs through src/lib/quota/project-quota.ts → the service-role-only
 * duplicate_project_within_limit(), which re-checks the writer role and workspace, serialises
 * per actor, counts and inserts in one transaction.
 *
 * Covered with real sessions, the real route and the real engine: no client role can call the
 * RPC (so nobody picks their own limit); the Free limit holds through the route; concurrent
 * duplicates by one user never overshoot; a refused duplicate consumes nothing; viewers and
 * other tenants are refused with nothing written; a paid plan keeps duplicating beyond 3.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv } from "./support/harness.mjs";
import { actAs, installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { POST: duplicatePost } = await import("../../src/app/api/projects/[id]/duplicate/route.ts");
const { duplicateProjectWithinLimit } = await import("../../src/lib/quota/project-quota.ts");

const INSUFFICIENT_PRIVILEGE = "42501";
const FREE_PROJECT_LIMIT = 3;

let fx;
const sessions = {};

before(async () => {
  fx = await createTenantFixtures(env, { label: "pd14" });
  sessions.owner = await fx.signIn(fx.users.bOwner);
  sessions.pm = await fx.signIn(fx.users.bPm);
  sessions.viewer = await fx.signIn(fx.users.bViewer);
  sessions.aOwner = await fx.signIn(fx.users.aOwner);
});

after(async () => {
  if (fx) await fx.teardown();
});

const params = (id) => ({ params: Promise.resolve({ id }) });
const duplicate = (projectId) => duplicatePost(new Request(`http://127.0.0.1:3000/api/projects/${projectId}/duplicate`, { method: "POST" }), params(projectId));

const ownedCount = async (userId) => {
  const { count, error } = await fx.admin.from("projects").select("id", { head: true, count: "exact" }).eq("user_id", userId);
  if (error) throw new Error(`[security-regression] count projects: ${error.message}`);
  return count;
};
const workspaceCount = async (workspaceId) => {
  const { count, error } = await fx.admin.from("projects").select("id", { head: true, count: "exact" }).eq("workspace_id", workspaceId);
  if (error) throw new Error(`[security-regression] count workspace projects: ${error.message}`);
  return count;
};

test("PD-14: no client role can call duplicate_project_within_limit, so nobody supplies their own limit", async () => {
  const before = await ownedCount(fx.users.bOwner.id);
  const args = { p_actor_user_id: fx.users.bOwner.id, p_workspace_id: fx.workspaces.B, p_source_project_id: fx.projects.B, p_target_pmo_id: null, p_project_limit: null };
  const signedIn = await sessions.owner.rpc("duplicate_project_within_limit", args);
  assert.equal(signedIn.error?.code, INSUFFICIENT_PRIVILEGE, `owner session: ${JSON.stringify(signedIn.error)}`);
  const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const anonymous = await anon.rpc("duplicate_project_within_limit", args);
  assert.equal(anonymous.error?.code, INSUFFICIENT_PRIVILEGE, `anon: ${JSON.stringify(anonymous.error)}`);
  assert.equal(await ownedCount(fx.users.bOwner.id), before);
});

test("PD-14: through the real route a Free owner duplicates up to the limit, then gets 402 upgrade_required", async () => {
  actAs(sessions.owner);
  assert.equal(await ownedCount(fx.users.bOwner.id), 1);
  for (const expected of [2, 3]) {
    const res = await duplicate(fx.projects.B);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.project.workspace_id, fx.workspaces.B);
    assert.equal(await ownedCount(fx.users.bOwner.id), expected);
  }
  const refused = await duplicate(fx.projects.B);
  assert.equal(refused.status, 402);
  assert.deepEqual(await refused.json(), { error: "Project limit reached for your plan.", failureClass: "upgrade_required" });
  assert.equal(await ownedCount(fx.users.bOwner.id), FREE_PROJECT_LIMIT);
});

test("PD-14: concurrent duplicates by one Free user never exceed the limit", async () => {
  const actor = fx.users.bPm.id;
  assert.equal(await ownedCount(actor), 0);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => duplicateProjectWithinLimit({ actorUserId: actor, workspaceId: fx.workspaces.B, sourceProjectId: fx.projects.B, targetPmoId: null })),
  );
  assert.equal(results.filter((r) => r.ok).length, FREE_PROJECT_LIMIT);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === "project_limit_reached"));
  assert.equal(await ownedCount(actor), FREE_PROJECT_LIMIT);
});

test("PD-14: a refused duplicate consumes no quota", async () => {
  const actor = fx.users.bAdmin.id;
  assert.equal(await ownedCount(actor), 0);
  const refused = await duplicateProjectWithinLimit({ actorUserId: actor, workspaceId: fx.workspaces.B, sourceProjectId: fx.projects.B, targetPmoId: randomUUID() });
  assert.deepEqual(refused, { ok: false, reason: "pmo_not_found" });
  assert.equal(await ownedCount(actor), 0);
  const ok = await duplicateProjectWithinLimit({ actorUserId: actor, workspaceId: fx.workspaces.B, sourceProjectId: fx.projects.B, targetPmoId: null });
  assert.equal(ok.ok, true);
  assert.equal(await ownedCount(actor), 1);
});

test("PD-14: a viewer cannot duplicate — refused by the route and inside the database, nothing written", async () => {
  const before = await workspaceCount(fx.workspaces.B);
  actAs(sessions.viewer);
  const res = await duplicate(fx.projects.B);
  assert.equal(res.status, 403);
  const engine = await duplicateProjectWithinLimit({ actorUserId: fx.users.bViewer.id, workspaceId: fx.workspaces.B, sourceProjectId: fx.projects.B, targetPmoId: null });
  assert.deepEqual(engine, { ok: false, reason: "insufficient_role" });
  assert.equal(await ownedCount(fx.users.bViewer.id), 0);
  assert.equal(await workspaceCount(fx.workspaces.B), before);
});

test("PD-14: another tenant can neither duplicate A's project nor copy it into its own workspace", async () => {
  const beforeA = await workspaceCount(fx.workspaces.A);
  const beforeB = await workspaceCount(fx.workspaces.B);
  actAs(sessions.pm);
  const res = await duplicate(fx.projects.A);
  assert.ok([403, 404].includes(res.status), `route status ${res.status}`);
  const intoA = await duplicateProjectWithinLimit({ actorUserId: fx.users.bOwner.id, workspaceId: fx.workspaces.A, sourceProjectId: fx.projects.A, targetPmoId: null });
  assert.deepEqual(intoA, { ok: false, reason: "insufficient_role" });
  const intoB = await duplicateProjectWithinLimit({ actorUserId: fx.users.bOwner.id, workspaceId: fx.workspaces.B, sourceProjectId: fx.projects.A, targetPmoId: null });
  assert.deepEqual(intoB, { ok: false, reason: "source_not_found" });
  assert.equal(await workspaceCount(fx.workspaces.A), beforeA);
  assert.equal(await workspaceCount(fx.workspaces.B), beforeB);
});

test("PD-14: a paid plan keeps duplicating beyond the Free limit", async () => {
  // Tenant A's owner carries the fixture's simulated Pro subscription (limit 25).
  actAs(sessions.aOwner);
  for (let i = 0; i < 4; i += 1) {
    const res = await duplicate(fx.projects.A);
    assert.equal(res.status, 201);
  }
  assert.equal(await ownedCount(fx.users.aOwner.id), 5);
});
