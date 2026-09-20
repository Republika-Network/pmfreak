import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  createVerifierFronteraOperator,
  isGenuineFronteraDecisionId,
  requireDisposableFronteraStore,
} from "./frontera-verifier-authority.mjs";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL;
const anonKey = process.env.OPERATIONAL_FLOW_TEST_ANON_KEY;
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY;
const appBaseUrl = process.env.OPERATIONAL_FLOW_TEST_BASE_URL?.replace(/\/$/, "");
const databaseUrl = process.env.OPERATIONAL_FLOW_TEST_DATABASE_URL;
const browserFixturePath = process.env.P2_08_BROWSER_FIXTURE_PATH;

if (
  !supabaseUrl ||
  !anonKey ||
  !serviceRoleKey ||
  !appBaseUrl ||
  !databaseUrl ||
  process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true"
) {
  console.error([
    "P2-08 live verification requires the disposable local PMFreak stack.",
    "Set OPERATIONAL_FLOW_TEST_SUPABASE_URL, OPERATIONAL_FLOW_TEST_ANON_KEY,",
    "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY, OPERATIONAL_FLOW_TEST_BASE_URL,",
    "OPERATIONAL_FLOW_TEST_DATABASE_URL and OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true.",
  ].join("\n"));
  process.exit(2);
}

for (const [name, target] of [
  ["Supabase API", supabaseUrl],
  ["PMFreak", appBaseUrl],
  ["PostgreSQL", databaseUrl],
]) {
  let host;
  try {
    host = new URL(target).hostname;
  } catch {
    console.error(`SAFETY ABORT: invalid ${name} URL.`);
    process.exit(2);
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    console.error(`SAFETY ABORT: ${name} must use a literal loopback host.`);
    process.exit(2);
  }
}

if (appBaseUrl !== "http://localhost:3000") {
  console.error("SAFETY ABORT: runtime origin must be http://localhost:3000.");
  process.exit(2);
}

// Governed dispatch passes the Frontera enforcement boundary (P0-PKG-06). Only
// the tenant-A owner dispatches in this verifier, so only the owner receives
// Frontera authority — out of band, for project A alone. Frontera governs the
// Action -> Task dispatch; the internal execution lifecycle below is unchanged
// PMFreak state and is not re-authorized per transition.
const fronteraOperator = createVerifierFronteraOperator({
  storePath: requireDisposableFronteraStore("P2-08"),
  operatorActorId: "operator-p2-08-verifier",
});

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const makeClient = () =>
  createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const password = `P2-08-${randomUUID()}!`;
const users = {};
let assertions = 0;

const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  assertions += 1;
};

