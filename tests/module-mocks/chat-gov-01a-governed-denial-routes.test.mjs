/**
 * CHAT-GOV-01a — governed denial legibility, route contract.
 *
 * Executes the REAL POST handlers of `/api/operational-flow` (`dispatch_material_action_to_task`)
 * and `/api/execution-tasks/internal-execution` with only the transport faked: `next/headers`
 * cookies and the `@supabase/ssr` client. The fake client answers auth, the scope reads and the
 * canonical RPCs exactly as PostgREST does.
 *
 * Two Frontera modes are exercised through ONE file-level mock of the Frontera barrel:
 *   - `fronteraVerdict = null` delegates to the REAL adapter, so an unconfigured or unusable
 *     store proves fail-closed without any stub verdict;
 *   - a fixed verdict proves each failure-class mapping and that an ALLOW still reaches the
 *     unchanged canonical RPC.
 * The mocks are installed once, before the routes are first imported, because the route
 * modules are cached for the rest of the file.
 *
 * Own `node --test` file for the same process-isolation reason as every file in this folder.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH;

const USER_ID = "user-owner-1";
const WORKSPACE_ID = "ws-1";
const PROJECT_ID = "pr-1";
const ACTION_ID = "act-1";
const TASK_ID = "task-1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the fake PostgREST answers for the next canonical RPC. */
let nextRpc = { data: null, error: { message: "unset" } };
const rpcCalls = [];

function createServerClient() {
  const scopeRow = (table) => {
    if (table === "projects") return { id: PROJECT_ID, workspace_id: WORKSPACE_ID };
    if (table === "workspace_memberships") return { role: "owner" };
    if (table === "execution_tasks") {
      return {
        id: TASK_ID, workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, status: "not_started",
        source_payload: { source: "governed_action", sourceActionId: ACTION_ID },
      };
    }
    return null;
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: USER_ID, email: "owner@example.test", user_metadata: {} } }, error: null }),
    },
    from: (table) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: scopeRow(table), error: null }),
      };
      return chain;
    },
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return nextRpc;
    },
  };
}

/** Frontera verdict returned by the mocked barrel. `null` = do not mock; use the real adapter. */
let fronteraVerdict = null;
const fronteraCalls = [];

mock.module(resolveMockTarget("next/headers"), mockModuleOptions({ cookies: async () => makeCookieJar({ writesSucceed: true }), headers: async () => ({ get: () => null }) }));
mock.module(resolveMockTarget("@supabase/ssr"), mockModuleOptions({ createServerClient }));
const realFrontera = await import("../../src/lib/integrations/frontera/index.ts");
mock.module(resolveMockTarget("../../src/lib/integrations/frontera/index.ts"), mockModuleOptions({
  ...realFrontera,
  authorizeFronteraDispatch: async (request, deps) => {
    fronteraCalls.push(request);
    return fronteraVerdict === null ? realFrontera.authorizeFronteraDispatch(request, deps) : fronteraVerdict;
  },
}));
const { POST: operationalFlowPost } = await import("../../src/app/api/operational-flow/route.ts");
const { POST: internalExecutionPost } = await import("../../src/app/api/execution-tasks/internal-execution/route.ts");

async function dispatch(_t, { mockedFrontera }) {
  if (!mockedFrontera) fronteraVerdict = null;
  const POST = operationalFlowPost;
  const response = await POST(new Request("http://localhost:3000/api/operational-flow", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "dispatch_material_action_to_task", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, actionId: ACTION_ID }),
  }));
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) };
}

async function execute(_t, command) {
  const POST = internalExecutionPost;
  const response = await POST(new Request("http://localhost:3000/api/execution-tasks/internal-execution", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: TASK_ID, command }),
  }));
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) };
}

const dispatchRpcCalls = () => rpcCalls.filter((call) => call.name === "dispatch_governed_action_to_internal_task");

/** Nothing internal may reach the browser: no Frontera reason code or diagnostic, no RPC or
 *  driver text, no configuration name, and no filesystem path. */
