import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createVerifierFronteraOperator,
  isGenuineFronteraDecisionId,
  requireDisposableFronteraStore,
} from "./frontera-verifier-authority.mjs";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL;
const anonKey = process.env.OPERATIONAL_FLOW_TEST_ANON_KEY;
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY;
const appBaseUrl =
  process.env.OPERATIONAL_FLOW_TEST_BASE_URL?.replace(/\/$/, "");
const databaseUrl = process.env.OPERATIONAL_FLOW_TEST_DATABASE_URL;

if (
  !supabaseUrl ||
  !anonKey ||
  !serviceRoleKey ||
  !appBaseUrl ||
  !databaseUrl ||
  process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true"
) {
  console.error(
    [
      "P2-09 live verification requires the disposable local PMFreak stack.",
      "Set OPERATIONAL_FLOW_TEST_SUPABASE_URL, OPERATIONAL_FLOW_TEST_ANON_KEY,",
      "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY, OPERATIONAL_FLOW_TEST_BASE_URL,",
      "OPERATIONAL_FLOW_TEST_DATABASE_URL and OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true.",
    ].join("\n"),
  );
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
  console.error(
    "SAFETY ABORT: browser/runtime origin must be http://localhost:3000.",
  );
  process.exit(2);
}

// The governed Task this verifier observes is reached through the Frontera
// enforcement boundary (P0-PKG-06). Only the tenant-A owner dispatches, so only
// the owner receives Frontera authority — out of band, for project A alone.
// Frontera plays no part in Outcome or Observation semantics.
const fronteraOperator = createVerifierFronteraOperator({
  storePath: requireDisposableFronteraStore("P2-09"),
  operatorActorId: "operator-p2-09-verifier",
});

const { createClient } = await import("@supabase/supabase-js");

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const makeClient = () =>
  createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const password = `P2-09-${randomUUID()}!`;

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
  const email = `p2-09-${label}-${suffix}@example.test`;

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);

  const client = makeClient();

  const signedIn = await client.auth.signInWithPassword({
    email,
    password,
  });
  assert.ifError(signedIn.error);

  users[label] = {
    id: created.data.user.id,
    email,
    client,
    role,
    workspaceId,
  };

  return users[label];
}

