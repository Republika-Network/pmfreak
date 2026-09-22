/**
 * P2-18 live verification — Learning Candidate Eligibility and Lineage, against a disposable
 * local stack.
 *
 * Every lineage is REAL and LIVE, built through the product's own routes and RPCs:
 *   live capture → Evidence → run_chain (Finding/Recommendation) → Decision → Material
 *   Action → Frontera-authorised dispatch → internal execution → Outcome → LIVE Observation.
 * Candidates are then proposed through /api/learning-candidates and the RPC directly, and
 * the database-side guarantees are asserted: eligibility, pattern identity, tiers,
 * correlation-only semantics, relational lineage, idempotency, concurrency, supersession
 * without history loss, the atomic candidate event, RLS, IDOR and provenance immutability.
 *
 * Requires: OPERATIONAL_FLOW_TEST_SUPABASE_URL, OPERATIONAL_FLOW_TEST_ANON_KEY,
 * OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY, OPERATIONAL_FLOW_TEST_BASE_URL (exactly
 * http://localhost:3000, serving the SAME stack), OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true
 * and AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH (the disposable Frontera store the app reads).
 * Loopback targets only. Nothing is deleted afterwards; every run uses fresh tenants.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createVerifierFronteraOperator, requireDisposableFronteraStore } from "./frontera-verifier-authority.mjs";
import type { CanonicalLearningCandidateRow, CanonicalLearningCandidateSourceRow, CanonicalOutcomeObservationRow } from "../src/lib/db/database-contract";
import type { LearningCandidateView } from "../src/lib/learning-candidates/types";

/** The response fields this verifier reads; everything else is ignored. */
type ApiBody = {
  normalizedEvent?: { id: string };
  evidence?: { id: string; fixture_state: string };
  chain?: Array<{ signal?: { id: string } }>;
  decision?: { id: string };
  proposal?: { id: string; proposal_digest: string };
  task?: { id: string };
  executionTask?: { id: string };
  disposition?: string;
  candidateId?: string;
  evidenceTier?: string;
  causalityClaim?: string;
  elevationInferred?: boolean;
  reasons?: string[];
  candidates?: LearningCandidateView[];
  canPropose?: boolean;
};
type RpcResult = { disposition: string; reasons: string[]; candidate: CanonicalLearningCandidateRow; source: CanonicalLearningCandidateSourceRow };
type EventRow = {
  event_type: string; learning_eligible: boolean; causation_id: string | null; correlation_id: string | null; actor_id: string;
  event_payload: {
    eventType: string; transition: string; elevationInferred: boolean; candidateIsNotOrganizationalTruth: boolean;
    causalityClaim: string; before: unknown; references: { observationId: string };
  };
};

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL ?? "";
const anonKey = process.env.OPERATIONAL_FLOW_TEST_ANON_KEY ?? "";
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY ?? "";
const appBaseUrl = process.env.OPERATIONAL_FLOW_TEST_BASE_URL?.replace(/\/$/, "") ?? "";

if (!supabaseUrl || !anonKey || !serviceRoleKey || !appBaseUrl || process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true") {
  console.error("P2-18 live verification requires the disposable local stack (OPERATIONAL_FLOW_TEST_* and OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true).");
  process.exit(2);
}
for (const [name, target] of [["Supabase API", supabaseUrl], ["PMFreak", appBaseUrl]] as const) {
  const host = new URL(target).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
    console.error(`SAFETY ABORT: ${name} must use a literal loopback host.`);
    process.exit(2);
  }
}
if (appBaseUrl !== "http://localhost:3000") {
  console.error("SAFETY ABORT: the app origin must be http://localhost:3000.");
  process.exit(2);
}

const frontera = createVerifierFronteraOperator({ storePath: requireDisposableFronteraStore("P2-18"), operatorActorId: "operator-p2-18-verifier" });
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const makeClient = () => createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const password = `P2-18-${randomUUID()}!`;
let assertions = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions += 1; };
const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); assertions += 1; };
const must = <T,>(result: { data: T; error: { message: string } | null }, label: string): T => { assert.ifError(result.error ? new Error(`${label}: ${result.error.message}`) : null); return result.data; };

type User = { id: string; email: string; client: SupabaseClient; cookie?: string };

