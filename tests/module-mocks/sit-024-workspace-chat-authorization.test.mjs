/**
 * SIT-024 — Workspace Chat returned 403 Forbidden for an authenticated workspace member.
 *
 * Root cause: `requireWorkspaceMember(workspaceId)` asked the runtime for permission `read`
 * with no projectId, and the generic permission→action map resolved `read` to `project.read`.
 * `project.read` is (correctly) project-scoped, so the governance pipeline denied the request
 * with "project scope is missing for project-scoped action" BEFORE membership was consulted.
 *
 * These tests drive the real route through the real runtime authority, governance policy
 * registry and access-verification adapter; only the Supabase / next/headers transport is fake.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  governanceDecisions, installTransportFakes, resetWorld, world,
  PMO_A, PMO_B, PROJECT_A, WORKSPACE_A, WORKSPACE_B,
} from "./sit-024-workspace-read-fake.mjs";

const chatUrl = (query) => `http://localhost:3000/api/context-chat?${query}`;
const post = (body) => new Request("http://localhost:3000/api/context-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function load(t) {
  installTransportFakes(t);
  return import("../../src/app/api/context-chat/route.ts");
}

function lastDecision() {
  const decisions = governanceDecisions();
  return decisions[decisions.length - 1]?.decision ?? null;
}

for (const role of ["owner", "admin", "pm", "viewer"]) {
  test(`workspace chat GET: persisted ${role} member passes authorization via workspace.read`, async (t) => {
    const { GET } = await load(t);
    resetWorld({ role });
    const response = await GET(new Request(chatUrl("contextType=workspace")));
    const body = await response.json();
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
    assert.equal(body.contextId, `workspace:${WORKSPACE_A}`);
    assert.deepEqual(body.messages, []);

    const decision = lastDecision();
    assert.equal(decision.matchedPolicy, "workspace.read");
    assert.equal(decision.requiredPermission, "read");
    assert.equal(decision.allowed, true);
    assert.equal(decision.auditEventType, "governance_action_allowed");
    assert.equal(decision.scope.workspaceId, WORKSPACE_A);
    assert.equal(decision.scope.projectId, null);
    assert.ok(decision.trace.some((entry) => entry.rule === "workspace_membership_checked" && entry.result === "passed"), "membership must actually be checked");
  });
}

test("workspace chat POST: member's message is authorized and persisted with a deterministic reply", async (t) => {
  const { POST } = await load(t);
  resetWorld({ role: "viewer" });
  const response = await POST(post({ contextType: "workspace", message: "Generate an executive summary" }));
  const body = await response.json();
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(lastDecisionFor("workspace.read").allowed, true);
});

function lastDecisionFor(policy) {
  return governanceDecisions().map((d) => d.decision).filter((d) => d.matchedPolicy === policy).at(-1);
}

test("workspace chat: no membership at all → 400 workspace context (resolver) and no authorization bypass", async (t) => {
  const { GET } = await load(t);
  resetWorld({ role: null });
  const response = await GET(new Request(chatUrl("contextType=workspace")));
  assert.equal(response.status, 400);
  assert.equal(world.writes.filter((w) => w.table.startsWith("context_")).length, 0);
});

test("workspace chat: unauthenticated → 401", async (t) => {
  const { GET, POST } = await load(t);
  resetWorld();
  world.user = null;
  assert.equal((await GET(new Request(chatUrl("contextType=workspace")))).status, 401);
  assert.equal((await POST(post({ contextType: "workspace", message: "hi" }))).status, 401);
});

test("workspace chat: unsupported persisted membership role → 403, never allowed", async (t) => {
  const { GET } = await load(t);
  resetWorld({ role: "superuser" });
  const response = await GET(new Request(chatUrl("contextType=workspace")));
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.match(JSON.stringify(body), /unsupported_workspace_role/);
  assert.equal(lastDecision().matchedPolicy, "workspace.read");
  assert.equal(lastDecision().allowed, false);
});

test("pmo chat: PMO in the member's workspace → authorized via workspace.read", async (t) => {
  const { GET, POST } = await load(t);
  resetWorld({ role: "pm" });
  const response = await GET(new Request(chatUrl(`contextType=pmo&pmoId=${PMO_A}`)));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.contextId, `pmo:${PMO_A}`);
  assert.equal(lastDecision().matchedPolicy, "workspace.read");
  assert.equal(lastDecision().scope.workspaceId, WORKSPACE_A);

  const sent = await POST(post({ contextType: "pmo", pmoId: PMO_A, message: "Status?" }));
  assert.equal(sent.status, 200);
});

test("pmo chat: PMO in a foreign workspace → 403 (membership in A never answers for B)", async (t) => {
  const { GET, POST } = await load(t);
  resetWorld({ role: "owner", workspaceId: WORKSPACE_A });
  const response = await GET(new Request(chatUrl(`contextType=pmo&pmoId=${PMO_B}`)));
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.match(JSON.stringify(body), /missing_membership/);
  assert.equal(lastDecision().matchedPolicy, "workspace.read");
  assert.equal(lastDecision().scope.workspaceId, WORKSPACE_B);
  assert.equal((await POST(post({ contextType: "pmo", pmoId: PMO_B, message: "leak?" }))).status, 403);
  assert.equal(world.writes.filter((w) => w.table.startsWith("context_")).length, 0, "no conversation/message written for a denied scope");
});

test("pmo chat: unknown PMO → existing 404 contract", async (t) => {
  const { GET } = await load(t);
  resetWorld();
  const response = await GET(new Request(chatUrl("contextType=pmo&pmoId=00000000-0000-0000-0000-000000000000")));
  assert.equal(response.status, 404);
});

test("project scope on the legacy chat route still authorizes through project.read with a projectId", async (t) => {
  const { GET } = await load(t);
  resetWorld({ role: "viewer" });
  const response = await GET(new Request(chatUrl(`contextType=project&projectId=${PROJECT_A}`)));
  assert.equal(response.status, 410, "project chat is retired to Project Brain (PB-CHAT-01)");
  const decision = lastDecision();
  assert.equal(decision.matchedPolicy, "project.read");
  assert.equal(decision.scope.projectId, PROJECT_A);
  assert.ok(decision.trace.some((entry) => entry.rule === "project_binding_checked"));
});