async function api(cookie, body) {
  const response = await fetch(`${appBaseUrl}/api/operational-flow`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function authCookie(user) {
  const form = new FormData();
  form.set("email", user.email);
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

  check(
    values.length > 0,
    `${user.role} authenticated login returns cookies`,
  );

  return values
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function insertWorkspaceProject(workspaceId, projectId, ownerId) {
  const workspace = await admin.from("workspaces").insert({
    id: workspaceId,
    name: `P2-09 workspace ${suffix}`,
    created_by_user_id: ownerId,
  });

  assert.ifError(workspace.error);

  const project = await admin.from("projects").insert({
    id: projectId,
    workspace_id: workspaceId,
    user_id: ownerId,
    name: `P2-09 project ${suffix}`,
  });

  assert.ifError(project.error);
}

async function internalExecution(cookie, taskId, command) {
  const response = await fetch(
    `${appBaseUrl}/api/execution-tasks/internal-execution`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ taskId, command }),
      signal: AbortSignal.timeout(20_000),
    },
  );

  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function createGovernedTask(
  cookie,
  workspaceId,
  projectId,
  keySuffix,
  principalUserId,
) {
  const now = new Date().toISOString();
  const correlationId = randomUUID();

  const captured = await api(cookie, {
    operation: "capture_input",
    workspaceId,
    projectId,
    // No sourceKey: the P2-14 review repair pins the DEMO / FIXTURE identity server-side,
    // and a caller-chosen key is now refused rather than silently accepted.
    idempotencyKey: `capture-${keySuffix}`,
    title: "DEMO / FIXTURE P2-09 outcome observation",
    content: "A decision is needed before proceeding with this governed project change.",
    occurredAt: now,
    correlationId,
  });

  equal(captured.status, 201, "fixture input capture");

  const derived = await api(cookie, {
    operation: "derive_evidence",
    workspaceId,
    projectId,
    normalizedEventId: captured.body.normalizedEvent.id,
    idempotencyKey: `evidence-${keySuffix}`,
    assertionType: "FACT",
    classification: "DECISION_CONTEXT",
    confidenceScore: 0.95,
    missingDataState: "COMPLETE",
    evaluatedAt: now,
  });

  equal(derived.status, 201, "fixture evidence derivation");

  const chain = await api(cookie, {
    operation: "run_chain",
    workspaceId,
    projectId,
    evidenceItemId: derived.body.evidence.id,
  });

  equal(chain.status, 200, "fixture governance chain");

  const sourceSignalId = chain.body.chain?.[0]?.signal?.id;

  check(
    Boolean(sourceSignalId),
    "fixture governance chain must materialize a governed signal",
  );

  const recommendation = await admin
    .from("recommended_actions")
    .select("id")
    .eq("project_id", projectId)
    .eq("source_signal_id", sourceSignalId)
    .not("governance_event_id", "is", null)
    .single();

  assert.ifError(recommendation.error);

  const decision = await api(cookie, {
    operation: "record_decision",
    workspaceId,
    projectId,
    recommendationId: recommendation.data.id,
    decisionStatus: "accepted",
    decision: "DEMO / FIXTURE accepted P2-09 decision",
    rationale:
      "Controlled local P2-09 outcome-observation verification.",
  });

  equal(decision.status, 201, "fixture decision record");

  const proposed = await api(cookie, {
    operation: "propose_material_action",
    workspaceId,
    projectId,
    decisionId: decision.body.decision.id,
    idempotencyKey: `action-${keySuffix}`,
    actionClass: "external_write",
    actionType: "schedule_change_proposal",
    targetResourceType: "project_schedule",
    targetResourceId: projectId,
    intendedOperation: "propose_only",
    intendedEffect:
      "Apply the governed schedule change and later observe whether its expected operational result actually occurred.",
    risk: "high",
    reversibility: "partially_reversible",
    sideEffect: "external",
    justification: "P2-09 disposable local outcome-observation verifier.",
    createdAt: now,
    evaluationTime: now,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });

  equal(proposed.status, 201, "fixture material action proposal");

  const actionId = proposed.body.proposal?.id;
  const proposalDigest = proposed.body.proposal?.proposal_digest;

  check(Boolean(actionId), "material action id exists");
  check(Boolean(proposalDigest), "material action proposal digest exists");

  const dispatch = () =>
    api(cookie, {
      operation: "dispatch_material_action_to_task",
      workspaceId,
      projectId,
      actionId,
      expectedProposalDigest: proposalDigest,
    });

  // An owner role is not Frontera authority: refused, and nothing written,
  // until the operator provisions it out of band.
  const unbound = await dispatch();
  equal(unbound.status, 409, "unbound owner dispatch refused");
  equal(unbound.body.failureClass, "frontera_actor_unbound", "unbound owner refused by Frontera");
  equal(unbound.body.reason, "frontera_enforcement_denied", "refusal happens at the Frontera boundary");
  const tasksWhileUnbound = await admin
    .from("execution_tasks")
    .select("id", { count: "exact", head: true })
    .eq("source_payload->>sourceActionId", actionId);
  assert.ifError(tasksWhileUnbound.error);
  equal(tasksWhileUnbound.count ?? 0, 0, "unbound owner creates zero Tasks");

  await fronteraOperator.provision({
    workspaceId,
    principalUserId,
    projectId,
  });

  const taskCreated = await dispatch();

  equal(taskCreated.status, 201, "fixture governed Task creation");
  check(
    isGenuineFronteraDecisionId(taskCreated.body.fronteraDecisionId, actionId),
    "governed Task dispatch was ALLOWED by the real Frontera runtime",
  );

  const task =
    taskCreated.body.task ??
    taskCreated.body.executionTask;

  check(Boolean(task?.id), "governed Task id exists");

  return {
    task,
    actionId,
    decisionId: decision.body.decision.id,
    evidenceId: derived.body.evidence.id,
    fronteraDecisionId: taskCreated.body.fronteraDecisionId,
  };
}

async function ensureOutcome(client, workspaceId, projectId, taskId) {
  return client.rpc("ensure_expected_task_outcome", {
    p_workspace_id: workspaceId,
    p_project_id: projectId,
    p_task_id: taskId,
    p_expected_result:
      "The governed operational change produces the explicitly expected project result.",
    p_success_criteria: [
      {
        criterion:
          "Evidence demonstrates that the expected operational result occurred.",
      },
    ],
    p_correlation_id: `p2-09-${suffix}`,
    p_causation_id: taskId,
  });
}

async function recordObservation(
  client,
  {
    workspaceId,
    projectId,
    outcomeId,
    observationState,
    summary,
    evidenceIds,
    idempotencyKey,
    observedAt,
    evaluatedAt,
    staleAt,
  },
) {
  const now = new Date();
  const obsTime = observedAt ?? now.toISOString();
  const evalTime = evaluatedAt ?? now.toISOString();
  const staleTime =
    staleAt !== undefined
      ? staleAt
      : new Date(now.getTime() + 60 * 60 * 1000).toISOString();

  return client.rpc("record_canonical_outcome_observation", {
    p_workspace_id: workspaceId,
    p_project_id: projectId,
    p_outcome_id: outcomeId,
    p_observation_state: observationState,
    p_summary: summary,
    p_evidence_reference_ids: evidenceIds,
    p_confidence_score: 0.95,
    p_missing_data_state: "COMPLETE",
    p_observed_at: obsTime,
    p_evaluated_at: evalTime,
    p_stale_at: staleTime,
    p_correlation_id: `p2-09-observation-${suffix}`,
    p_causation_id: outcomeId,
    p_idempotency_key: idempotencyKey,
  });
}

async function captureLiveInput(
  client,
  {
    workspaceId,
    projectId,
    sourceKey,
    idempotencyKey,
    title,
    content,
    occurredAt,
    correlationId,
    causationId,
    externalId,
  },
) {
  return client.rpc("capture_live_operational_input", {
    p_workspace_id: workspaceId,
    p_project_id: projectId,
    p_source_key: sourceKey,
    p_idempotency_key: idempotencyKey,
    p_title: title,
    p_content: content,
    p_occurred_at: occurredAt,
    p_correlation_id: correlationId,
    p_causation_id: causationId || null,
    p_external_id: externalId || null,
  });
}

async function deriveLiveEvidence(
  client,
  {
    workspaceId,
    projectId,
    normalizedEventId,
    idempotencyKey,
    assertionType,
    classification,
    confidenceScore,
    missingDataState,
    evaluatedAt,
    staleAt,
  },
) {
  return client.rpc("derive_operational_evidence", {
    p_workspace_id: workspaceId,
    p_project_id: projectId,
    p_normalized_event_id: normalizedEventId,
    p_idempotency_key: idempotencyKey,
    p_assertion_type: assertionType,
    p_classification: classification,
    p_confidence_score: confidenceScore,
    p_missing_data_state: missingDataState,
    p_evaluated_at: evaluatedAt,
    p_stale_at: staleAt || null,
  });
}

const workspaceA = randomUUID();
const projectA = randomUUID();
const workspaceB = randomUUID();
const projectB = randomUUID();

const owner = await createUser("owner", workspaceA, "owner");
const viewer = await createUser("viewer", workspaceA, "viewer");
const outsider = await createUser("outsider", workspaceB, "owner");

await insertWorkspaceProject(workspaceA, projectA, owner.id);
await insertWorkspaceProject(workspaceB, projectB, outsider.id);

const membershipOwner = await admin.from("workspace_memberships").insert({
  workspace_id: workspaceA,
  user_id: owner.id,
  role: "owner",
});
assert.ifError(membershipOwner.error);

const membershipViewer = await admin.from("workspace_memberships").insert({
  workspace_id: workspaceA,
  user_id: viewer.id,
  role: "viewer",
});
assert.ifError(membershipViewer.error);

const membershipOutsider = await admin.from("workspace_memberships").insert({
  workspace_id: workspaceB,
  user_id: outsider.id,
  role: "owner",
});
assert.ifError(membershipOutsider.error);

const ownerCookie = await authCookie(owner);

// This run's organizations are fresh, so the shared store holds nothing for them.
for (const actor of [owner, viewer, outsider]) {
  for (const workspaceId of [workspaceA, workspaceB]) {
    equal(
      await fronteraOperator.binding({ workspaceId, principalUserId: actor.id }),
      null,
      `Frontera store starts with no ${actor.role} binding`,
    );
  }
}

/*
 * Step 1: Build the governed Task using canonical P2-08 execution lineage.
 */
const governed = await createGovernedTask(
  ownerCookie,
  workspaceA,
  projectA,
  suffix,
  owner.id,
);

const queuedExecution = await internalExecution(
  ownerCookie,
  governed.task.id,
  "queue",
);

check(
  [200, 201].includes(queuedExecution.status),
  "canonical governed Task queues",
);

const startedExecution = await internalExecution(
  ownerCookie,
  governed.task.id,
  "start",
);

check(
  [200, 201].includes(startedExecution.status),
  "canonical governed Task starts",
);

const completedExecution = await internalExecution(
  ownerCookie,
  governed.task.id,
  "complete",
);

check(
  [200, 201].includes(completedExecution.status),
  "canonical governed Task completes",
);

/*
 * Step 2: Establish / ensure the expected Outcome.
 */
const initialOutcome = await ensureOutcome(
  owner.client,
  workspaceA,
  projectA,
  governed.task.id,
);

assert.ifError(initialOutcome.error);

equal(
  initialOutcome.data.disposition,
  "created",
  "expected Outcome created",
);

equal(
  initialOutcome.data.achievementInferred,
  false,
  "Outcome creation never infers achievement",
);

equal(
  initialOutcome.data.outcome.state,
  "expected",
  "new canonical Outcome starts expected",
);

const outcomeId = initialOutcome.data.outcome.id;

check(Boolean(outcomeId), "canonical Outcome id exists");

const replayOutcome = await ensureOutcome(
  owner.client,
  workspaceA,
  projectA,
  governed.task.id,
);

assert.ifError(replayOutcome.error);

equal(
  replayOutcome.data.disposition,
  "existing",
  "ensure Outcome is idempotent",
);

equal(
  replayOutcome.data.outcome.id,
  outcomeId,
  "ensure replay returns same canonical Outcome",
);

equal(
  replayOutcome.data.achievementInferred,
  false,
  "ensure replay still denies inferred achievement",
);

/*
 * Step 3: Demonstrate that Task completion alone does NOT transition the Outcome to achieved.
 */
const beforeObservation = await admin
  .from("canonical_task_outcomes")
  .select("*")
  .eq("id", outcomeId)
  .single();

assert.ifError(beforeObservation.error);

equal(
  beforeObservation.data.state,
  "expected",
  "Outcome remains expected without explicit Observation",
);

const noObservationRows = await admin
  .from("canonical_outcome_observations")
  .select("id")
  .eq("outcome_id", outcomeId);

assert.ifError(noObservationRows.error);

equal(
  noObservationRows.data.length,
  0,
  "no Observation exists implicitly",
);

/*
 * Direct writes must be denied.
 */
const forgedOutcome = await owner.client
  .from("canonical_task_outcomes")
  .insert({
    workspace_id: workspaceA,
    project_id: projectA,
    task_id: governed.task.id,
    state: "achieved",
    expected_result: "FORGED",
    success_criteria: [],
    created_by: owner.id,
  });

check(Boolean(forgedOutcome.error), "direct Outcome insert rejected");

const forgedOutcomeUpdate = await owner.client
  .from("canonical_task_outcomes")
  .update({
    state: "achieved",
  })
  .eq("id", outcomeId);

check(Boolean(forgedOutcomeUpdate.error), "direct Outcome update rejected");

const forgedObservation = await owner.client
  .from("canonical_outcome_observations")
  .insert({
    workspace_id: workspaceA,
    project_id: projectA,
    outcome_id: outcomeId,
    task_id: governed.task.id,
    observation_state: "achieved",
    summary: "FORGED",
    evidence_reference_ids: [governed.evidenceId],
    confidence_score: 1,
    missing_data_state: "COMPLETE",
    observed_by: owner.id,
    observed_at: new Date().toISOString(),
    evaluated_at: new Date().toISOString(),
    stale_at: new Date(Date.now() + 3600000).toISOString(),
    idempotency_key: `forged-${suffix}`,
  });

check(Boolean(forgedObservation.error), "direct Observation insert rejected");

/*
 * Read boundary.
 */
const ownerRead = await owner.client
  .from("canonical_task_outcomes")
  .select("id,state")
  .eq("id", outcomeId);

assert.ifError(ownerRead.error);
equal(ownerRead.data.length, 1, "owner can read canonical Outcome");

const viewerRead = await viewer.client
  .from("canonical_task_outcomes")
  .select("id,state")
  .eq("id", outcomeId);

assert.ifError(viewerRead.error);
equal(viewerRead.data.length, 1, "viewer can read canonical Outcome");

const outsiderRead = await outsider.client
  .from("canonical_task_outcomes")
  .select("id,state")
  .eq("id", outcomeId);

assert.ifError(outsiderRead.error);
equal(
  outsiderRead.data.length,
  0,
  "cross-tenant canonical Outcome read denied",
);

/*
 * Viewer cannot perform material Outcome writes through the RPC.
 */
const viewerObservation = await recordObservation(viewer.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "achieved",
  summary: "Viewer must not be allowed to record this observation.",
  evidenceIds: [governed.evidenceId],
  idempotencyKey: `viewer-${suffix}`,
});

