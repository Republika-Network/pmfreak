import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

if (
  !supabaseUrl ||
  !anonKey ||
  !serviceRoleKey ||
  !appBaseUrl ||
  !databaseUrl ||
  process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true"
) {
  console.error([
    "P2-07 live verification requires the disposable local PMFreak stack.",
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
  console.error("SAFETY ABORT: browser/runtime origin must be http://localhost:3000.");
  process.exit(2);
}

// Governed dispatch passes the Frontera enforcement boundary (P0-PKG-06):
//
//     FINAL = PMFREAK_PRECONDITIONS AND FRONTERA_AUTHORIZATION
//
// A PMFreak role does not imply Frontera authority. This verifier therefore acts
// as the enterprise operator, OUT OF BAND, and provisions exactly the authority
// each positive scenario needs — nothing for the actors whose refusal is the point.
const fronteraOperator = createVerifierFronteraOperator({
  storePath: requireDisposableFronteraStore("P2-07"),
  operatorActorId: "operator-p2-07-verifier",
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
const password = `P2-07-${randomUUID()}!`;
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
  const email = `p2-07-${label}-${suffix}@example.test`;
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

async function api(cookie, body) {
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

async function taskList(cookie, projectId) {
  const response = await fetch(
    `${appBaseUrl}/api/execution-tasks?projectId=${encodeURIComponent(projectId)}`,
    { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20_000) },
  );
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function makeDecision(cookie, workspaceId, projectId, keySuffix) {
  const now = new Date();
  const correlationId = randomUUID();

  const captured = await api(cookie, {
    operation: "capture_input",
    workspaceId,
    projectId,
    // No sourceKey: the P2-14 review repair pins the DEMO / FIXTURE identity server-side,
    // and a caller-chosen key is now refused rather than silently accepted.
    idempotencyKey: `capture-${keySuffix}`,
    title: "DEMO / FIXTURE P2-07 governed Action-to-Task",
    content:
      "A decision is needed before proceeding with this governed project change.",
    occurredAt: now.toISOString(),
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
    evaluatedAt: now.toISOString(),
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
    decision: "DEMO / FIXTURE accepted P2-07 decision",
    rationale: "Controlled local P2-07 verification.",
  });
  equal(decision.status, 201, "fixture decision record");

  return {
    decisionId: decision.body.decision.id,
    evidenceId: derived.body.evidence.id,
  };
}

async function proposeAction(
  cookie,
  workspaceId,
  projectId,
  decisionId,
  key,
  {
    actionClass = "external_write",
    risk = "high",
    createdAt = new Date(Date.now() - 30_000),
    evaluationTime = new Date(Date.now() - 20_000),
    expiresAt = new Date(Date.now() + 60 * 60_000),
  } = {},
) {
  const result = await api(cookie, {
    operation: "propose_material_action",
    workspaceId,
    projectId,
    decisionId,
    idempotencyKey: key,
    actionClass,
    actionType: "schedule_change_proposal",
    targetResourceType: "project_schedule",
    targetResourceId: projectId,
    intendedOperation: "create_internal_execution_task",
    intendedEffect: `P2-07 governed task ${key}`,
    risk,
    reversibility: "partially_reversible",
    sideEffect: "external",
    justification: "P2-07 disposable local verifier.",
    createdAt: createdAt.toISOString(),
    evaluationTime: evaluationTime.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  check([200, 201].includes(result.status), `action proposal ${key} created/replayed`);
  return result.body;
}

/**
 * A genuinely expired Material Action, built by the canonical service as the
 * real authenticated principal (see scripts/p2-07/expired-material-action-fixture.ts).
 * The HTTP route no longer accepts a caller-supplied window, and must not; the
 * service's documented server-side seam is the only honest way to persist one.
 * Credentials go over stdin, never argv or the environment.
 */
function proposeExpiredActionThroughService(user, workspaceId, projectId, decisionId, key, window) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join("scripts", "p2-07", "expired-material-action-fixture.ts")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      input: JSON.stringify({
        supabaseUrl,
        anonKey,
        email: user.email,
        password,
        workspaceId,
        projectId,
        action: {
          decisionId,
          idempotencyKey: key,
          actionClass: "external_write",
          actionType: "schedule_change_proposal",
          targetResourceType: "project_schedule",
          targetResourceId: projectId,
          intendedOperation: "create_internal_execution_task",
          intendedEffect: `P2-07 governed task ${key}`,
          risk: "high",
          reversibility: "partially_reversible",
          sideEffect: "external",
          justification: "P2-07 disposable local verifier.",
        },
        window: Object.fromEntries(Object.entries(window).map(([name, at]) => [name, at.toISOString()])),
      }),
    },
  );
  assert.equal(run.status, 0, `expired Action fixture failed: ${String(run.stderr).slice(-600)}`);
  const line = run.stdout.split("\n").find((entry) => entry.startsWith("P2_07_FIXTURE_RESULT "));
  assert.ok(line, "expired Action fixture returned no result");
  return JSON.parse(line.slice("P2_07_FIXTURE_RESULT ".length));
}

async function readPersistedAction(actionId) {
  const result = await admin
    .from("material_action_proposals")
    .select("id,created_at,expires_at,proposed_by")
    .eq("id", actionId)
    .single();
  assert.ifError(result.error);
  return result.data;
}

async function countExecutionsForAction(actionId) {
  const result = await admin
    .from("internal_task_executions")
    .select("id", { count: "exact", head: true })
    .eq("source_action_id", actionId);
  assert.ifError(result.error);
  return result.count ?? 0;
}

async function dispatch(cookie, workspaceId, projectId, actionId, expectedProposalDigest = null) {
  return api(cookie, {
    operation: "dispatch_material_action_to_task",
    workspaceId,
    projectId,
    actionId,
    ...(expectedProposalDigest ? { expectedProposalDigest } : {}),
  });
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

/** The dispatch traversed the real Frontera runtime and was ALLOWED there. */
function expectFronteraAllow(response, actionId, label) {
  check(
    isGenuineFronteraDecisionId(response.body.fronteraDecisionId, actionId),
    `${label}: carries a Frontera-minted decision id (real AocKernel ALLOW)`,
  );
  return response.body.fronteraDecisionId;
}

/** Refused AT the Frontera boundary: the dispatch RPC was never reached. */
function expectFronteraRefusal(response, failureClass, label) {
  equal(response.status, 409, `${label}: HTTP 409`);
  equal(response.body.disposition, "denied", `${label}: disposition denied`);
  equal(response.body.failureClass, failureClass, `${label}: failureClass ${failureClass}`);
  equal(response.body.reason, "frontera_enforcement_denied", `${label}: refused at the Frontera boundary`);
  equal(response.body.task, undefined, `${label}: no Task in response`);
  equal(response.body.fronteraDecisionId, undefined, `${label}: no ALLOW decision id`);
}

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const projectA = randomUUID();
const projectB = randomUUID();
// A second project in tenant A. The owner is bound for project A only, so a
// dispatch here is the wrong-project case.
const projectC = randomUUID();

await createUser("owner", workspaceA, "owner");
await createUser("pm", workspaceA, "pm");
await createUser("viewer", workspaceA, "viewer");
await createUser("outsider", workspaceB, "owner");
// Approver in BOTH tenants, and deliberately unbound in Frontera at first: the
// unknown-principal case, then (bound in A only) the wrong-organization case.
await createUser("admin", workspaceA, "admin");

assert.ifError(
  (
    await admin.from("workspaces").insert([
      {
        id: workspaceA,
        name: `P2-07 DEMO A ${suffix}`,
        created_by_user_id: users.owner.id,
      },
      {
        id: workspaceB,
        name: `P2-07 DEMO B ${suffix}`,
        created_by_user_id: users.outsider.id,
      },
    ])
  ).error,
);

assert.ifError(
  (
    await admin.from("workspace_memberships").insert([
      { workspace_id: workspaceA, user_id: users.owner.id, role: "owner" },
      { workspace_id: workspaceA, user_id: users.pm.id, role: "pm" },
      { workspace_id: workspaceA, user_id: users.viewer.id, role: "viewer" },
      { workspace_id: workspaceB, user_id: users.outsider.id, role: "owner" },
      { workspace_id: workspaceA, user_id: users.admin.id, role: "admin" },
      { workspace_id: workspaceB, user_id: users.admin.id, role: "admin" },
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
        name: `P2-07 DEMO Project A ${suffix}`,
      },
      {
        id: projectB,
        workspace_id: workspaceB,
        user_id: users.outsider.id,
        name: `P2-07 DEMO Project B ${suffix}`,
      },
      {
        id: projectC,
        workspace_id: workspaceA,
        user_id: users.owner.id,
        name: `P2-07 DEMO Project C ${suffix}`,
      },
    ])
  ).error,
);

for (const label of ["owner", "pm", "viewer", "outsider", "admin"]) {
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
const pmCookie = await loginCookie(users.pm.email);
const viewerCookie = await loginCookie(users.viewer.email);
const outsiderCookie = await loginCookie(users.outsider.email);
const adminCookie = await loginCookie(users.admin.email);

// The authority store is shared with the running app and accumulates across
// runs, so this run proves it inherits nothing: every principal starts unbound
// in both tenants. The organizations are this run's fresh workspace ids, so no
// earlier verifier (P2-08/09/14 or a failed P2-07) can have authority here.
for (const label of ["owner", "pm", "viewer", "outsider", "admin"]) {
  for (const workspaceId of [workspaceA, workspaceB]) {
    equal(
      await fronteraOperator.binding({ workspaceId, principalUserId: users[label].id }),
      null,
      `Frontera store starts with no ${label} binding in ${workspaceId === workspaceA ? "tenant A" : "tenant B"}`,
    );
  }
}

// Minimum authority, provisioned out of band, exact project scope only:
//   owner  — every positive dispatch in project A
//   pm     — must REACH the dispatch RPC so PMFreak's requires_approval is
//            observed; Frontera ALLOW must not rescue it
//   viewer — deliberately bound: PMFreak's role denial must hold regardless
// admin and outsider stay unbound until their own scenarios below.
const ownerAuthority = await fronteraOperator.provision({
  workspaceId: workspaceA,
  principalUserId: users.owner.id,
  projectId: projectA,
});
const ownerAuthorityReplay = await fronteraOperator.provision({
  workspaceId: workspaceA,
  principalUserId: users.owner.id,
  projectId: projectA,
});
equal(ownerAuthorityReplay.actorId, ownerAuthority.actorId, "operator provisioning replays idempotently");
for (const label of ["pm", "viewer"]) {
  await fronteraOperator.provision({
    workspaceId: workspaceA,
    principalUserId: users[label].id,
    projectId: projectA,
  });
}

const ownerDecision = await makeDecision(
  ownerCookie,
  workspaceA,
  projectA,
  `owner-${suffix}`,
);

const happyAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectA,
  ownerDecision.decisionId,
  `happy-${suffix}`,
);
const happyActionId = happyAction.proposal.id;
const happyDigest = happyAction.proposal.proposal_digest;

const beforeHappy = await countTasksForAction(happyActionId);
equal(beforeHappy, 0, "happy Action starts with zero Tasks");

const happy = await dispatch(
  ownerCookie,
  workspaceA,
  projectA,
  happyActionId,
  happyDigest,
);
equal(happy.status, 201, "authorized Action creates Task");
equal(happy.body.disposition, "created", "happy disposition created");
const happyFronteraDecisionId = expectFronteraAllow(happy, happyActionId, "authorized owner dispatch");
check(Boolean(happy.body.task?.id), "happy Task has id");
equal(await countTasksForAction(happyActionId), 1, "happy Action has exactly one Task");
equal(
  happy.body.task.source_payload.sourceActionId,
  happyActionId,
  "Task retains source Action",
);
equal(
  happy.body.task.source_payload.sourceDecisionId,
  ownerDecision.decisionId,
  "Task retains source Decision",
);
check(
  Array.isArray(happy.body.task.source_payload.evidenceReferences),
  "Task retains evidence references",
);
equal(
  happy.body.nonExecution.executed,
  false,
  "Task creation is not execution",
);
equal(
  happy.body.nonExecution.outcomeCreated,
  false,
  "Task creation is not Outcome",
);

const replay = await dispatch(
  ownerCookie,
  workspaceA,
  projectA,
  happyActionId,
  happyDigest,
);
equal(replay.status, 200, "idempotent replay returns success");
equal(replay.body.disposition, "existing", "replay disposition existing");
equal(replay.body.task.id, happy.body.task.id, "replay returns same Task id");
equal(await countTasksForAction(happyActionId), 1, "replay still one Task");
// Frontera is asked on every attempt, replays included; a verdict is never cached.
check(
  expectFronteraAllow(replay, happyActionId, "replay dispatch") !== happyFronteraDecisionId,
  "replay is a fresh Frontera evaluation, not a reused verdict",
);

const conflict = await dispatch(
  ownerCookie,
  workspaceA,
  projectA,
  happyActionId,
  "f".repeat(64),
);
equal(conflict.status, 409, "conflicting digest returns conflict");
equal(conflict.body.disposition, "conflict", "conflict disposition");
equal(await countTasksForAction(happyActionId), 1, "conflict creates no second Task");

for (const concurrency of [2, 5, 10]) {
  const decision = await makeDecision(
    ownerCookie,
    workspaceA,
    projectA,
    `concurrency-${concurrency}-${suffix}`,
  );
  const action = await proposeAction(
    ownerCookie,
    workspaceA,
    projectA,
    decision.decisionId,
    `concurrency-${concurrency}-${suffix}`,
  );
  const actionId = action.proposal.id;
  const responses = await Promise.all(
    Array.from({ length: concurrency }, () =>
      dispatch(ownerCookie, workspaceA, projectA, actionId),
    ),
  );
  check(
    responses.every((entry) => [200, 201].includes(entry.status)),
    `${concurrency} concurrent requests all converge safely`,
  );
  const taskIds = new Set(responses.map((entry) => entry.body.task?.id).filter(Boolean));
  equal(taskIds.size, 1, `${concurrency} concurrent requests return one Task id`);
  equal(
    await countTasksForAction(actionId),
    1,
    `${concurrency} concurrent requests persist one Task row`,
  );
  check(
    responses.every((entry) => isGenuineFronteraDecisionId(entry.body.fronteraDecisionId, actionId)),
    `${concurrency} concurrent requests were each ALLOWED by Frontera`,
  );
  equal(
    new Set(responses.map((entry) => entry.body.fronteraDecisionId)).size,
    concurrency,
    `${concurrency} concurrent requests were each evaluated independently`,
  );
  console.log(`CONCURRENCY ${concurrency}: one Task ${[...taskIds][0]}; ${concurrency} Frontera ALLOW decisions`);
}

// ─── Frontera fail-closed matrix ─────────────────────────────────────────────
// Each case below uses a Material Action PMFreak would itself execute, so the
// ONLY refusal is Frontera's. Each is then shown to be valid by dispatching it
// once the operator has (out of band) supplied exactly the missing authority.

// 1. Unknown principal: a known PMFreak approver with valid application state
//    and NO Frontera actor binding.
const unboundDecision = await makeDecision(adminCookie, workspaceA, projectA, `unbound-${suffix}`);
const unboundAction = await proposeAction(
  adminCookie,
  workspaceA,
  projectA,
  unboundDecision.decisionId,
  `unbound-${suffix}`,
);
const unboundActionId = unboundAction.proposal.id;
const unbound = await dispatch(adminCookie, workspaceA, projectA, unboundActionId);
expectFronteraRefusal(unbound, "frontera_actor_unbound", "unbound principal");
equal(await countTasksForAction(unboundActionId), 0, "unbound principal creates zero Tasks");

await fronteraOperator.provision({
  workspaceId: workspaceA,
  principalUserId: users.admin.id,
  projectId: projectA,
});
const unboundThenBound = await dispatch(adminCookie, workspaceA, projectA, unboundActionId);
equal(unboundThenBound.status, 201, "same Action dispatches once the operator binds the principal");
equal(unboundThenBound.body.disposition, "created", "bound principal disposition created");
expectFronteraAllow(unboundThenBound, unboundActionId, "freshly bound principal");
equal(await countTasksForAction(unboundActionId), 1, "bound principal creates exactly one Task");

// 2. Wrong organization: the admin is now bound in tenant A only. A valid
//    tenant-B Action must not borrow tenant-A authority.
equal(
  await fronteraOperator.binding({ workspaceId: workspaceB, principalUserId: users.admin.id }),
  null,
  "tenant-A binding does not exist in tenant B",
);
const crossOrgDecision = await makeDecision(adminCookie, workspaceB, projectB, `cross-org-${suffix}`);
const crossOrgAction = await proposeAction(
  adminCookie,
  workspaceB,
  projectB,
  crossOrgDecision.decisionId,
  `cross-org-${suffix}`,
);
const crossOrgActionId = crossOrgAction.proposal.id;
const crossOrg = await dispatch(adminCookie, workspaceB, projectB, crossOrgActionId);
expectFronteraRefusal(crossOrg, "frontera_actor_unbound", "principal bound only in another organization");
equal(await countTasksForAction(crossOrgActionId), 0, "cross-organization authority creates zero Tasks");

// 3. Wrong project: the owner is bound for project A; project C is in the same
//    tenant but outside the grant's exact resource scope.
const wrongProjectDecision = await makeDecision(ownerCookie, workspaceA, projectC, `wrong-project-${suffix}`);
const wrongProjectAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectC,
  wrongProjectDecision.decisionId,
  `wrong-project-${suffix}`,
);
const wrongProjectActionId = wrongProjectAction.proposal.id;
const wrongProject = await dispatch(ownerCookie, workspaceA, projectC, wrongProjectActionId);
expectFronteraRefusal(wrongProject, "frontera_denied", "grant for project A used on project C");
equal(await countTasksForAction(wrongProjectActionId), 0, "wrong-project grant creates zero Tasks");

await fronteraOperator.provision({
  workspaceId: workspaceA,
  principalUserId: users.owner.id,
  projectId: projectC,
});
const rightProject = await dispatch(ownerCookie, workspaceA, projectC, wrongProjectActionId);
equal(rightProject.status, 201, "same Action dispatches once project C is granted");
expectFronteraAllow(rightProject, wrongProjectActionId, "project C grant");
equal(await countTasksForAction(wrongProjectActionId), 1, "project C grant creates exactly one Task");

// 4. Operator revocation, observed on the very next attempt. The second Action
//    has never dispatched; the application must rehydrate durable authority
//    rather than answer from anything it saw before the revocation.
const postRevocationDecision = await makeDecision(ownerCookie, workspaceA, projectC, `frontera-revoked-${suffix}`);
const postRevocationAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectC,
  postRevocationDecision.decisionId,
  `frontera-revoked-${suffix}`,
);
const postRevocationActionId = postRevocationAction.proposal.id;
await fronteraOperator.revoke({
  workspaceId: workspaceA,
  principalUserId: users.owner.id,
  projectId: projectC,
  reason: "P2-07 verifier: operator revocation freshness",
});
const afterRevocation = await dispatch(ownerCookie, workspaceA, projectC, postRevocationActionId);
expectFronteraRefusal(afterRevocation, "frontera_denied", "dispatch after operator revocation");
equal(await countTasksForAction(postRevocationActionId), 0, "revoked Frontera authority creates zero Tasks");

const replayAfterRevocation = await dispatch(ownerCookie, workspaceA, projectC, wrongProjectActionId);
expectFronteraRefusal(replayAfterRevocation, "frontera_denied", "replay after operator revocation");
equal(await countTasksForAction(wrongProjectActionId), 1, "revocation neither duplicates nor removes the earlier Task");

// Revocation was exactly as narrow as the grant: the owner stays bound, and
// project A authority is untouched (every PMFreak-denial case below reaches the
// dispatch RPC only because it is).
equal(
  (await fronteraOperator.binding({ workspaceId: workspaceA, principalUserId: users.owner.id }))?.status,
  "active",
  "project C revocation leaves the owner's actor binding active",
);

// ─── PMFreak governance matrix ───────────────────────────────────────────────
// Every case below is ALLOWED by Frontera — the response carries a Frontera
// decision id — and still refused by PMFreak's dispatch RPC. Frontera narrows;
// it never rescues a PMFreak denial.

const unavailableSourceLink = await admin
  .from("decision_evidence_links")
  .select(
    "evidence_item_id,evidence_hash_at_decision,evidence_version_at_decision,evidence_title_snapshot,link_reason",
  )
  .eq("decision_record_id", ownerDecision.decisionId)
  .limit(1)
  .single();
assert.ifError(unavailableSourceLink.error);

const unavailableDecisionId = randomUUID();
assert.ifError(
  (
    await admin.from("operational_decision_records").insert({
      id: unavailableDecisionId,
      workspace_id: workspaceA,
      project_id: projectA,
      recommendation_id: null,
      governance_event_id: null,
      decided_by: users.owner.id,
      decision: "DEMO / FIXTURE P2-07 unavailable-governance decision",
      decision_status: "accepted",
      rationale: "Controlled local fail-closed unavailable-governance proof.",
      authority_basis: "owner workspace authority (PMFreak role mapping v1)",
      authority_evaluation: {
        fixture: true,
        purpose: "P2-07 unavailable-governance proof",
      },
    })
  ).error,
);

assert.ifError(
  (
    await admin.from("decision_evidence_links").insert({
      decision_record_id: unavailableDecisionId,
      evidence_item_id: unavailableSourceLink.data.evidence_item_id,
      link_reason: "P2-07 real evidence lineage reused for unavailable-governance proof",
      evidence_hash_at_decision:
        unavailableSourceLink.data.evidence_hash_at_decision,
      evidence_version_at_decision:
        unavailableSourceLink.data.evidence_version_at_decision,
      evidence_title_snapshot:
        unavailableSourceLink.data.evidence_title_snapshot,
    })
  ).error,
);

const unavailableAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectA,
  unavailableDecisionId,
  `unavailable-${suffix}`,
);
const unavailableId = unavailableAction.proposal.id;
const unavailableDispatch = await dispatch(
  ownerCookie,
  workspaceA,
  projectA,
  unavailableId,
);
equal(unavailableDispatch.status, 409, "unavailable Action rejected");
expectFronteraAllow(unavailableDispatch, unavailableId, "unavailable governance");
equal(
  unavailableDispatch.body.governanceState,
  "unavailable",
  "unavailable governance state preserved",
);
equal(
  await countTasksForAction(unavailableId),
  0,
  "unavailable creates zero Tasks",
);

const deniedDecision = await makeDecision(
  ownerCookie,
  workspaceA,
  projectA,
  `denied-${suffix}`,
);
const deniedAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectA,
  deniedDecision.decisionId,
  `denied-${suffix}`,
  { actionClass: "knowledge_elevation" },
);
const deniedId = deniedAction.proposal.id;
equal(await countTasksForAction(deniedId), 0, "denied starts with zero Tasks");
const denied = await dispatch(ownerCookie, workspaceA, projectA, deniedId);
equal(denied.status, 409, "denied Action rejected");
expectFronteraAllow(denied, deniedId, "denied governance");
equal(denied.body.disposition, "denied", "denied disposition");
equal(denied.body.governanceState, "denied", "denied governance state preserved");
equal(await countTasksForAction(deniedId), 0, "denied creates zero Tasks");