async function createUser(label: string): Promise<User> {
  const email = `p2-18-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const client = makeClient();
  assert.ifError((await client.auth.signInWithPassword({ email, password })).error);
  return { id: created.data.user!.id, email, client };
}

async function authCookie(user: User) {
  const form = new FormData();
  form.set("email", user.email);
  form.set("password", password);
  form.set("next", "/projects");
  const response = await fetch(`${appBaseUrl}/api/login`, { method: "POST", body: form, redirect: "manual" });
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
  check(values.length > 0, `${user.email} logs in`);
  user.cookie = values.map((v) => v.split(";", 1)[0]).join("; ");
}

async function http(user: User, method: "GET" | "POST", route: string, body?: unknown) {
  const response = await fetch(`${appBaseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(user.cookie ? { cookie: user.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as ApiBody };
}

const flow = (user: User, workspaceId: string, projectId: string, data: Record<string, unknown>) =>
  http(user, "POST", "/api/operational-flow", { workspaceId, projectId, ...data });

async function seedTenant(owner: User, label: string) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  must(await admin.from("workspaces").insert({ id: workspaceId, name: `P2-18 ${label} ${suffix}`, created_by_user_id: owner.id }), "workspace");
  must(await admin.from("projects").insert({ id: projectId, workspace_id: workspaceId, user_id: owner.id, name: `P2-18 ${label} project ${suffix}` }), "project");
  must(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: owner.id, role: "owner" }), "membership");
  return { workspaceId, projectId };
}

let fronteraProvisioned = false;