check(Boolean(viewerObservation.error), "viewer Observation write rejected");

/*
 * Cross-tenant Outcome scope must fail.
 */
const crossTenantEnsure = await ensureOutcome(
  outsider.client,
  workspaceA,
  projectA,
  governed.task.id,
);

check(
  Boolean(crossTenantEnsure.error),
  "cross-tenant ensure Outcome rejected",
);

/*
 * Negative Boundary: DEMO / FIXTURE Evidence MUST NOT be allowed to prove an Outcome.
 * (governed.evidenceId carries fixture_state = 'DEMO_FIXTURE').
 */
const demoFixtureObservation = await recordObservation(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "achieved",
  summary:
    "Demo fixture evidence must never be allowed to prove an Outcome achievement.",
  evidenceIds: [governed.evidenceId],
  idempotencyKey: `demo-fixture-${suffix}`,
});

check(
  Boolean(demoFixtureObservation.error),
  "Observation with DEMO_FIXTURE Evidence rejected",
);

/*
 * Negative Boundary: Empty Evidence list must be rejected.
 */
const emptyEvidenceObservation = await recordObservation(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "achieved",
  summary: "Empty evidence must not support an Outcome observation.",
  evidenceIds: [],
  idempotencyKey: `empty-evidence-${suffix}`,
});