const degradedDecision = await makeDecision(
  ownerCookie,
  workspaceA,
  projectA,
  `degraded-${suffix}`,
);
const degradedAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectA,
  degradedDecision.decisionId,
  `degraded-${suffix}`,
  { risk: "unknown" },
);
const degradedId = degradedAction.proposal.id;
const degraded = await dispatch(ownerCookie, workspaceA, projectA, degradedId);
equal(degraded.status, 409, "degraded Action rejected");
expectFronteraAllow(degraded, degradedId, "degraded governance");
equal(degraded.body.governanceState, "degraded", "degraded state preserved");
equal(await countTasksForAction(degradedId), 0, "degraded creates zero Tasks");

const approvalDecision = await makeDecision(
  pmCookie,
  workspaceA,
  projectA,
  `approval-${suffix}`,
);
const approvalAction = await proposeAction(
  pmCookie,
  workspaceA,
  projectA,
  approvalDecision.decisionId,
  `approval-${suffix}`,
);
const approvalId = approvalAction.proposal.id;
const approval = await dispatch(pmCookie, workspaceA, projectA, approvalId);
equal(approval.status, 409, "requires-approval Action rejected");
expectFronteraAllow(approval, approvalId, "requires-approval governance (pm)");
equal(
  approval.body.governanceState,
  "requires_approval",
  "requires-approval state preserved",
);
equal(await countTasksForAction(approvalId), 0, "requires approval creates zero Tasks");