/** One REAL, LIVE canonical lineage ending in an Observation of `observationState`. */
async function buildLiveLineage(owner: User, t: { workspaceId: string; projectId: string }, key: string, observationState: "achieved" | "partial" | "failed" | "disputed") {
  const now = new Date().toISOString();
  const correlationId = randomUUID();
  const captured = await flow(owner, t.workspaceId, t.projectId, {
    operation: "capture_live_input", idempotencyKey: `p2-18-capture:${key}`, title: `P2-18 live decision context ${key}`,
    content: "A decision is needed before proceeding with this governed project change.", occurredAt: now, correlationId,
  });
  equal(captured.status, 201, `${key}: LIVE input captured`);
  const derived = await flow(owner, t.workspaceId, t.projectId, {
    operation: "derive_evidence", normalizedEventId: captured.body.normalizedEvent!.id, idempotencyKey: `p2-18-evidence:${key}`,
    assertionType: "FACT", classification: "DECISION_CONTEXT", confidenceScore: 0.95, missingDataState: "COMPLETE", evaluatedAt: now,
  });
  equal(derived.status, 201, `${key}: LIVE Evidence derived`);
  equal(derived.body.evidence!.fixture_state, "LIVE", `${key}: Finding Evidence is LIVE`);
  const chain = await flow(owner, t.workspaceId, t.projectId, { operation: "run_chain", evidenceItemId: derived.body.evidence!.id });
  equal(chain.status, 200, `${key}: governed chain materialised`);
  const signalId = chain.body.chain?.[0]?.signal?.id ?? "";
  check(Boolean(signalId), `${key}: Finding exists`);
  const recommendation = must(await admin.from("recommended_actions").select("id").eq("project_id", t.projectId).eq("source_signal_id", signalId).not("governance_event_id", "is", null).single(), "recommendation") as { id: string };
  const decision = await flow(owner, t.workspaceId, t.projectId, {
    operation: "record_decision", recommendationId: recommendation.id, decisionStatus: "accepted",
    decision: `Accepted P2-18 decision ${key}`, rationale: "P2-18 disposable local verification.",
  });
  equal(decision.status, 201, `${key}: Decision recorded`);
  const proposed = await flow(owner, t.workspaceId, t.projectId, {
    operation: "propose_material_action", decisionId: decision.body.decision!.id, idempotencyKey: `p2-18-action:${key}`,
    actionClass: "external_write", actionType: "schedule_change_proposal", targetResourceType: "project_schedule", targetResourceId: t.projectId,
    intendedOperation: "propose_only", intendedEffect: "Apply the governed change and later observe its expected result.",
    risk: "high", reversibility: "partially_reversible", sideEffect: "external", justification: "P2-18 disposable local verification.",
    createdAt: now, evaluationTime: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  equal(proposed.status, 201, `${key}: Material Action proposed`);
  if (!fronteraProvisioned) {
    await frontera.provision({ workspaceId: t.workspaceId, principalUserId: owner.id, projectId: t.projectId });
    fronteraProvisioned = true;
  }
  const dispatched = await flow(owner, t.workspaceId, t.projectId, {
    operation: "dispatch_material_action_to_task", actionId: proposed.body.proposal!.id, expectedProposalDigest: proposed.body.proposal!.proposal_digest,
  });
  equal(dispatched.status, 201, `${key}: governed Task dispatched`);
  const task = (dispatched.body.task ?? dispatched.body.executionTask)!;
  for (const command of ["queue", "start", "complete"]) {
    const step = await http(owner, "POST", "/api/execution-tasks/internal-execution", { taskId: task.id, command });
    check([200, 201].includes(step.status), `${key}: execution ${command}`);
  }
  const outcome = must(await owner.client.rpc("ensure_expected_task_outcome", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_task_id: task.id,
    p_expected_result: "The governed change produces the expected project result.",
    p_success_criteria: [{ criterion: "Evidence shows the expected result occurred." }],
    p_correlation_id: `p2-18-outcome-${key}`, p_causation_id: task.id,
  }), `${key}: outcome`) as { outcome: { id: string } };
  const observationId = await observe(owner, t, outcome.outcome.id, `${key}-1`, observationState);
  return { outcomeId: outcome.outcome.id, observationId, decisionId: decision.body.decision!.id, taskId: task.id, actionId: proposed.body.proposal!.id, signalId, recommendationId: recommendation.id, findingEvidenceId: derived.body.evidence!.id };
}

/** A LIVE Observation backed by freshly captured LIVE Evidence. */
async function observe(owner: User, t: { workspaceId: string; projectId: string }, outcomeId: string, key: string, state: string) {
  const now = new Date().toISOString();
  const captured = must(await owner.client.rpc("capture_live_operational_input", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_source_key: "p2-18-live-observation:v1",
    p_idempotency_key: `p2-18-obs-intake:${key}`, p_title: `P2-18 observation telemetry ${key}`,
    p_content: "External telemetry explicitly reports the governed change's operational result.", p_occurred_at: now,
    p_correlation_id: randomUUID(), p_causation_id: null, p_external_id: null,
  }), `${key}: observation intake`) as { normalizedEvent: { id: string } };
  const evidence = must(await owner.client.rpc("derive_operational_evidence", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_normalized_event_id: captured.normalizedEvent.id,
    p_idempotency_key: `p2-18-obs-evidence:${key}`, p_assertion_type: "FACT", p_classification: "DELIVERY",
    p_confidence_score: 0.97, p_missing_data_state: "COMPLETE", p_evaluated_at: now, p_stale_at: null,
  }), `${key}: observation evidence`) as { evidence: { id: string } };
  const observed = must(await owner.client.rpc("record_canonical_outcome_observation", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_outcome_id: outcomeId, p_observation_state: state,
    p_summary: `P2-18 ${state} observation ${key}`, p_evidence_reference_ids: [evidence.evidence.id], p_confidence_score: 0.9,
    p_missing_data_state: "COMPLETE", p_observed_at: now, p_evaluated_at: now,
    p_stale_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    p_correlation_id: randomUUID(), p_causation_id: outcomeId, p_idempotency_key: `p2-18-observation:${key}`,
  }), `${key}: observation`) as { observation: { id: string } };
  return observed.observation.id;
}

const propose = (user: User, t: { workspaceId: string; projectId: string }, outcomeId: string, observationId: string) =>
  user.client.rpc("propose_canonical_learning_candidate", {
    p_workspace_id: t.workspaceId, p_project_id: t.projectId, p_outcome_id: outcomeId, p_observation_id: observationId,
    p_evaluated_at: new Date().toISOString(),
  });

const count = async (table: string, filter: Record<string, unknown>) => {
  let q = admin.from(table).select("id", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v as string);
  const { count: n, error } = await q;
  assert.ifError(error);
  return n ?? 0;
};

const candidateEvents = (candidateId: string) => count("platform_events", { raw_reference_table: "canonical_learning_candidates", raw_reference_id: candidateId });