check(
  Boolean(emptyEvidenceObservation.error),
  "Observation with empty Evidence rejected",
);

/*
 * Negative Boundary: Non-existent / invalid Evidence must be rejected.
 */
const invalidEvidenceObservation = await recordObservation(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "failed",
  summary:
    "Non-existent evidence must not support an Outcome observation.",
  evidenceIds: [randomUUID()],
  idempotencyKey: `invalid-evidence-${suffix}`,
});

check(
  Boolean(invalidEvidenceObservation.error),
  "Observation with invalid Evidence rejected",
);

/*
 * Negative Boundary: Stale observation evaluation timestamp must be rejected.
 */
const nowTs = new Date();
const staleObservation = await recordObservation(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "achieved",
  summary: "Stale observation evaluation.",
  evidenceIds: [governed.evidenceId],
  idempotencyKey: `stale-obs-${suffix}`,
  observedAt: nowTs.toISOString(),
  evaluatedAt: nowTs.toISOString(),
  staleAt: new Date(nowTs.getTime() - 10_000).toISOString(),
});

check(
  Boolean(staleObservation.error),
  "Observation with stale timestamp rejected",
);

/*
 * Negative Boundary: Invalid observation state must be rejected.
 */
const invalidStateObservation = await recordObservation(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "invalid_state",
  summary: "Invalid observation state must fail.",
  evidenceIds: [governed.evidenceId],
  idempotencyKey: `invalid-state-${suffix}`,
});