const revokedDecision = await makeDecision(
  ownerCookie,
  workspaceA,
  projectA,
  `revoked-${suffix}`,
);
const revokedAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectA,
  revokedDecision.decisionId,
  `revoked-${suffix}`,
);
const revokedId = revokedAction.proposal.id;
const revoked = await api(ownerCookie, {
  operation: "revoke_material_action",
  workspaceId: workspaceA,
  projectId: projectA,
  actionId: revokedId,
  evaluationTime: new Date().toISOString(),
  reasonCode: "p2_07_revocation_before_task",
});
check([200, 201].includes(revoked.status), "revocation recorded");
const revokedDispatch = await dispatch(
  ownerCookie,
  workspaceA,
  projectA,
  revokedId,
);
equal(revokedDispatch.status, 409, "revoked Action rejected");
expectFronteraAllow(revokedDispatch, revokedId, "revoked governance");
equal(revokedDispatch.body.governanceState, "revoked", "revoked state preserved");
equal(await countTasksForAction(revokedId), 0, "revoked before dispatch creates zero Tasks");

// A. The browser does not own the governance window (P2-12). A caller-supplied
//    stale window through the HTTP route is ignored: the server persists its own
//    one-hour window, so the Action is NOT expired and remains dispatchable.
const staleClientDecision = await makeDecision(ownerCookie, workspaceA, projectA, `stale-client-window-${suffix}`);
const staleClientSentAt = Date.now();
const staleClientAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectA,
  staleClientDecision.decisionId,
  `stale-client-window-${suffix}`,
  {
    createdAt: new Date(staleClientSentAt - 3 * 60 * 60_000),
    evaluationTime: new Date(staleClientSentAt - 2 * 60 * 60_000),
    expiresAt: new Date(staleClientSentAt - 60 * 60_000),
  },
);
const staleClientAnsweredAt = Date.now();
const staleClientId = staleClientAction.proposal.id;
const staleClientRow = await readPersistedAction(staleClientId);
const staleClientCreatedAt = Date.parse(staleClientRow.created_at);
const staleClientExpiresAt = Date.parse(staleClientRow.expires_at);
check(
  staleClientCreatedAt >= staleClientSentAt - 5_000 && staleClientCreatedAt <= staleClientAnsweredAt + 5_000,
  "HTTP proposal: created_at is server time, not the caller's stale createdAt",
);
check(
  Math.abs(staleClientExpiresAt - staleClientCreatedAt - 60 * 60_000) < 1_000,
  "HTTP proposal: expires_at is the server-owned one-hour window",
);
check(
  staleClientExpiresAt > Date.now() + 50 * 60_000,
  "HTTP proposal: caller-supplied past expiresAt did not expire the Action",
);
const staleClientDispatch = await dispatch(ownerCookie, workspaceA, projectA, staleClientId);
equal(staleClientDispatch.status, 201, "stale client window cannot manufacture an expired Action");
equal(staleClientDispatch.body.disposition, "created", "stale client window Action dispatches normally");
expectFronteraAllow(staleClientDispatch, staleClientId, "stale client window Action");
equal(await countTasksForAction(staleClientId), 1, "stale client window Action creates exactly one Task");