// ── Tenants ────────────────────────────────────────────────────────────────────────────
const owner = await createUser("owner");
const viewer = await createUser("viewer");
const outsider = await createUser("outsider");
const a = await seedTenant(owner, "A");
must(await admin.from("workspace_memberships").insert({ workspace_id: a.workspaceId, user_id: viewer.id, role: "viewer" }), "viewer membership");
const b = await seedTenant(outsider, "B");
await authCookie(owner);
await authCookie(viewer);
await authCookie(outsider);

// ── 1. First eligible lineage → a new candidate hypothesis ──────────────────────────────
const lineageA = await buildLiveLineage(owner, a, `a-${suffix}`, "achieved");
equal(await count("canonical_learning_candidates", { project_id: a.projectId }), 0, "no candidate exists before one is proposed");

// Authority and tenancy are refused before anything is written.
const viewerRpc = await propose(viewer, a, lineageA.outcomeId, lineageA.observationId);
check(/learning_candidate_write_denied/.test(viewerRpc.error?.message ?? ""), "a same-tenant viewer cannot propose (RPC)");
equal((await http(viewer, "POST", "/api/learning-candidates", { workspaceId: a.workspaceId, projectId: a.projectId, outcomeId: lineageA.outcomeId })).status, 403, "a same-tenant viewer cannot propose (route)");
const outsiderRpc = await propose(outsider, a, lineageA.outcomeId, lineageA.observationId);
check(/learning_candidate_write_denied/.test(outsiderRpc.error?.message ?? ""), "another tenant cannot propose into tenant A");
const forgedScope = await propose(outsider, b, lineageA.outcomeId, lineageA.observationId);
check(/learning_candidate_outcome_not_found/.test(forgedScope.error?.message ?? ""), "IDOR: tenant A's Outcome named under tenant B's scope is not found");
equal((await http(outsider, "POST", "/api/learning-candidates", { workspaceId: a.workspaceId, projectId: a.projectId, outcomeId: lineageA.outcomeId })).status, 403, "IDOR: route refuses a forged workspace/project claim");
equal(await count("canonical_learning_candidates", { project_id: a.projectId }), 0, "refusals wrote nothing");

const created = await http(owner, "POST", "/api/learning-candidates", { workspaceId: a.workspaceId, projectId: a.projectId, outcomeId: lineageA.outcomeId });
equal(created.status, 201, "an eligible LIVE lineage creates a candidate");
equal(created.body.disposition, "created", "disposition created");
equal(created.body.evidenceTier, "single_lineage", "one lineage is single_lineage");
equal(created.body.causalityClaim, "correlation_only", "the route returns the correlation-only qualifier");
equal(created.body.elevationInferred, false, "creation infers no elevation");
const candidateId = created.body.candidateId!;

const candidate = must(await admin.from("canonical_learning_candidates").select("*").eq("id", candidateId).single(), "candidate") as CanonicalLearningCandidateRow;
equal(candidate.status, "proposed", "stored status is proposed");
equal(candidate.causality_claim, "correlation_only", "stored causality qualifier");
equal(candidate.version, 1, "version 1");
check(/^[a-f0-9]{64}$/.test(candidate.evidence_digest) && !/^0+$/.test(candidate.evidence_digest), "a real evidence digest, never a placeholder");
check(/^canonical-outcome-pattern:v1:[a-f0-9]{64}$/.test(candidate.pattern_key), "deterministic pattern key");
equal(Object.keys(candidate.pattern_signature).sort(), ["actionClass", "recommendedActionType", "signalType"], "bounded pattern signature");
equal(candidate.pattern_signature.actionClass, "external_write", "pattern carries the Action class");
check(candidate.limitations.includes("correlation_only") && candidate.limitations.includes("not_ratified"), "limitations persisted");
check(!("correlation_id" in candidate), "the aggregate carries no single correlation id");