async function createUser(label, workspaceId, role) {
  const email = `p2-08-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  const client = makeClient();
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  users[label] = { id: created.data.user.id, email, client, role, workspaceId };
}

async function loginCookie(email) {
  const form = new FormData();
  form.set("email", email);
  form.set("password", password);
  form.set("next", "/projects");
  const response = await fetch(`${appBaseUrl}/api/login`, {
    method: "POST",
    body: form,
    redirect: "manual",
  });
  const values =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  check(values.length > 0, "authenticated login must return cookies");
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function operational(cookie, body) {
  const response = await fetch(`${appBaseUrl}/api/operational-flow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function internalExecution(cookie, taskId, command) {
  const response = await fetch(`${appBaseUrl}/api/execution-tasks/internal-execution`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ taskId, command }),
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function getExecution(cookie, taskId) {
  const response = await fetch(
    `${appBaseUrl}/api/execution-tasks/internal-execution?taskId=${encodeURIComponent(taskId)}`,
    {
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(20_000),
    },
  );
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function makeDecision(cookie, workspaceId, projectId, keySuffix) {
  const now = new Date();
  const correlationId = randomUUID();

  const captured = await operational(cookie, {
    operation: "capture_input",
    workspaceId,
    projectId,
    // No sourceKey: the P2-14 review repair pins the DEMO / FIXTURE identity server-side,
    // and a caller-chosen key is now refused rather than silently accepted.
    idempotencyKey: `capture-${keySuffix}`,
    title: "DEMO / FIXTURE P2-08 internal execution",
    content: "A decision is needed before proceeding with this governed project change.",
    occurredAt: now.toISOString(),
    correlationId,
  });
  equal(captured.status, 201, "fixture input capture");

  const derived = await operational(cookie, {
    operation: "derive_evidence",
    workspaceId,
    projectId,
    normalizedEventId: captured.body.normalizedEvent.id,
    idempotencyKey: `evidence-${keySuffix}`,
    assertionType: "FACT",
    classification: "DECISION_CONTEXT",
    confidenceScore: 0.95,
    missingDataState: "COMPLETE",
    evaluatedAt: now.toISOString(),
  });
  equal(derived.status, 201, "fixture evidence derivation");

  const chain = await operational(cookie, {
    operation: "run_chain",
    workspaceId,
    projectId,
    evidenceItemId: derived.body.evidence.id,
  });
  equal(chain.status, 200, "fixture governance chain");

  const sourceSignalId = chain.body.chain?.[0]?.signal?.id;
  check(Boolean(sourceSignalId), "fixture chain materializes governed signal");

  const recommendation = await admin
    .from("recommended_actions")
    .select("id")
    .eq("project_id", projectId)
    .eq("source_signal_id", sourceSignalId)
    .not("governance_event_id", "is", null)
    .single();
  assert.ifError(recommendation.error);

  const decision = await operational(cookie, {
    operation: "record_decision",
    workspaceId,
    projectId,
    recommendationId: recommendation.data.id,
    decisionStatus: "accepted",
    decision: "DEMO / FIXTURE accepted P2-08 decision",
    rationale: "Controlled disposable local P2-08 verification.",
  });
  equal(decision.status, 201, "fixture decision record");

  return {
    decisionId: decision.body.decision.id,
    evidenceId: derived.body.evidence.id,
  };
}

async function proposeGovernedAction(cookie, workspaceId, projectId, keySuffix) {
  const decision = await makeDecision(cookie, workspaceId, projectId, keySuffix);
  const createdAt = new Date(Date.now() - 30_000);
  const evaluationTime = new Date(Date.now() - 20_000);
  const expiresAt = new Date(Date.now() + 60 * 60_000);

  const action = await operational(cookie, {
    operation: "propose_material_action",
    workspaceId,
    projectId,
    decisionId: decision.decisionId,
    idempotencyKey: `p2-08-action-${keySuffix}`,
    actionClass: "external_write",
    actionType: "internal_execution_demo",
    targetResourceType: "project_task",
    targetResourceId: projectId,
    intendedOperation: "internal_execution_only",
    intendedEffect: `P2-08 internal execution ${keySuffix}`,
    risk: "high",
    reversibility: "partially_reversible",
    sideEffect: "external",
    justification: "P2-08 disposable local verifier.",
    createdAt: createdAt.toISOString(),
    evaluationTime: evaluationTime.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  check([200, 201].includes(action.status), "governed Action created/replayed");

  return {
    decision,
    actionId: action.body.proposal.id,
    proposalDigest: action.body.proposal.proposal_digest,
  };
}

function dispatchGovernedAction(cookie, workspaceId, projectId, governed) {
  return operational(cookie, {
    operation: "dispatch_material_action_to_task",
    workspaceId,
    projectId,
    actionId: governed.actionId,
    expectedProposalDigest: governed.proposalDigest,
  });
}

async function createGovernedTask(cookie, workspaceId, projectId, keySuffix) {
  const governed = await proposeGovernedAction(cookie, workspaceId, projectId, keySuffix);
  return dispatchAuthorizedTask(cookie, workspaceId, projectId, governed);
}

async function dispatchAuthorizedTask(cookie, workspaceId, projectId, governed) {
  const task = await dispatchGovernedAction(cookie, workspaceId, projectId, governed);
  equal(task.status, 201, "P2-07 canonical Task created");
  equal(task.body.disposition, "created", "canonical Task disposition created");
  check(
    isGenuineFronteraDecisionId(task.body.fronteraDecisionId, governed.actionId),
    "canonical Task dispatch was ALLOWED by the real Frontera runtime",
  );
  check(Boolean(task.body.task?.id), "canonical Task has id");
  equal(await countTasksForAction(governed.actionId), 1, "authorized Action has exactly one Task");

  return {
    decision: governed.decision,
    actionId: governed.actionId,
    task: task.body.task,
    fronteraDecisionId: task.body.fronteraDecisionId,
  };
}

async function countTasksForAction(actionId) {
  const result = await admin
    .from("execution_tasks")
    .select("id", { count: "exact", head: true })
    .eq("source_payload->>source", "governed_action")
    .eq("source_payload->>sourceActionId", actionId);
  assert.ifError(result.error);
  return result.count ?? 0;
}

async function countExecutions(taskId) {
  const result = await admin
    .from("internal_task_executions")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId);
  assert.ifError(result.error);
  return result.count ?? 0;
}

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();

await createUser("owner", workspaceA, "owner");
await createUser("viewer", workspaceA, "viewer");
await createUser("outsider", workspaceB, "owner");

assert.ifError(
  (
    await admin.from("workspaces").insert([
      { id: workspaceA, name: `P2-08 DEMO A ${suffix}`, created_by_user_id: users.owner.id },
      { id: workspaceB, name: `P2-08 DEMO B ${suffix}`, created_by_user_id: users.outsider.id },
    ])
  ).error,
);

assert.ifError(
  (
    await admin.from("workspace_memberships").insert([
      { workspace_id: workspaceA, user_id: users.owner.id, role: "owner" },
      { workspace_id: workspaceA, user_id: users.viewer.id, role: "viewer" },
      { workspace_id: workspaceB, user_id: users.outsider.id, role: "owner" },
    ])
  ).error,
);

assert.ifError(
  (
    await admin.from("projects").insert([
      {
        id: projectA,
        workspace_id: workspaceA,
        user_id: users.owner.id,
        name: `P2-08 DEMO Project A ${suffix}`,
      },
      {
        id: projectB,
        workspace_id: workspaceB,
        user_id: users.outsider.id,
        name: `P2-08 DEMO Project B ${suffix}`,
      },
    ])
  ).error,
);

for (const label of ["owner", "viewer", "outsider"]) {
  const inviteId = randomUUID();
  assert.ifError(
    (
      await admin.from("early_access_invites").insert({
        id: inviteId,
        invite_email: users[label].email,
        invite_token_hash: randomUUID().replaceAll("-", ""),
        inviter_user_id: users[label].id,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
        accepted_at: new Date().toISOString(),
        workspace_id: users[label].workspaceId,
      })
    ).error,
  );
  assert.ifError(
    (
      await admin.from("trial_licenses").insert({
        invite_id: inviteId,
        workspace_id: users[label].workspaceId,
        trial_start_at: new Date(Date.now() - 60_000).toISOString(),
        trial_end_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
        trial_status: "active",
      })
    ).error,
  );
}

const ownerCookie = await loginCookie(users.owner.email);
const viewerCookie = await loginCookie(users.viewer.email);
const outsiderCookie = await loginCookie(users.outsider.email);

// This run's organizations are fresh, so the shared store holds nothing for them.
for (const label of ["owner", "viewer", "outsider"]) {
  for (const workspaceId of [workspaceA, workspaceB]) {
    equal(
      await fronteraOperator.binding({ workspaceId, principalUserId: users[label].id }),
      null,
      `Frontera store starts with no ${label} binding`,
    );
  }
}

// An owner role is not Frontera authority: before the operator acts, the same
// executable Action is refused at the boundary and nothing is written. The
// ALLOW that follows therefore also proves the running app reads THIS store.
const lifecycleAction = await proposeGovernedAction(
  ownerCookie,
  workspaceA,
  projectA,
  `lifecycle-${suffix}`,
);
const unboundDispatch = await dispatchGovernedAction(ownerCookie, workspaceA, projectA, lifecycleAction);
equal(unboundDispatch.status, 409, "unbound owner dispatch refused");
equal(unboundDispatch.body.failureClass, "frontera_actor_unbound", "unbound owner refused by Frontera");
equal(unboundDispatch.body.reason, "frontera_enforcement_denied", "refusal happens at the Frontera boundary");
equal(await countTasksForAction(lifecycleAction.actionId), 0, "unbound owner creates zero Tasks");

await fronteraOperator.provision({
  workspaceId: workspaceA,
  principalUserId: users.owner.id,
  projectId: projectA,
});

const lifecycle = await dispatchAuthorizedTask(ownerCookie, workspaceA, projectA, lifecycleAction);
equal(await countExecutions(lifecycle.task.id), 0, "governed Task begins with zero execution rows");

const dispatchReplay = await dispatchGovernedAction(ownerCookie, workspaceA, projectA, lifecycleAction);
equal(dispatchReplay.status, 200, "dispatch replay returns the existing Task");
equal(dispatchReplay.body.task?.id, lifecycle.task.id, "dispatch replay returns the same Task id");
equal(await countTasksForAction(lifecycle.actionId), 1, "dispatch replay creates no second Task");
equal(await countExecutions(lifecycle.task.id), 0, "dispatch replay creates no execution");

const queued = await internalExecution(ownerCookie, lifecycle.task.id, "queue");
equal(queued.status, 201, "queue creates internal execution");
equal(queued.body.execution.status, "queued", "execution is queued");
equal(await countExecutions(lifecycle.task.id), 1, "queue creates exactly one execution");

const queueReplay = await internalExecution(ownerCookie, lifecycle.task.id, "queue");
equal(queueReplay.status, 200, "queue replay succeeds");
equal(queueReplay.body.execution.id, queued.body.execution.id, "queue replay returns same execution");
equal(await countExecutions(lifecycle.task.id), 1, "queue replay remains one execution");

let transition = await internalExecution(ownerCookie, lifecycle.task.id, "start");
equal(transition.status, 200, "start succeeds");
equal(transition.body.execution.status, "running", "execution running");
equal(transition.body.task.status, "in_progress", "Task synchronized to in_progress");

transition = await internalExecution(ownerCookie, lifecycle.task.id, "block");
equal(transition.status, 200, "block succeeds");
equal(transition.body.execution.status, "blocked", "execution blocked");
equal(transition.body.task.status, "blocked", "Task synchronized to blocked");

transition = await internalExecution(ownerCookie, lifecycle.task.id, "start");
equal(transition.status, 200, "resume succeeds");
equal(transition.body.execution.status, "running", "execution resumed");

transition = await internalExecution(ownerCookie, lifecycle.task.id, "fail");
equal(transition.status, 200, "fail succeeds");
equal(transition.body.execution.status, "failed", "execution failed");
equal(transition.body.task.status, "blocked", "failed active Task is blocked");

const failedAttempt = transition.body.execution.attempt_count;
transition = await internalExecution(ownerCookie, lifecycle.task.id, "retry");
equal(transition.status, 200, "retry succeeds");
equal(transition.body.execution.status, "queued", "retry returns execution to queued");
equal(transition.body.execution.attempt_count, failedAttempt + 1, "retry increments attempt once");

const retryReplay = await internalExecution(ownerCookie, lifecycle.task.id, "retry");
equal(retryReplay.status, 200, "retry replay succeeds");
equal(retryReplay.body.execution.attempt_count, failedAttempt + 1, "retry replay does not increment twice");

transition = await internalExecution(ownerCookie, lifecycle.task.id, "start");
equal(transition.body.execution.status, "running", "retried execution starts");

transition = await internalExecution(ownerCookie, lifecycle.task.id, "complete");
equal(transition.status, 200, "complete succeeds");
equal(transition.body.execution.status, "completed", "execution completed");
equal(transition.body.task.status, "completed", "Task synchronized to completed");
equal(transition.body.task.progress_percent, 100, "Task progress is 100");
check(Boolean(transition.body.task.completed_at), "Task completed_at set");
equal(transition.body.nonOutcome.outcomeCreated, false, "completion does not create Outcome");
const outcomesAfterCompletion = await admin
  .from("canonical_task_outcomes")
  .select("id", { count: "exact", head: true })
  .eq("task_id", lifecycle.task.id);
assert.ifError(outcomesAfterCompletion.error);
equal(outcomesAfterCompletion.count ?? 0, 0, "completion persists zero canonical Outcomes");

const completedReplay = await internalExecution(ownerCookie, lifecycle.task.id, "complete");
equal(completedReplay.status, 200, "complete replay succeeds");
equal(completedReplay.body.execution.id, queued.body.execution.id, "complete replay same execution id");

for (const concurrency of [2, 5, 10]) {
  const fixture = await createGovernedTask(
    ownerCookie,
    workspaceA,
    projectA,
    `concurrency-${concurrency}-${suffix}`,
  );
  const responses = await Promise.all(
    Array.from({ length: concurrency }, () =>
      internalExecution(ownerCookie, fixture.task.id, "queue"),
    ),
  );
  check(
    responses.every((entry) => [200, 201].includes(entry.status)),
    `${concurrency} concurrent queue requests converge`,
  );
  const executionIds = new Set(
    responses.map((entry) => entry.body.execution?.id).filter(Boolean),
  );
  equal(executionIds.size, 1, `${concurrency} concurrent queue requests return one execution id`);
  equal(await countExecutions(fixture.task.id), 1, `${concurrency} concurrent queue requests persist one row`);
  console.log(`CONCURRENCY ${concurrency}: one execution ${[...executionIds][0]}`);
}

const revokeBefore = await createGovernedTask(
  ownerCookie,
  workspaceA,
  projectA,
  `revoke-before-${suffix}`,
);
const revokedBeforeResult = await operational(ownerCookie, {
  operation: "revoke_material_action",
  workspaceId: workspaceA,
  projectId: projectA,
  actionId: revokeBefore.actionId,
  evaluationTime: new Date().toISOString(),
  reasonCode: "p2_08_revoked_before_queue",
});
check([200, 201].includes(revokedBeforeResult.status), "revocation before queue recorded");

const queueAfterRevoke = await internalExecution(ownerCookie, revokeBefore.task.id, "queue");
equal(queueAfterRevoke.status, 409, "revoked before queue denied");
equal(queueAfterRevoke.body.governanceState, "revoked", "revoked state preserved");
equal(await countExecutions(revokeBefore.task.id), 0, "revoked before queue creates zero execution rows");

const revokeAfterQueue = await createGovernedTask(
  ownerCookie,
  workspaceA,
  projectA,
  `revoke-after-${suffix}`,
);
const queuedBeforeRevoke = await internalExecution(ownerCookie, revokeAfterQueue.task.id, "queue");
equal(queuedBeforeRevoke.status, 201, "queue before revocation succeeds");

const revokedAfterResult = await operational(ownerCookie, {
  operation: "revoke_material_action",
  workspaceId: workspaceA,
  projectId: projectA,
  actionId: revokeAfterQueue.actionId,
  evaluationTime: new Date().toISOString(),
  reasonCode: "p2_08_revoked_after_queue",
});
check([200, 201].includes(revokedAfterResult.status), "revocation after queue recorded");

const startAfterRevoke = await internalExecution(ownerCookie, revokeAfterQueue.task.id, "start");
equal(startAfterRevoke.status, 409, "revoked queued execution cannot start");
equal(startAfterRevoke.body.governanceState, "revoked", "start denial preserves revoked state");
equal(startAfterRevoke.body.executionState, "queued", "queued history preserved after revocation");
equal(await countExecutions(revokeAfterQueue.task.id), 1, "historical queued execution remains");

// Revocation is TERMINAL, and it is not a race between timestamps.
//
// `evaluated_at` is a descriptive time supplied by the writer — the revoke API accepts one
// from the caller, while a proposal's authorization is stamped separately server-side — so
// it cannot order two independent transactions. Selecting governance by
// `order by evaluated_at desc` alone therefore let a committed, visible revocation be
// masked by an authorization that merely sorted newer, and a revoked queued execution
// could still start.
//
// The revocation here is recorded with a descriptive time deliberately EARLIER than the
// authorization it revokes. No sleep and no retry: the revoke response is awaited and the
// persisted rows are read back before `start`, so the only question under test is whether
// existence beats recency.
const inverted = await createGovernedTask(
  ownerCookie,
  workspaceA,
  projectA,
  `revoke-inverted-${suffix}`,
);
const invertedQueued = await internalExecution(ownerCookie, inverted.task.id, "queue");
equal(invertedQueued.status, 201, "inverted-timestamp fixture queues before revocation");

const invertedAuthorization = await admin
  .from("material_action_governance_evaluations")
  .select("id,governance_state,evaluated_at")
  .eq("action_id", inverted.actionId)
  .eq("governance_state", "authorized")
  .single();
assert.ifError(invertedAuthorization.error);
const invertedAuthorizedAt = new Date(invertedAuthorization.data.evaluated_at);

const invertedRevoke = await operational(ownerCookie, {
  operation: "revoke_material_action",
  workspaceId: workspaceA,
  projectId: projectA,
  actionId: inverted.actionId,
  evaluationTime: new Date(invertedAuthorizedAt.getTime() - 1_000).toISOString(),
  reasonCode: "p2_08_terminal_revocation_inverted_timestamps",
});
check([200, 201].includes(invertedRevoke.status), "inverted-timestamp revocation recorded");

// The revocation is durable and visible BEFORE start is attempted, and it really does sort
// older than the authorization — otherwise this scenario would prove nothing.
const invertedEvaluations = await admin
  .from("material_action_governance_evaluations")
  .select("governance_state,evaluated_at")
  .eq("action_id", inverted.actionId);
assert.ifError(invertedEvaluations.error);
const invertedRevokedRow = invertedEvaluations.data.find((row) => row.governance_state === "revoked");
check(Boolean(invertedRevokedRow), "inverted-timestamp revocation is persisted before start");
check(
  new Date(invertedRevokedRow.evaluated_at) < invertedAuthorizedAt,
  "the revocation deliberately sorts OLDER than the authorization it revokes",
);
check(
  [...invertedEvaluations.data].sort((a, b) => String(b.evaluated_at).localeCompare(String(a.evaluated_at)))[0]
    .governance_state === "authorized",
  "recency ordering alone would select the authorization",
);

const invertedStart = await internalExecution(ownerCookie, inverted.task.id, "start");
equal(invertedStart.status, 409, "revoked queued execution cannot start despite a newer authorization timestamp");
equal(invertedStart.body.governanceState, "revoked", "terminal revocation reports the revoked state");
equal(invertedStart.body.executionState, "queued", "queued history preserved under terminal revocation");
equal(await countExecutions(inverted.task.id), 1, "terminal revocation adds no execution row");
const invertedExecution = await getExecution(ownerCookie, inverted.task.id);
equal(
  invertedExecution.body.execution.status,
  "queued",
  "terminally revoked execution never transitioned to running",
);

const anonymous = await internalExecution(null, revokeAfterQueue.task.id, "start");
equal(anonymous.status, 401, "anonymous execution command rejected");

const viewer = await internalExecution(viewerCookie, lifecycle.task.id, "queue");
equal(viewer.status, 403, "viewer execution command rejected");

const crossTenant = await getExecution(outsiderCookie, lifecycle.task.id);
equal(crossTenant.status, 404, "cross-tenant execution lookup is non-disclosing");
equal(crossTenant.body.failureClass, "not_found", "cross-tenant lookup does not leak Task existence");

const directTaskMutation = await users.owner.client
  .from("execution_tasks")
  .update({ status: "in_progress" })
  .eq("id", revokeAfterQueue.task.id);
check(Boolean(directTaskMutation.error), "direct governed Task lifecycle mutation rejected");

const legacyUpdateResponse = await fetch(`${appBaseUrl}/api/execution-tasks/update`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: ownerCookie },
  body: JSON.stringify({ taskId: revokeAfterQueue.task.id, status: "in_progress" }),
});
const legacyUpdateBody = await legacyUpdateResponse.json().catch(() => ({}));
equal(legacyUpdateResponse.status, 409, "legacy status API rejects governed Task lifecycle");
equal(
  legacyUpdateBody.failureClass,
  "governed_task_status_requires_internal_execution",
  "legacy API returns explicit governed lifecycle failure",
);

const detailPatchResponse = await fetch(
  `${appBaseUrl}/api/execution-tasks/${encodeURIComponent(revokeAfterQueue.task.id)}`,
  {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ status: "in_progress" }),
  },
);
const detailPatchBody = await detailPatchResponse.json().catch(() => ({}));
equal(detailPatchResponse.status, 409, "task detail PATCH rejects governed lifecycle mutation");
equal(
  detailPatchBody.failureClass,
  "governed_task_status_requires_internal_execution",
  "task detail PATCH returns explicit governed lifecycle failure",
);