// B. A genuinely expired persisted Action: same real owner, real accepted
//    Decision, real Evidence lineage, canonical proposal builder and
//    persist_governed_material_action — with the window pinned in the past
//    through the service's server-side seam. Dispatched over HTTP, through the
//    owner's valid Frontera authority:
//        FRONTERA = ALLOW, PMFREAK = EXPIRED, FINAL = DENY.
const expiredDecision = await makeDecision(
  ownerCookie,
  workspaceA,
  projectA,
  `expired-${suffix}`,
);
const expiredWindowBase = Date.now();
const expiredAction = proposeExpiredActionThroughService(
  users.owner,
  workspaceA,
  projectA,
  expiredDecision.decisionId,
  `expired-${suffix}`,
  {
    createdAt: new Date(expiredWindowBase - 2 * 60 * 60_000),
    evaluationTime: new Date(expiredWindowBase - 2 * 60 * 60_000),
    expiresAt: new Date(expiredWindowBase - 60 * 60_000),
  },
);
equal(expiredAction.disposition, "created", "expired fixture persisted by the canonical service");
const expiredId = expiredAction.proposal.id;
const expiredRow = await readPersistedAction(expiredId);
equal(expiredRow.proposed_by, users.owner.id, "expired fixture was proposed by the authenticated owner");
check(Date.parse(expiredRow.expires_at) < Date.now() - 50 * 60_000, "expired fixture's persisted expires_at is in the past");
equal(await countTasksForAction(expiredId), 0, "expired Action starts with zero Tasks");
const expiredDispatch = await dispatch(
  ownerCookie,
  workspaceA,
  projectA,
  expiredId,
  expiredAction.proposal.proposal_digest,
);
equal(expiredDispatch.status, 409, "expired Action rejected");
equal(expiredDispatch.body.disposition, "denied", "expired disposition denied");
equal(expiredDispatch.body.failureClass, "expired", "expired failure class");
equal(expiredDispatch.body.reason, "action_expired", "expired reason");
equal(expiredDispatch.body.governanceState, "authorized", "expired Action was otherwise authorized");
expectFronteraAllow(expiredDispatch, expiredId, "expired governance");
equal(await countTasksForAction(expiredId), 0, "expired creates zero Tasks");
equal(await countExecutionsForAction(expiredId), 0, "expired creates zero internal executions");