const sourceA1 = must(await admin.from("canonical_learning_candidate_sources").select("*").eq("observation_id", lineageA.observationId).single(), "source") as CanonicalLearningCandidateSourceRow;
const observationA1 = must(await admin.from("canonical_outcome_observations").select("*").eq("id", lineageA.observationId).single(), "observation") as CanonicalOutcomeObservationRow;
equal([sourceA1.candidate_id, sourceA1.outcome_id, sourceA1.task_id, sourceA1.action_id, sourceA1.decision_id, sourceA1.recommendation_id, sourceA1.finding_id, sourceA1.finding_evidence_item_id],
  [candidateId, lineageA.outcomeId, lineageA.taskId, lineageA.actionId, lineageA.decisionId, lineageA.recommendationId, lineageA.signalId, lineageA.findingEvidenceId],
  "relational lineage references survive persistence");
equal(sourceA1.correlation_id, observationA1.correlation_id, "the source carries its own lineage correlation");
equal(sourceA1.causation_id, observationA1.causation_id, "the source carries its own lineage causation");
check(sourceA1.valid_until !== null && observationA1.stale_at !== null, "this Observation records a validity window");
equal(new Date(sourceA1.valid_until ?? "").toISOString(), new Date(observationA1.stale_at ?? "").toISOString(), "valid_until is the Observation's own stale_at (no invented TTL)");
equal(sourceA1.observation_evidence_ids, observationA1.evidence_reference_ids, "Observation Evidence refs survive");
equal(sourceA1.linked_by, owner.id, "actor attribution survives");

const events1 = must(await admin.from("platform_events").select("*").eq("raw_reference_table", "canonical_learning_candidates").eq("raw_reference_id", candidateId), "events") as EventRow[];
equal(events1.length, 1, "exactly one candidate event");
const ev = events1[0];
equal(ev.event_type, "CANONICAL_OUTCOME_LEARNING_CANDIDATE_V1", "platform event type");
equal(ev.event_payload.eventType, "canonical_outcome_learning_candidate.v1", "the reserved P2-09 event name");
equal(ev.event_payload.transition, "created", "transition created");
equal(ev.event_payload.elevationInferred, false, "event infers no elevation");
equal(ev.event_payload.candidateIsNotOrganizationalTruth, true, "event says it is not organizational truth");
equal(ev.event_payload.causalityClaim, "correlation_only", "event keeps the correlation-only qualifier");
equal(ev.event_payload.before, null, "no before-state on creation");
equal(ev.event_payload.references.observationId, lineageA.observationId, "event carries canonical references");
equal(ev.learning_eligible, false, "the candidate event is not re-fed to pattern extraction");
equal(ev.causation_id, null, "no platform-event causation is invented");
equal(ev.correlation_id, observationA1.correlation_id, "event correlation is the triggering Observation's real uuid correlation");
equal(ev.actor_id, owner.id, "event actor");

// ── 2. Idempotency and concurrency ─────────────────────────────────────────────────────
const retry = must(await propose(owner, a, lineageA.outcomeId, lineageA.observationId), "retry") as RpcResult;
equal(retry.disposition, "duplicate", "a retry of the same Observation is a duplicate");
const burst = await Promise.all(Array.from({ length: 10 }, () => propose(owner, a, lineageA.outcomeId, lineageA.observationId)));
check(burst.every((r) => !r.error && (r.data as RpcResult).disposition === "duplicate"), "10 concurrent retries are all duplicates");
equal(await count("canonical_learning_candidate_sources", { candidate_id: candidateId }), 1, "retries created no source link");
equal(await candidateEvents(candidateId), 1, "retries emitted no event");
equal((must(await admin.from("canonical_learning_candidates").select("version").eq("id", candidateId).single(), "v") as { version: number }).version, 1, "retries changed no version");

// ── 3. A newer Observation supersedes the old source; history is kept ──────────────────
const observationA2 = await observe(owner, a, lineageA.outcomeId, `a-${suffix}-2`, "achieved");
const staleContext = must(await propose(owner, a, lineageA.outcomeId, lineageA.observationId), "stale") as RpcResult;
equal(staleContext.disposition, "ineligible", "the old Observation is now a stale context");
check(staleContext.reasons.includes("observation_not_latest"), "stale context is named");
const superseded = must(await propose(owner, a, lineageA.outcomeId, observationA2), "supersede") as RpcResult;
equal(superseded.disposition, "evidence_superseded", "a newer Observation supersedes the previous source");
const oldSource = must(await admin.from("canonical_learning_candidate_sources").select("*").eq("id", sourceA1.id).single(), "old") as CanonicalLearningCandidateSourceRow;
check(oldSource.superseded_at !== null && oldSource.superseded_by_source_id === superseded.source.id, "the previous source is marked superseded, not deleted");
equal(oldSource.observation_id, lineageA.observationId, "historical provenance is unchanged");
equal(await count("canonical_learning_candidate_sources", { candidate_id: candidateId }), 2, "both sources remain");
equal(superseded.candidate.version, 2, "version 2");
equal(superseded.candidate.lineage_count, 1, "still one current lineage");
equal(await candidateEvents(candidateId), 2, "one event per material change");