function assertNoLeak(raw, extra = []) {
  for (const leak of [
    /FRONTERA_[A-Z_]+/, /diagnostic/i, /reasonCodes/, /AOC_ENTERPRISE/, /SQLITE/i, /\.sqlite/i, /\.db\b/,
    /dispatch_governed_action_to_internal_task/, /transition_internal_task_execution/, /dispatch_internal_task_execution/,
    /not configured/i, /[A-Za-z]:\\\\/, /(?:^|[\s"'])\/(?:tmp|var|home|mnt|usr|etc)\//, /stack/i, /Operational flow action failed/,
    ...extra,
  ]) {
    assert.doesNotMatch(raw, leak, `response body must not contain ${leak}`);
  }
}

function assertGovernedRefusal(result, { status = 409, code, error, recovery }) {
  assert.equal(result.status, status, `expected ${status}, got ${result.status}: ${result.raw}`);
  assert.equal(result.body.code, code);
  if (error) assert.match(result.body.error, error);
  assert.equal(typeof result.body.error, "string");
  assert.ok(result.body.error.length > 0);
  if (recovery) assert.match(result.body.recovery, recovery);
  assert.equal(typeof result.body.recovery, "string");
  assert.match(result.body.referenceId, UUID, "referenceId is a server-minted opaque uuid");
}

// ─────────────── A / F: REAL adapter, fail-closed, nothing leaks ───────────────

test("A: unconfigured Frontera (real adapter) answers 409 frontera_unavailable with safe error, recovery and referenceId — and never reaches the RPC", async (t) => {
  delete process.env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH;
  rpcCalls.length = 0;
  const result = await dispatch(t, { mockedFrontera: false });
  assertGovernedRefusal(result, {
    code: "frontera_unavailable",
    error: /^The governance enforcement service is not available for this action\.$/,
    recovery: /Try again after the workspace governance service is available/,
  });
  assert.equal(result.body.disposition, "denied");
  assert.equal(result.body.failureClass, "frontera_unavailable");
  assert.equal(dispatchRpcCalls().length, 0, "fail closed: the canonical RPC was never called");
  assertNoLeak(result.raw);
});

test("F: a configured but unusable store path never appears in the response", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "chat-gov-01a-"));
  const sentinel = path.join(dir, "sentinel-secret-dir", "authority-SENTINEL.sqlite");
  process.env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH = sentinel;
  rpcCalls.length = 0;
  try {
    const result = await dispatch(t, { mockedFrontera: false });
    // Which fail-closed class depends on the host (an unloadable native driver answers
    // unavailable; a loadable one opens an empty store and answers unbound). Both refuse.
    assert.equal(result.status, 409);
    assert.ok(["frontera_unavailable", "frontera_actor_unbound"].includes(result.body.code), result.raw);
    assert.equal(dispatchRpcCalls().length, 0, "fail closed: the canonical RPC was never called");
    assertNoLeak(result.raw, [/SENTINEL/i, /sentinel-secret-dir/, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))]);
  } finally {
    delete process.env.AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────── B / C: each Frontera class has its own copy ───────────────

test("B: frontera_actor_unbound maps to the provisioning message, not the generic one", async (t) => {
  fronteraVerdict = { allowed: false, failureClass: "frontera_actor_unbound", reasonCodes: ["FRONTERA_ACTOR_UNBOUND"] };
  rpcCalls.length = 0;
  const result = await dispatch(t, { mockedFrontera: true });
  assertGovernedRefusal(result, {
    code: "frontera_actor_unbound",
    error: /^Your account is not provisioned to dispatch this governed action\.$/,
    recovery: /Ask a workspace administrator to review your execution authority/,
  });
  assert.equal(dispatchRpcCalls().length, 0);
  assertNoLeak(result.raw);
});

test("C: frontera_denied maps to the boundary-refusal message and never exposes Frontera reason codes or decision ids", async (t) => {
  fronteraVerdict = { allowed: false, failureClass: "frontera_denied", reasonCodes: ["POLICY_X_DENIED_INTERNAL"], decisionId: "frontera-decision-SECRET" };
  rpcCalls.length = 0;
  const result = await dispatch(t, { mockedFrontera: true });
  assertGovernedRefusal(result, {
    code: "frontera_denied",
    error: /^The governance enforcement boundary refused this action\.$/,
    recovery: /Review the action's authority and policy requirements/,
  });
  assert.equal(dispatchRpcCalls().length, 0);
  assertNoLeak(result.raw, [/POLICY_X_DENIED_INTERNAL/, /frontera-decision-SECRET/]);
});

test("C: a Frontera diagnostic carrying a path stays server-side", async (t) => {
  fronteraVerdict = {
    allowed: false, failureClass: "frontera_unavailable", reasonCodes: ["FRONTERA_EVALUATION_UNAVAILABLE"],
    diagnostic: "unable to open database file /var/secret/authority.sqlite",
  };
  const result = await dispatch(t, { mockedFrontera: true });
  assertGovernedRefusal(result, { code: "frontera_unavailable" });
  assertNoLeak(result.raw, [/\/var\/secret/, /unable to open/]);
});

// ─────────────── D / E: canonical-contract refusals keep distinct meanings ───────────────

const ALLOW = { allowed: true, decisionId: "frontera-decision-1", reasonCodes: ["ALLOWED"], fronteraActorId: "fa-1", trustDomainId: "td-1" };

test("D: an expired authorization maps to authorization_expired with replacement guidance", async (t) => {
  fronteraVerdict = ALLOW;
  nextRpc = { data: { disposition: "denied", failureClass: "expired", reason: "action_expired" }, error: null };
  const result = await dispatch(t, { mockedFrontera: true });
  assertGovernedRefusal(result, {
    code: "authorization_expired",
    error: /^This governed action authorization has expired\.$/,
    recovery: /Request a replacement governed material action/,
  });
  assert.equal(result.body.failureClass, "expired", "the contract's own failure class is kept for existing callers");
  assert.equal(result.body.reason, "action_expired");
  assertNoLeak(result.raw);
});

test("D: a revoked authorization maps to authorization_revoked, not to a generic not-permitted", async (t) => {
  fronteraVerdict = ALLOW;
  nextRpc = { data: { disposition: "denied", failureClass: "governance_not_dispatchable", governanceState: "revoked", reason: "governed_action_not_dispatchable" }, error: null };
  const result = await dispatch(t, { mockedFrontera: true });
  assertGovernedRefusal(result, { code: "authorization_revoked", error: /was revoked/ });
  assert.equal(result.body.governanceState, "revoked");
});

test("D: a non-revoked ineligible governance state is not reported as revoked", async (t) => {
  fronteraVerdict = ALLOW;
  nextRpc = { data: { disposition: "denied", failureClass: "governance_not_dispatchable", governanceState: "requires_approval", reason: "governed_action_not_dispatchable" }, error: null };
  const result = await dispatch(t, { mockedFrontera: true });
  assertGovernedRefusal(result, { code: "governance_not_permitted" });
  assert.doesNotMatch(result.body.error, /revoked/);
});

test("E: a proposal-digest conflict is a 409 conflict with reload guidance", async (t) => {
  fronteraVerdict = ALLOW;
  nextRpc = { data: { disposition: "conflict", failureClass: "idempotency_conflict", reason: "action_task_proposal_digest_conflict", actionId: ACTION_ID, proposalDigest: "a".repeat(64) }, error: null };
  const result = await dispatch(t, { mockedFrontera: true });
  assertGovernedRefusal(result, { code: "proposal_digest_conflict", recovery: /Reload/ });
  assert.equal(result.body.disposition, "conflict");
  assert.equal(result.body.actionId, ACTION_ID);
});

test("each distinct refusal gets a distinct referenceId", async (t) => {
  fronteraVerdict = ALLOW;
  nextRpc = { data: { disposition: "denied", failureClass: "expired", reason: "action_expired" }, error: null };
  const first = await dispatch(t, { mockedFrontera: true });
  const second = await dispatch(t, { mockedFrontera: true });
  assert.notEqual(first.body.referenceId, second.body.referenceId);
});

// ─────────────── J: success is unchanged, and the RPC invocation is unchanged ───────────────

test("J: an ALLOW reaches the unchanged canonical RPC and a created Task answers 201 exactly as before", async (t) => {
  fronteraVerdict = ALLOW;
  fronteraCalls.length = 0;
  rpcCalls.length = 0;
  nextRpc = { data: { disposition: "created", task: { id: TASK_ID, status: "not_started" }, sourceActionId: ACTION_ID }, error: null };
  const result = await dispatch(t, { mockedFrontera: true });
  assert.equal(result.status, 201);
  assert.equal(result.body.disposition, "created");
  assert.equal(result.body.task.id, TASK_ID);
  assert.equal(result.body.fronteraDecisionId, "frontera-decision-1");
  for (const key of ["error", "code", "recovery", "referenceId"]) assert.ok(!(key in result.body), `success carries no ${key}`);
  assert.deepEqual(fronteraCalls.at(-1), { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, principalUserId: USER_ID, actionId: ACTION_ID });
  assert.deepEqual(dispatchRpcCalls(), [{
    name: "dispatch_governed_action_to_internal_task",
    args: { p_workspace_id: WORKSPACE_ID, p_project_id: PROJECT_ID, p_action_id: ACTION_ID, p_expected_proposal_digest: null },
  }]);
});

test("J: a replay still answers 200 existing", async (t) => {
  fronteraVerdict = ALLOW;
  nextRpc = { data: { disposition: "existing", task: { id: TASK_ID }, sourceActionId: ACTION_ID, idempotentReplay: true }, error: null };
  const result = await dispatch(t, { mockedFrontera: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.disposition, "existing");
  assert.ok(!("error" in result.body));
});

// ─────────────── internal execution: same contract ───────────────

test("execution: a dispatcher mismatch is 409 with dispatcher guidance, keeps ok:false and executionState", async (t) => {
  nextRpc = { data: { disposition: "denied", failureClass: "actor_mismatch", reason: "internal_execution_actor_mismatch", executionState: "queued" }, error: null };
  const result = await execute(t, "start");
  assertGovernedRefusal(result, { code: "dispatcher_required", error: /Only the person who queued this internal execution/ });
  assert.equal(result.body.ok, false);
  assert.equal(result.body.executionState, "queued");
  assert.equal(result.body.failureClass, "actor_mismatch");
  assertNoLeak(result.raw);
});

test("execution: queue by a non-proposer is 409 with proposer guidance", async (t) => {
  nextRpc = { data: { disposition: "denied", failureClass: "actor_mismatch", reason: "governed_action_actor_mismatch" }, error: null };
  const result = await execute(t, "queue");
  assertGovernedRefusal(result, { code: "proposer_required" });
});

test("execution: an expired authorization on start is authorization_expired", async (t) => {
  nextRpc = { data: { disposition: "denied", failureClass: "expired", reason: "action_expired" }, error: null };
  const result = await execute(t, "start");
  assertGovernedRefusal(result, { code: "authorization_expired" });
});

test("execution: an invalid transition is 409 execution_transition_invalid", async (t) => {
  nextRpc = { data: { disposition: "denied", failureClass: "invalid_transition", executionState: "completed" }, error: null };
  const result = await execute(t, "complete");
  assertGovernedRefusal(result, { code: "execution_transition_invalid" });
});

test("execution: a persistence failure is 500 with a referenceId and no driver text", async (t) => {
  nextRpc = { data: null, error: { message: 'relation "internal_task_executions" violates constraint SECRET_CONSTRAINT' } };
  const result = await execute(t, "start");
  assert.equal(result.status, 500);
  assert.equal(result.body.error, "Unable to persist internal execution.");
  assert.match(result.body.referenceId, UUID);
  assertNoLeak(result.raw, [/SECRET_CONSTRAINT/, /relation/]);
});

test("execution: a successful transition is unchanged", async (t) => {
  nextRpc = { data: { disposition: "transitioned", execution: { id: "exec-1", status: "running" } }, error: null };
  const result = await execute(t, "start");
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.disposition, "transitioned");
  assert.ok(!("error" in result.body));
});