const anonymous = await dispatch(null, workspaceA, projectA, happyActionId);
equal(anonymous.status, 401, "unauthenticated dispatch rejected");

const viewer = await dispatch(
  viewerCookie,
  workspaceA,
  projectA,
  happyActionId,
);
equal(viewer.status, 403, "viewer dispatch rejected");
equal(await countTasksForAction(happyActionId), 1, "viewer attempt leaves one Task");

// PMFreak DENY + Frontera capability != ALLOW. The viewer holds exact Frontera
// authority for project A (provisioned above on purpose) and a never-dispatched,
// executable Action is available; PMFreak's role check still refuses first.
const viewerTargetDecision = await makeDecision(ownerCookie, workspaceA, projectA, `viewer-target-${suffix}`);
const viewerTargetAction = await proposeAction(
  ownerCookie,
  workspaceA,
  projectA,
  viewerTargetDecision.decisionId,
  `viewer-target-${suffix}`,
);
const viewerTargetId = viewerTargetAction.proposal.id;
equal(
  (await fronteraOperator.binding({ workspaceId: workspaceA, principalUserId: users.viewer.id }))?.status,
  "active",
  "viewer is bound in Frontera for this conjunction proof",
);
const boundViewer = await dispatch(viewerCookie, workspaceA, projectA, viewerTargetId);
equal(boundViewer.status, 403, "Frontera-bound viewer is still refused by PMFreak");
equal(boundViewer.body.fronteraDecisionId, undefined, "viewer refusal precedes any Frontera ALLOW");
equal(await countTasksForAction(viewerTargetId), 0, "Frontera-bound viewer creates zero Tasks");
const ownerTakesViewerTarget = await dispatch(ownerCookie, workspaceA, projectA, viewerTargetId);
equal(ownerTakesViewerTarget.status, 201, "the viewer's target Action was executable");
expectFronteraAllow(ownerTakesViewerTarget, viewerTargetId, "owner dispatch of the viewer's target");