check(
  Boolean(invalidStateObservation.error),
  "Observation with invalid observationState rejected",
);

/*
 * Step 4: Capture a NEW LIVE operational observation through the new P2-09 live intake path.
 */
const liveObsTime = new Date().toISOString();
const liveCorrelationId = randomUUID();
const liveSourceKey = "p2-09-live-observation:v1";

const capturedLive = await captureLiveInput(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  sourceKey: liveSourceKey,
  idempotencyKey: `live-intake-${suffix}`,
  title: "LIVE project milestone observation telemetry",
  content:
    "External production telemetry explicitly confirms that the governed project milestone delivered the expected operational capability.",
  occurredAt: liveObsTime,
  correlationId: liveCorrelationId,
});

assert.ifError(capturedLive.error);

equal(
  capturedLive.data.disposition,
  "created",
  "canonical LIVE observation intake captured",
);

equal(
  capturedLive.data.source.is_fixture,
  false,
  "LIVE observation source is not a fixture",
);

equal(
  capturedLive.data.source.fixture_label,
  null,
  "LIVE observation source has no fixture label",
);

check(
  Boolean(capturedLive.data.normalizedEvent?.id),
  "LIVE observation normalized event id exists",
);

equal(
  capturedLive.data.normalizedEvent.status,
  "accepted",
  "LIVE observation normalized event is accepted",
);