// ── 4. An independent lineage of the same pattern; then a conflicting one ──────────────
const lineageB = await buildLiveLineage(owner, a, `b-${suffix}`, "achieved");
check(lineageB.decisionId !== lineageA.decisionId, "lineage B has its own Decision");
const linkedB = must(await propose(owner, a, lineageB.outcomeId, lineageB.observationId), "B") as RpcResult;
equal(linkedB.disposition, "evidence_linked", "a new Outcome of the same pattern adds evidence");
equal(linkedB.candidate.id, candidateId, "same deterministic hypothesis");
equal(linkedB.candidate.evidence_tier, "multiple_consistent_lineages", "two independent consistent lineages");
equal([linkedB.candidate.lineage_count, linkedB.candidate.independent_lineage_count, linkedB.candidate.version], [2, 2, 3], "counts and version recomputed");

const lineageC = await buildLiveLineage(owner, a, `c-${suffix}`, "failed");
const racers = await Promise.all(Array.from({ length: 8 }, () => propose(owner, a, lineageC.outcomeId, lineageC.observationId)));
check(racers.every((r) => !r.error), "8 concurrent first proposals all complete");
const dispositions = racers.map((r) => (r.data as RpcResult).disposition).sort();
equal(dispositions.filter((d) => d === "evidence_linked").length, 1, "exactly one concurrent call links the lineage");
equal(dispositions.filter((d) => d === "duplicate").length, 7, "the other seven are duplicates");
equal(await count("canonical_learning_candidates", { project_id: a.projectId }), 1, "no duplicate logical candidate");
equal(await count("canonical_learning_candidate_sources", { outcome_id: lineageC.outcomeId }), 1, "no duplicate current source");
const afterC = must(await admin.from("canonical_learning_candidates").select("*").eq("id", candidateId).single(), "C") as CanonicalLearningCandidateRow;
equal(afterC.evidence_tier, "conflicting_lineages", "a different observed result makes the evidence conflicting");
equal(afterC.result_counts, { achieved: 2, failed: 1 }, "bounded result counts");
check(afterC.limitations.includes("conflicting_observed_results"), "conflict is a stated limitation");
equal(afterC.version, 4, "version 4");
equal(await candidateEvents(candidateId), 4, "events match material changes exactly (1 created + 1 superseded + 2 linked)");

// ── 5. Ineligible lineages create nothing ──────────────────────────────────────────────
const lineageD = await buildLiveLineage(owner, a, `d-${suffix}`, "disputed");
const disputed = must(await propose(owner, a, lineageD.outcomeId, lineageD.observationId), "D") as RpcResult;
equal(disputed.disposition, "ineligible", "a disputed lineage is ineligible");
check(disputed.reasons.includes("lineage_disputed"), "the dispute is named");
const disputedRoute = await http(owner, "POST", "/api/learning-candidates", { workspaceId: a.workspaceId, projectId: a.projectId, outcomeId: lineageD.outcomeId });
equal(disputedRoute.status, 422, "the route reports ineligibility honestly");
equal(await count("canonical_learning_candidate_sources", { outcome_id: lineageD.outcomeId }), 0, "no source for an ineligible lineage");
const unknownObservation = await propose(owner, a, lineageA.outcomeId, randomUUID());
check(/learning_candidate_observation_not_found/.test(unknownObservation.error?.message ?? ""), "a forged Observation id is not found");
equal(await candidateEvents(candidateId), 4, "ineligible attempts emitted nothing");