// Cross-tenant, first as tenant B's owner holds no Frontera authority at all.
const crossTenantUnbound = await dispatch(
  outsiderCookie,
  workspaceB,
  projectB,
  happyActionId,
);
expectFronteraRefusal(crossTenantUnbound, "frontera_actor_unbound", "unbound cross-tenant dispatch");
equal(await countTasksForAction(happyActionId), 1, "unbound cross-tenant attempt leaves one Task");

// Then with minimum authority in tenant B's OWN organization and project. The
// request now reaches the dispatch RPC, which must still not find (nor reveal)
// tenant A's Action: Frontera ALLOW in B confers nothing in A.
await fronteraOperator.provision({
  workspaceId: workspaceB,
  principalUserId: users.outsider.id,
  projectId: projectB,
});
const crossTenant = await dispatch(
  outsiderCookie,
  workspaceB,
  projectB,
  happyActionId,
);
equal(crossTenant.status, 409, "cross-tenant Action dispatch rejected");
equal(crossTenant.body.failureClass, "not_found", "cross-tenant does not leak existence");
expectFronteraAllow(crossTenant, happyActionId, "tenant-B authority reaches PMFreak's tenancy check");
equal(await countTasksForAction(happyActionId), 1, "authorized cross-tenant attempt leaves one Task");