const liveNormalizedEventId = capturedLive.data.normalizedEvent.id;

/*
 * Step 5: Derive canonical Evidence from that new LIVE Normalized Event using P2-04 contract.
 */
const derivedLive = await deriveLiveEvidence(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  normalizedEventId: liveNormalizedEventId,
  idempotencyKey: `live-evidence-${suffix}`,
  assertionType: "FACT",
  classification: "DELIVERY",
  confidenceScore: 0.98,
  missingDataState: "COMPLETE",
  evaluatedAt: liveObsTime,
});

assert.ifError(derivedLive.error);

equal(
  derivedLive.data.disposition,
  "created",
  "canonical LIVE Evidence derived",
);

const liveEvidence = derivedLive.data.evidence;
const liveEvidenceId = liveEvidence.id;

check(Boolean(liveEvidenceId), "canonical LIVE Evidence id exists");

/*
 * Step 6: Assert that this new Evidence has the required canonical LIVE properties.
 */
equal(
  liveEvidence.fixture_state,
  "LIVE",
  "derived Evidence has canonical LIVE fixture_state",
);

equal(
  liveEvidence.freshness_state,
  "CURRENT",
  "derived Evidence has CURRENT freshness_state",
);

equal(
  liveEvidence.lifecycle,
  "RECORDED",
  "derived Evidence has RECORDED lifecycle",
);

equal(
  liveEvidence.normalized_event_id,
  liveNormalizedEventId,
  "derived Evidence references LIVE normalized event id",
);

equal(
  liveEvidence.rejection_reason,
  null,
  "derived Evidence has no rejection_reason",
);

equal(
  liveEvidence.degraded_reason,
  null,
  "derived Evidence has no degraded_reason",
);

/*
 * Step 7: Use THIS new LIVE Evidence ID (not governed.evidenceId) when recording Observation.
 * Step 8: Verify that the Observation persists the NEW live Evidence provenance.
 * Step 9: Verify that only after explicit evidence-backed Observation does Outcome transition to achieved.
 */
const observed = await recordObservation(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "achieved",
  summary:
    "LIVE external telemetry explicitly demonstrates that the expected governed operational result occurred.",
  evidenceIds: [liveEvidenceId],
  idempotencyKey: `observation-${suffix}`,
});