// ── 6. RLS, direct writes and provenance immutability ──────────────────────────────────
equal(((must(await viewer.client.from("canonical_learning_candidates").select("id").eq("id", candidateId), "viewer read")) as unknown[]).length, 1, "a same-tenant viewer can read");
equal(((must(await outsider.client.from("canonical_learning_candidates").select("id").eq("id", candidateId), "outsider read")) as unknown[]).length, 0, "another tenant reads no candidate");
equal(((must(await outsider.client.from("canonical_learning_candidate_sources").select("id").eq("candidate_id", candidateId), "outsider sources")) as unknown[]).length, 0, "another tenant reads no lineage");
const directInsert = await owner.client.from("canonical_learning_candidates").insert({ ...candidate, id: randomUUID(), pattern_key: `canonical-outcome-pattern:v1:${"e".repeat(64)}` });
check(Boolean(directInsert.error), "even an owner cannot insert a candidate directly");
const directUpdate = await owner.client.from("canonical_learning_candidates").update({ status: "proposed" }).eq("id", candidateId).select("id");
check(Boolean(directUpdate.error) || (directUpdate.data ?? []).length === 0, "an owner cannot update a candidate directly");
const directDelete = await owner.client.from("canonical_learning_candidate_sources").delete().eq("candidate_id", candidateId).select("id");
check(Boolean(directDelete.error) || (directDelete.data ?? []).length === 0, "an owner cannot delete lineage directly");
const privilegedDelete = await admin.from("canonical_learning_candidate_sources").delete().eq("id", sourceA1.id);
check(/learning_candidate_provenance_immutable/.test(privilegedDelete.error?.message ?? ""), "not even the service role can delete lineage");
const privilegedRewrite = await admin.from("canonical_learning_candidate_sources").update({ observed_result: "failed" }).eq("id", superseded.source.id);
check(/learning_candidate_provenance_immutable/.test(privilegedRewrite.error?.message ?? ""), "lineage cannot be rewritten");
const privilegedRekey = await admin.from("canonical_learning_candidates").update({ pattern_key: `canonical-outcome-pattern:v1:${"f".repeat(64)}`, version: afterC.version + 1 }).eq("id", candidateId);
check(/learning_candidate_provenance_immutable/.test(privilegedRekey.error?.message ?? ""), "the hypothesis identity cannot be rewritten");
equal(await count("canonical_learning_candidate_sources", { candidate_id: candidateId }), 4, "all four sources remain");

// ── 7. Read contract and the P2-19 boundary ────────────────────────────────────────────
const read = await http(viewer, "GET", `/api/learning-candidates?workspaceId=${a.workspaceId}&projectId=${a.projectId}`);
equal(read.status, 200, "a viewer reads the project's candidates");
const view = read.body.candidates!.find((c) => c.id === candidateId)!;
equal(view.causalityClaim, "correlation_only", "read keeps the correlation-only qualifier");
check(/not a universal rule/.test(view.causalityNote), "read explains the qualifier");
check(view.limitations.some((l) => l.code === "correlation_only" && /does not establish/.test(l.statement)), "read keeps the limitation statement");
equal(view.status, "proposed", "read status proposed");
equal(view.elevationInferred, false, "read infers no elevation");
equal(view.sources.length, 4, "read returns the full lineage history");
equal(view.sources.filter((s) => s.validity === "superseded").length, 1, "the superseded source is labelled");
equal(view.currentSourceCount, 3, "three current sources");
equal(read.body.canPropose, false, "a viewer cannot propose");
equal((await http(outsider, "GET", `/api/learning-candidates?workspaceId=${a.workspaceId}&projectId=${a.projectId}`)).status, 403, "another tenant cannot read tenant A's candidates");
const statuses = must(await admin.from("canonical_learning_candidates").select("status").eq("workspace_id", a.workspaceId), "statuses") as Array<{ status: string }>;
check(statuses.every((s) => s.status === "proposed"), "no candidate is anything but proposed");
equal(await count("organizational_patterns", { workspace_id: a.workspaceId }), 0, "no organizational pattern (knowledge) was created");

console.log(`P2-18 DB verification PASS (${assertions} assertions).`);
console.log(`CANDIDATE ${candidateId} tier=${afterC.evidence_tier} version=${afterC.version} lineages=${afterC.lineage_count} independent=${afterC.independent_lineage_count} results=${JSON.stringify(afterC.result_counts)}`);