const crossTenantLookup = await taskList(outsiderCookie, projectA);
equal(crossTenantLookup.status, 403, "cross-tenant Task lookup rejected");

const forgedInsert = await users.owner.client.from("execution_tasks").insert({
  workspace_id: workspaceA,
  project_id: projectA,
  task_draft_id: null,
  recommended_action_id: null,
  raid_item_id: null,
  title: "FORGED governed provenance",
  description: "must be rejected by RLS",
  status: "not_started",
  priority: "medium",
  source_payload: {
    source: "governed_action",
    sourceActionId: randomUUID(),
  },
  created_by: users.owner.id,
});
check(Boolean(forgedInsert.error), "direct forged governed Task insert rejected");

const provenanceRewrite = await users.owner.client
  .from("execution_tasks")
  .update({ source_payload: { source: "manual", rewritten: true } })
  .eq("id", happy.body.task.id);
check(Boolean(provenanceRewrite.error), "governed Task provenance rewrite rejected");

const eventRows = await admin
  .from("execution_task_events")
  .select("event_type,event_payload")
  .eq("task_id", happy.body.task.id)
  .order("created_at", { ascending: true });
assert.ifError(eventRows.error);
check(
  eventRows.data.some((event) => event.event_type === "governed_action_task_created"),
  "creation audit event exists",
);
check(
  eventRows.data.some((event) => event.event_type === "governed_action_task_replayed"),
  "replay audit event exists",
);

console.log(`P2-07 DB verification PASS (${assertions} assertions).`);
console.log(`LINEAGE Task ${happy.body.task.id}`);
console.log(`  -> Action ${happyActionId}`);
console.log(`  -> Decision ${ownerDecision.decisionId}`);
console.log(
  `  -> Evidence ${happy.body.task.source_payload.evidenceReferences.join(", ")}`,
);
console.log("NO-OUTCOME: task creation reported executed=false, outcomeCreated=false.");
console.log(`FRONTERA ALLOW: ${happyFronteraDecisionId} (owner, project A, actor ${ownerAuthority.actorId})`);
console.log("FRONTERA FAIL-CLOSED: unbound principal, other-organization binding, wrong project, operator revocation — zero Tasks each.");
console.log("FRONTERA CONJUNCTION: unavailable/denied/degraded/requires_approval/revoked/expired and cross-tenant refused by PMFreak after Frontera ALLOW; bound viewer refused by role.");
console.log(`EXPIRY: client-supplied stale window ignored (Action ${staleClientId} dispatched); service-pinned expired Action ${expiredId} refused as expired after Frontera ALLOW, zero Tasks.`);