assert.ifError(observed.error);

equal(
  observed.data.disposition,
  "created",
  "evidence-backed Observation created",
);

equal(
  observed.data.outcomeState,
  "achieved",
  "explicit achieved Observation transitions canonical Outcome",
);

check(
  Boolean(observed.data.observation?.id),
  "canonical Observation id exists",
);

check(
  Boolean(observed.data.learningCandidate),
  "Observation emits learning candidate",
);

equal(
  observed.data.learningCandidate.eventType,
  "canonical_outcome_learning_candidate.v1",
  "learning candidate has canonical event type",
);

/*
 * Step 10: Observation idempotency.
 */
const replayObservation = await recordObservation(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "achieved",
  summary:
    "LIVE external telemetry explicitly demonstrates that the expected governed operational result occurred.",
  evidenceIds: [liveEvidenceId],
  idempotencyKey: `observation-${suffix}`,
});

assert.ifError(replayObservation.error);

equal(
  replayObservation.data.disposition,
  "existing",
  "identical Observation replay is idempotent",
);

equal(
  replayObservation.data.observation.id,
  observed.data.observation.id,
  "Observation replay returns same row",
);

/*
 * Same idempotency key with different material meaning must conflict.
 */
const conflictingObservation = await recordObservation(owner.client, {
  workspaceId: workspaceA,
  projectId: projectA,
  outcomeId,
  observationState: "failed",
  summary:
    "Conflicting meaning under the same idempotency key must not overwrite history.",
  evidenceIds: [liveEvidenceId],
  idempotencyKey: `observation-${suffix}`,
});

assert.ifError(conflictingObservation.error);

equal(
  conflictingObservation.data.disposition,
  "conflict",
  "conflicting Observation replay rejected",
);

equal(
  conflictingObservation.data.failureClass,
  "idempotency_conflict",
  "conflicting Observation exposes deterministic failure class",
);

/*
 * Final verification of persisted database state.
 */
const finalOutcome = await admin
  .from("canonical_task_outcomes")
  .select("*")
  .eq("id", outcomeId)
  .single();

assert.ifError(finalOutcome.error);

equal(
  finalOutcome.data.state,
  "achieved",
  "canonical Outcome persists explicit observed state",
);

const finalObservations = await admin
  .from("canonical_outcome_observations")
  .select("*")
  .eq("outcome_id", outcomeId)
  .order("recorded_at", { ascending: true });

assert.ifError(finalObservations.error);

equal(
  finalObservations.data.length,
  1,
  "only the valid canonical Observation persisted",
);

equal(
  finalObservations.data[0].observation_state,
  "achieved",
  "persisted Observation preserves explicit state",
);

check(
  finalObservations.data[0].evidence_reference_ids.includes(
    liveEvidenceId,
  ),
  "persisted Observation preserves NEW LIVE Evidence provenance",
);

check(
  !finalObservations.data[0].evidence_reference_ids.includes(
    governed.evidenceId,
  ),
  "persisted Observation does NOT use original decision Evidence",
);

console.log(
  `P2-09 DB verification PASS (${assertions} assertions).`,
);

console.log(`LINEAGE Outcome ${outcomeId}`);
console.log(`  -> Task ${governed.task.id}`);
console.log(`  -> Action ${governed.actionId}`);
console.log(`  -> Decision ${governed.decisionId}`);
console.log(`  -> Decision Evidence ${governed.evidenceId} (DEMO_FIXTURE)`);
console.log(`  -> Observation ${observed.data.observation.id}`);
console.log(`  -> LIVE Observation Evidence ${liveEvidenceId} (LIVE)`);
console.log(`  -> Normalized Event ${liveNormalizedEventId}`);

console.log(
  "BOUNDARY: Task execution/completion does not imply Outcome achievement.",
);

console.log(
  "LEARNING: Outcome state changed only through an explicit LIVE evidence-backed Observation.",
);

console.log(
  `FRONTERA ALLOW: ${governed.fronteraDecisionId} (owner, project A); before provisioning: frontera_actor_unbound, zero Tasks.`,
);