const forgedExecution = await users.owner.client.from("internal_task_executions").insert({
  workspace_id: workspaceA,
  project_id: projectA,
  task_id: revokeAfterQueue.task.id,
  source_action_id: revokeAfterQueue.actionId,
  governance_evaluation_id: randomUUID(),
  provider_key: "pmfreak/internal-state-machine:v1",
  status: "queued",
  attempt_count: 1,
  idempotency_key: `forged-${suffix}`,
  correlation_id: `forged-${suffix}`,
  queued_at: new Date().toISOString(),
  last_transition_at: new Date().toISOString(),
  dispatched_by: users.owner.id,
});
check(Boolean(forgedExecution.error), "direct internal execution insert rejected");

const forgedEvent = await users.owner.client.from("execution_task_events").insert({
  workspace_id: workspaceA,
  project_id: projectA,
  task_id: revokeAfterQueue.task.id,
  event_type: "internal_execution_started",
  event_payload: { forged: true },
  actor_user_id: users.owner.id,
});
check(Boolean(forgedEvent.error), "forged internal execution audit event rejected");

const events = await admin
  .from("execution_task_events")
  .select("event_type,event_payload")
  .eq("task_id", lifecycle.task.id)
  .order("created_at", { ascending: true });
assert.ifError(events.error);

