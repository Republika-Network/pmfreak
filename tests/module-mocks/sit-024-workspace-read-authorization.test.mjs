/**
 * SIT-024 — workspace read vs project read, at the shared authorization primitives.
 *
 * Real runtime authority, governance policy registry and access-verification adapter; only the
 * Supabase / next/headers transport is fake (sit-024-workspace-read-fake.mjs, which applies
 * query filters so membership in workspace A never answers for workspace B).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  governanceDecisions, installTransportFakes, resetWorld, world,
  PROJECT_A, PROJECT_B, WORKSPACE_A, WORKSPACE_B,
} from "./sit-024-workspace-read-fake.mjs";

delete process.env.OPENAI_API_KEY;
delete process.env.PMFREAK_OPERATING_PROFILE;

async function load(t) {
  installTransportFakes(t);
  const authz = await import("../../src/lib/security/server-authorization.ts");
  const guards = await import("../../src/lib/security/access-guards.ts");
  const actions = await import("../../src/lib/aoc/runtime/governance-actions.ts");
  const consumer = await import("../../src/aoc/runtime-consumer/index.ts");
  const core = await import("../../src/lib/governance/authority/runtime/governance-core.ts");
  return { ...authz, guards, actions, consumer, core };
}

async function outcome(promise) {
  try { await promise; return "allow"; } catch (error) { return `deny:${error?.metadata?.reason ?? error?.message}`; }
}

const lastDecision = () => governanceDecisions().at(-1)?.decision ?? null;

test("resolver: read is scope-aware; every other permission keeps its mapping", async (t) => {
  const { actions } = await load(t);
  assert.equal(actions.resolveGovernanceAction("read", "workspace"), "workspace.read");
  assert.equal(actions.resolveGovernanceAction("read", "project"), "project.read");
  for (const [permission, action] of Object.entries(actions.PERMISSION_TO_GOVERNANCE_ACTION)) {
    if (permission === "read") continue;
    assert.equal(actions.resolveGovernanceAction(permission, "workspace"), action, `${permission} at workspace scope`);
    assert.equal(actions.resolveGovernanceAction(permission, "project"), action, `${permission} at project scope`);
  }
  assert.equal(actions.PERMISSION_TO_GOVERNANCE_ACTION.read, "project.read", "context-free map is unchanged");
});

test("policy registry: workspace.read is a low-risk, human-only, workspace-scoped read; project.read stays project-scoped", async (t) => {
  const { core } = await load(t);
  const workspaceRead = core.GOVERNANCE_POLICY_REGISTRY["workspace.read"];
  assert.deepEqual(workspaceRead, { requiredPermission: "read", allowedActorTypes: ["user"], agentCompatible: false, denyEventType: "workspace_scope_violation", riskLevel: "low", workspaceScoped: true });
  const projectRead = core.GOVERNANCE_POLICY_REGISTRY["project.read"];
  assert.equal(projectRead.projectScoped, true);
  assert.equal(projectRead.requiredPermission, "read");
});

test("negative control (pre-fix path): project.read with a workspace but no projectId is still denied before membership", async (t) => {
  const { consumer } = await load(t);
  resetWorld({ role: "owner" });
  const decision = await consumer.authorizeRuntimeAction(consumer.buildEnterpriseRuntimeRequest({
    user: { id: world.user.id, email: world.user.email }, action: "project.read", routeId: "sit-024.negative-control",
    workspaceId: WORKSPACE_A, projectId: null, resourceType: "workspace", resourceId: WORKSPACE_A,
  }));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "Denied because project scope is missing for project-scoped action.");
  assert.deepEqual(decision.runtimeMetadata.trace.entries.map((entry) => entry.rule), ["policy_registry"], "denied before any membership lookup");
});

for (const role of ["owner", "admin", "pm", "viewer"]) {
  test(`requireWorkspaceMember: persisted ${role} → allowed via workspace.read (display role "viewer" is inert)`, async (t) => {
    const { requireWorkspaceMember } = await load(t);
    resetWorld({ role });
    assert.equal(await outcome(requireWorkspaceMember(WORKSPACE_A)), "allow");
    const decision = lastDecision();
    assert.equal(decision.matchedPolicy, "workspace.read");
    assert.equal(decision.requiredPermission, "read");
    assert.equal(decision.scope.workspaceId, WORKSPACE_A);
    assert.equal(decision.scope.projectId, null);
    assert.equal(decision.auditEventType, "governance_action_allowed");
    const expectedRole = { owner: "owner", admin: "admin", pm: "PM", viewer: "external_stakeholder" }[role];
    assert.equal(decision.trace.find((entry) => entry.rule === "workspace_membership_checked").roleChecked, expectedRole, "adapter normalization");
  });
}

test("workspace read does not elevate: viewer and pm keep every non-read denial", async (t) => {
  const { evaluateCapability } = await load(t);
  const denied = {
    viewer: ["write", "delete", "manage_workspace", "manage_members", "manage_billing", "execute_ai_action"],
    pm: ["delete", "manage_workspace", "manage_members", "manage_billing"],
  };
  for (const [role, permissions] of Object.entries(denied)) {
    resetWorld({ role });
    assert.equal(await outcome(evaluateCapability({ permission: "read", workspaceId: WORKSPACE_A })), "allow");
    for (const permission of permissions) {
      const result = await outcome(evaluateCapability({ permission, workspaceId: WORKSPACE_A }));
      assert.match(result, /^deny:/, `${role} must not gain ${permission}`);
      assert.notEqual(lastDecision().matchedPolicy, "workspace.read", `${permission} never resolves to workspace.read`);
    }
  }
});

test("requireWorkspaceMember: missing membership, foreign workspace, invalid id, unknown role → denied", async (t) => {
  const { requireWorkspaceMember } = await load(t);
  resetWorld({ role: null });
  assert.match(await outcome(requireWorkspaceMember(WORKSPACE_A)), /deny:.*missing_membership/);

  resetWorld({ role: "owner", workspaceId: WORKSPACE_A });
  assert.match(await outcome(requireWorkspaceMember(WORKSPACE_B)), /deny:.*missing_membership/);
  assert.equal(lastDecision().auditEventType, "workspace_scope_violation");

  assert.match(await outcome(requireWorkspaceMember("not-a-workspace")), /deny:.*missing_membership/);

  resetWorld({ role: "superuser" });
  assert.match(await outcome(requireWorkspaceMember(WORKSPACE_A)), /deny:.*unsupported_workspace_role/);
});

test("requireWorkspaceMember: no session → unauthorized", async (t) => {
  const { requireWorkspaceMember } = await load(t);
  resetWorld();
  world.user = null;
  assert.equal(await outcome(requireWorkspaceMember(WORKSPACE_A)), "deny:unauthorized");
});

test("access-guards requireWorkspaceMembership shares the fix (same primitive, same scope rule)", async (t) => {
  const { guards } = await load(t);
  resetWorld({ role: "viewer" });
  assert.equal(await outcome(guards.requireWorkspaceMembership(WORKSPACE_A)), "allow");
  assert.equal(lastDecision().matchedPolicy, "workspace.read");
  assert.match(await outcome(guards.requireWorkspaceMembership(WORKSPACE_B)), /^deny:/);
});

test("access-guards requireGovernancePermission: the trailing membership read no longer vetoes a granted permission; RBAC still decides", async (t) => {
  const { guards } = await load(t);
  resetWorld({ role: "owner" });
  assert.equal(await outcome(guards.requireGovernancePermission(WORKSPACE_A, "manage_members")), "allow");
  const policies = governanceDecisions().map((d) => d.decision.matchedPolicy);
  assert.deepEqual(policies.slice(-2), ["members.manage", "workspace.read"]);

  resetWorld({ role: "viewer" });
  assert.match(await outcome(guards.requireGovernancePermission(WORKSPACE_A, "manage_members")), /^deny:/);
  assert.equal(lastDecision().matchedPolicy, "members.manage", "denied on the permission itself, before any membership read");
});

test("requireProjectAccess(read) stays project.read and stays project-bound", async (t) => {
  const { requireProjectAccess } = await load(t);
  resetWorld({ role: "viewer", workspaceId: WORKSPACE_A });
  assert.equal(await outcome(requireProjectAccess(PROJECT_A, "read")), "allow");
  assert.equal(lastDecision().matchedPolicy, "project.read");
  assert.equal(lastDecision().scope.projectId, PROJECT_A);

  assert.match(await outcome(requireProjectAccess(PROJECT_B, "read")), /^deny:/, "member of A cannot read a project in B");
  assert.equal(lastDecision().matchedPolicy, "project.read");
  assert.match(await outcome(requireProjectAccess("00000000-0000-0000-0000-000000000000", "read")), /deny:.*project_not_found/);
});

test("Project Brain: GET stays project.read + projectId, POST stays project_brain.converse; no workspace.read, no foreign project", async (t) => {
  installTransportFakes(t);
  const { GET, POST } = await import("../../src/app/api/projects/[id]/brain/turns/route.ts");
  const ctx = (projectId) => ({ params: Promise.resolve({ id: projectId }) });
  const url = (projectId) => `http://localhost:3000/api/projects/${projectId}/brain/turns`;
  const get = (projectId) => GET(new Request(url(projectId)), ctx(projectId));
  const post = (projectId) => POST(new Request(url(projectId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "What is the current status of this project?", clientMessageId: "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b24" }) }), ctx(projectId));
  const decisions = () => governanceDecisions().map((d) => d.decision);

  resetWorld({ role: "viewer", workspaceId: WORKSPACE_A });
  const own = await get(PROJECT_A);
  assert.equal(own.status, 200, JSON.stringify(await own.clone().json()));
  assert.ok(decisions().some((d) => d.matchedPolicy === "project.read" && d.scope.projectId === PROJECT_A && d.allowed));

  resetWorld({ role: "viewer", workspaceId: WORKSPACE_A });
  await post(PROJECT_A);
  assert.ok(decisions().some((d) => d.matchedPolicy === "project_brain.converse" && d.scope.projectId === PROJECT_A), `expected project_brain.converse, got ${decisions().map((d) => d.matchedPolicy)}`);
  assert.ok(!decisions().some((d) => d.matchedPolicy === "workspace.read"), "Project Brain never authorizes through workspace.read");

  resetWorld({ role: "owner", workspaceId: WORKSPACE_A });
  assert.equal((await get(PROJECT_B)).status, 403, "workspace-A owner cannot read a workspace-B project");
  assert.equal((await post(PROJECT_B)).status, 403, "workspace-A owner cannot converse about a workspace-B project");
  assert.equal(world.writes.filter((w) => w.table.startsWith("context_")).length, 0, "denied Project Brain requests write no transcript");
});