for (const eventType of [
  "internal_execution_queued",
  "internal_execution_started",
  "internal_execution_blocked",
  "internal_execution_failed",
  "internal_execution_retried",
  "internal_execution_completed",
]) {
  check(events.data.some((event) => event.event_type === eventType), `${eventType} audit event exists`);
}

check(
  events.data
    .filter((event) => event.event_type.startsWith("internal_execution_"))
    .every((event) => event.event_payload.outcomeCreated === false),
  "all internal execution audit events explicitly deny Outcome creation",
);

const finalRead = await getExecution(ownerCookie, lifecycle.task.id);
equal(finalRead.status, 200, "owner can read execution");
equal(finalRead.body.execution.status, "completed", "persisted execution read is completed");

if (browserFixturePath) {
  const browserReady = await createGovernedTask(
    ownerCookie,
    workspaceA,
    projectA,
    `browser-${suffix}`,
  );
  const browserQueued = await internalExecution(ownerCookie, browserReady.task.id, "queue");
  equal(browserQueued.status, 201, "browser fixture queues authorized internal execution");
  equal(browserQueued.body.execution.status, "queued", "browser fixture starts queued");

  writeFileSync(
    browserFixturePath,
    JSON.stringify(
      {
        appBaseUrl,
        email: users.owner.email,
        password,
        workspaceId: workspaceA,
        projectId: projectA,
        taskId: browserReady.task.id,
        queuedTaskId: browserReady.task.id,
        queuedExecutionId: browserQueued.body.execution.id,
        revokedQueuedTaskId: revokeAfterQueue.task.id,
        note:
          "Disposable local P2-08 fixture. queuedTaskId is authorized and queued for the full UI lifecycle. revokedQueuedTaskId is intentionally revoked after queue for denied-Start UI proof.",
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`BROWSER FIXTURE: ${browserFixturePath}`);
}

console.log(`P2-08 DB verification PASS (${assertions} assertions).`);
console.log(`LINEAGE Task ${lifecycle.task.id}`);
console.log(`  -> Action ${lifecycle.actionId}`);
console.log(`  -> Decision ${lifecycle.decision.decisionId}`);
console.log(`  -> Evidence ${lifecycle.decision.evidenceId}`);
console.log(`  -> Internal Execution ${queued.body.execution.id}`);
console.log("NO-OUTCOME: internal execution completion reported outcomeCreated=false.");
console.log(`FRONTERA ALLOW: ${lifecycle.fronteraDecisionId} (owner, project A); before provisioning: frontera_actor_unbound, zero Tasks.`);