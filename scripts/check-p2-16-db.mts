/**
 * P2-16 live verification — Schedule Exposure adapter against the disposable local stack.
 *
 * Drives the REAL adapter service (src/lib/critical-path/schedule-exposure-service.ts) on
 * per-user authenticated Supabase clients — the same anon-key + session shape the route's
 * request-scoped client has, so RLS and every SECURITY DEFINER guard apply exactly as in
 * production. The service-role client is used ONLY to seed fixtures and to count rows for
 * assertions; it never performs a canonical write under test.
 *
 * Requires: OPERATIONAL_FLOW_TEST_SUPABASE_URL, OPERATIONAL_FLOW_TEST_ANON_KEY,
 * OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY and OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true,
 * against a literal loopback host. Rows are created under fresh random workspaces; canonical
 * provenance is append-only by contract, so nothing is deleted afterwards.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateAndRecordScheduleExposure,
  listScheduleExposures,
  SCHEDULE_EXPOSURE_SOURCE_KEY,
} from "../src/lib/critical-path/schedule-exposure-service";
import { buildScheduleExposurePayload, evaluateScheduleExposure } from "../src/lib/critical-path/schedule-exposure";
import { getOperationalSummary } from "../src/lib/operational-flow/operational-flow-service";

const supabaseUrl = process.env.OPERATIONAL_FLOW_TEST_SUPABASE_URL;
const anonKey = process.env.OPERATIONAL_FLOW_TEST_ANON_KEY;
const serviceRoleKey = process.env.OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey || process.env.OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE !== "true") {
  console.error([
    "P2-16 live verification requires the disposable local PMFreak stack.",
    "Set OPERATIONAL_FLOW_TEST_SUPABASE_URL, OPERATIONAL_FLOW_TEST_ANON_KEY,",
    "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY and OPERATIONAL_FLOW_TEST_ALLOW_DESTRUCTIVE=true.",
  ].join("\n"));
  process.exit(2);
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(supabaseUrl).hostname)) {
  console.error("SAFETY ABORT: Supabase API must use a literal loopback host.");
  process.exit(2);
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(supabaseUrl, serviceRoleKey, options);
const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const password = `P2-16-${randomUUID()}!`;
let assertions = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions += 1; };
const equal = (actual: unknown, expected: unknown, message: string) => { assert.equal(actual, expected, message); assertions += 1; };
async function rejects(promise: Promise<unknown>, pattern: RegExp, message: string) {
  await assert.rejects(promise, pattern, message);
  assertions += 1;
}
async function rpcError(client: SupabaseClient, name: string, args: Record<string, unknown>, pattern: RegExp, message: string) {
  const { error } = await client.rpc(name, args);
  check(error && pattern.test(error.message), `${message} (got: ${error?.message ?? "no error"})`);
}

type Actor = { id: string; client: SupabaseClient; role: string };
async function actor(label: string, workspaceId: string, role: string): Promise<Actor> {
  const email = `p2-16-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const client = createClient(supabaseUrl!, anonKey!, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  return { id: created.data.user!.id, client, role };
}

async function seedTenant(label: string) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const owner = await actor(`${label}-owner`, workspaceId, "owner");
  assert.ifError((await admin.from("workspaces").insert({ id: workspaceId, name: `P2-16 ${label} ${suffix}`, created_by_user_id: owner.id })).error);
  assert.ifError((await admin.from("projects").insert({ id: projectId, workspace_id: workspaceId, user_id: owner.id, name: `P2-16 ${label} project ${suffix}` })).error);
  assert.ifError((await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: owner.id, role: "owner" })).error);
  return { workspaceId, projectId, owner };
}

async function member(tenant: { workspaceId: string }, label: string, role: string) {
  const a = await actor(label, tenant.workspaceId, role);
  assert.ifError((await admin.from("workspace_memberships").insert({ workspace_id: tenant.workspaceId, user_id: a.id, role })).error);
  return a;
}

const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();

/** A → B feeds "Go-live" (target Oct 12); C is independent. Same shape as the unit fixtures. */
async function seedSchedule(tenant: { workspaceId: string; projectId: string }) {
  const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID(), milestone: randomUUID(), dep: randomUUID() };
  const scope = { workspace_id: tenant.workspaceId, project_id: tenant.projectId };
  assert.ifError((await admin.from("project_milestones").insert({ id: ids.milestone, ...scope, title: "Go-live", milestone_type: "go_live", status: "planned", target_date: day(12), baseline_date: day(12) })).error);
  const task = (id: string, title: string, start: number, finish: number, milestoneId: string | null = null) => ({
    id, ...scope, title, description: title, status: "not_started", schedule_status: "scheduled",
    planned_start_date: day(start), planned_finish_date: day(finish), milestone_id: milestoneId,
  });
  assert.ifError((await admin.from("execution_tasks").insert([task(ids.a, "Design", 1, 6), task(ids.b, "Build", 6, 16, ids.milestone), task(ids.c, "Training plan", 1, 6)])).error);
  assert.ifError((await admin.from("execution_task_dependencies").insert({ id: ids.dep, ...scope, predecessor_task_id: ids.a, successor_task_id: ids.b, dependency_type: "finish_to_start", status: "active", lag_days: 0 })).error);
  assert.ifError((await admin.from("execution_task_events").insert({ ...scope, task_id: ids.a, event_type: "dependency_activated", event_payload: { dependencyId: ids.dep, previousStatus: "proposed", newStatus: "active" } })).error);
  return ids;
}

async function count(table: string, filter: Record<string, string>) {
  let query = admin.from(table).select("id", { count: "exact", head: true });
  for (const [column, value] of Object.entries(filter)) query = query.eq(column, value);
  const { count: n, error } = await query;
  assert.ifError(error);
  return n ?? 0;
}

const CANONICAL = ["operational_sources", "operational_raw_inputs", "operational_normalized_events", "evidence_items", "operational_signals", "risk_issue_records", "governance_events", "recommended_actions", "agent_runs"];
const DOWNSTREAM = ["operational_decision_records", "material_action_proposals", "canonical_task_outcomes", "canonical_outcome_observations"];
async function snapshotCounts(projectId: string) {
  const out: Record<string, number> = {};
  for (const table of [...CANONICAL, ...DOWNSTREAM, "execution_tasks"]) out[table] = await count(table, { project_id: projectId });
  return out;
}

// ── Setup: two tenants ────────────────────────────────────────────────────────────────
const tenantA = await seedTenant("a");
const tenantB = await seedTenant("b");
const pmA = await member(tenantA, "a-pm", "pm");
const viewerA = await member(tenantA, "a-viewer", "viewer");
const scheduleA = await seedSchedule(tenantA);
const scheduleB = await seedSchedule(tenantB);
const scopeA = { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId, userId: pmA.id, role: "pm" };
const depRef = { kind: "dependency_change" as const, entityId: scheduleA.dep };

// ── 1. Positive: typed dependency change → Raw → Event → Evidence → Finding → Recommendation
const before = await snapshotCounts(tenantA.projectId);
const first = await evaluateAndRecordScheduleExposure(pmA.client, scopeA, depRef, { evaluatedAt: new Date().toISOString() });
equal(first.evaluation.status, "qualified", "same-tenant PM: dependency change qualifies");
equal(first.recorded?.disposition, "created", "first evaluation creates the canonical chain");
const rec = first.recorded!;

const source = (await admin.from("operational_sources").select("*").eq("id", rec.sourceId).single()).data!;
equal(source.source_kind, "engine", "Source kind is engine");
equal(source.source_key, SCHEDULE_EXPOSURE_SOURCE_KEY, "Source key is pinned server-side");
equal(source.is_fixture, false, "engine Source is not a fixture");

const raw = (await admin.from("operational_raw_inputs").select("*").eq("id", rec.rawInputId).single()).data!;
check(/^sha256:[a-f0-9]{64}$/.test(raw.content_digest) && !/^sha256:0{64}$/.test(raw.content_digest), "Raw Input carries a real content digest");
check(/^schedule-exposure:v1:[a-f0-9]{64}$/.test(raw.idempotency_key), "idempotency key is derived from snapshot + trigger (a digest, not a timestamp)");
equal(raw.causation_id, (await admin.from("execution_task_events").select("id").eq("project_id", tenantA.projectId).eq("event_type", "dependency_activated").single()).data!.id, "Raw Input causation is the H7 change event");
equal(raw.provenance.snapshotDigest, first.evaluation.snapshot.digest, "Raw Input provenance names the evaluated snapshot");
check(raw.provenance.evaluatedAt, "evaluatedAt is recorded in provenance");
equal(new Date(raw.occurred_at).toISOString(), first.evaluation.trigger.changedAt, "occurredAt is when the dependency changed");

const event = (await admin.from("operational_normalized_events").select("*").eq("id", rec.normalizedEventId).single()).data!;
equal(event.event_type, "schedule_exposure.evaluated", "typed Normalized Event");
equal(event.schema_version, 1, "event schema version 1");
equal(event.raw_input_id, raw.id, "Event → Raw Input");
equal(event.causation_id, raw.id, "Event causation is its Raw Input");
equal(event.correlation_id, raw.correlation_id, "correlation carried Raw → Event");

const evidence = (await admin.from("evidence_items").select("*").eq("id", rec.evidenceId).single()).data!;
equal(evidence.normalized_event_id, event.id, "Evidence → Normalized Event");
equal(evidence.raw_input_id, raw.id, "Evidence → Raw Input");
equal(evidence.source_type, "schedule_evaluation", "Evidence is not labelled as a manual note");
equal(evidence.assertion_type, "INFERENCE", "schedule exposure is an inference, not a fact");
equal(evidence.classification, "RISK", "classification RISK");
equal(Number(evidence.confidence_score), 0.9, "Evidence confidence persisted on the 0–1 scale");
equal(evidence.missing_data_state, "COMPLETE", "complete coverage");
equal(evidence.fixture_state, "LIVE", "engine Evidence is live, never DEMO_FIXTURE");
equal(evidence.metadata.snapshotDigest, first.evaluation.snapshot.digest, "Evidence is bound to the snapshot");
equal(evidence.causation_id, event.id, "Evidence causation is its Event");
check(/^[a-f0-9]{64}$/.test(evidence.evidence_hash) && evidence.evidence_hash !== "0".repeat(64), "Evidence hash is real, not a placeholder");

const signal = (await admin.from("operational_signals").select("*").eq("id", rec.findingId).single()).data!;
equal(signal.evidence_item_id, evidence.id, "Finding → Evidence");
equal(signal.signal_type, "schedule_risk", "Finding type schedule_risk");
equal(Number(signal.confidence_score), 90, "Finding confidence persisted on the 0–100 scale (0.9 → 90.00)");
equal(signal.detected_by, "system/deterministic:schedule_exposure_adapter_v1", "Finding names the schedule adapter, not the keyword detector");
check(signal.rationale.includes(first.evaluation.snapshot.digest.slice(0, 23)), "Finding rationale names the snapshot (digest prefix; full digest bound on Evidence/Raw/Event/Recommendation)");
equal(signal.severity, "high", "severity derived from engine slippage on the critical path");

const recommendation = (await admin.from("recommended_actions").select("*").eq("id", rec.recommendationId).single()).data!;
equal(recommendation.source_signal_id, signal.id, "Recommendation → Finding via canonical source_signal_id");
equal(recommendation.status, "proposed", "Recommendation is governed but NOT decided");
equal(recommendation.recommended_action_type, "confirm_dependency", "dependency change → confirm_dependency");
check(recommendation.governance_event_id, "Recommendation is governed (governance event)");
equal(recommendation.rationale.snapshotDigest, first.evaluation.snapshot.digest, "Recommendation rationale names the snapshot");

const afterFirst = await snapshotCounts(tenantA.projectId);
for (const table of ["operational_raw_inputs", "operational_normalized_events", "evidence_items", "operational_signals", "risk_issue_records", "governance_events", "recommended_actions", "agent_runs"]) {
  equal(afterFirst[table] - before[table], 1, `exactly one new ${table} row`);
}

// ── 2. No automatic downstream creation ───────────────────────────────────────────────
for (const table of [...DOWNSTREAM, "execution_tasks"]) equal(afterFirst[table], before[table], `no ${table} created by the adapter`);

// ── 3. Idempotent replay: same snapshot + same change, later clock ─────────────────────
const replay = await evaluateAndRecordScheduleExposure(pmA.client, scopeA, depRef, { evaluatedAt: new Date(Date.now() + 60_000).toISOString() });
equal(replay.recorded?.disposition, "duplicate", "replay is reported as duplicate");
equal(replay.recorded?.evidenceId, rec.evidenceId, "replay resolves to the same Evidence");
equal(replay.recorded?.findingId, rec.findingId, "replay resolves to the same Finding");
equal(replay.recorded?.recommendationId, rec.recommendationId, "replay resolves to the same Recommendation");
equal(replay.recorded?.correlationId, rec.correlationId, "replay keeps the first correlation");
const afterReplay = await snapshotCounts(tenantA.projectId);
for (const table of Object.keys(afterReplay)) equal(afterReplay[table], afterFirst[table], `replay adds no ${table} row`);

// Same idempotency identity, different content → explicit conflict, never a second row.
const tampered = buildScheduleExposurePayload(first.evaluation, [{ id: scheduleA.a, title: "Design (renamed)" }, { id: scheduleA.b, title: "Build" }]);
await rpcError(pmA.client, "capture_schedule_exposure_evaluation", {
  p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_payload: tampered,
  p_occurred_at: first.evaluation.trigger.changedAt, p_evaluated_at: new Date().toISOString(), p_correlation_id: randomUUID(),
}, /schedule_exposure_idempotency_conflict/, "same snapshot+change with different content is a conflict");

// ── 4. Partial data: honest lower confidence on both scales ──────────────────────────
assert.ifError((await admin.from("execution_tasks").update({ planned_start_date: null, planned_finish_date: null }).eq("id", scheduleA.c)).error);
const partial = await evaluateAndRecordScheduleExposure(pmA.client, scopeA, depRef);
equal(partial.evaluation.missingDataState, "PARTIAL", "missing task dates → PARTIAL");
equal(partial.recorded?.disposition, "created", "a different snapshot is a new, separately bound chain");
check(partial.evaluation.snapshot.digest !== first.evaluation.snapshot.digest, "partial evaluation is bound to a different snapshot");
const partialEvidence = (await admin.from("evidence_items").select("confidence_score,missing_data_state").eq("id", partial.recorded!.evidenceId).single()).data!;
equal(Number(partialEvidence.confidence_score), 0.6, "PARTIAL Evidence confidence 0.6000");
equal(partialEvidence.missing_data_state, "PARTIAL", "PARTIAL persisted on Evidence");
equal(Number((await admin.from("operational_signals").select("confidence_score").eq("id", partial.recorded!.findingId).single()).data!.confidence_score), 60, "PARTIAL Finding 60.00");
assert.ifError((await admin.from("execution_tasks").update({ planned_start_date: day(1), planned_finish_date: day(6) }).eq("id", scheduleA.c)).error);

// ── 5. Insufficient data: nothing recorded, and the database refuses UNKNOWN directly ─
assert.ifError((await admin.from("project_milestones").update({ target_date: null }).eq("id", scheduleA.milestone)).error);
const beforeInsufficient = await snapshotCounts(tenantA.projectId);
const insufficient = await evaluateAndRecordScheduleExposure(pmA.client, scopeA, depRef);
equal(insufficient.evaluation.status, "insufficient_data", "missing milestone target → insufficient_data");
equal(insufficient.recorded, null, "insufficient data is not recorded");
const afterInsufficient = await snapshotCounts(tenantA.projectId);
for (const table of CANONICAL) equal(afterInsufficient[table], beforeInsufficient[table], `insufficient data adds no ${table} row`);
assert.ifError((await admin.from("project_milestones").update({ target_date: day(12) }).eq("id", scheduleA.milestone)).error);
const unknownPayload = { ...tampered, evaluation: { ...(tampered.evaluation as object), missingDataState: "UNKNOWN" } };
await rpcError(pmA.client, "capture_schedule_exposure_evaluation", {
  p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_payload: unknownPayload,
  p_occurred_at: new Date().toISOString(), p_evaluated_at: new Date().toISOString(), p_correlation_id: randomUUID(),
}, /schedule_exposure_insufficient_data/, "the database refuses an UNKNOWN evaluation");

// ── 6. Invalid topology: refused, nothing recorded, no fabricated path ────────────────
const cycleId = randomUUID();
assert.ifError((await admin.from("execution_task_dependencies").insert({ id: cycleId, workspace_id: tenantA.workspaceId, project_id: tenantA.projectId, predecessor_task_id: scheduleA.b, successor_task_id: scheduleA.a, dependency_type: "finish_to_start", status: "active", lag_days: 0 })).error);
const beforeCycle = await snapshotCounts(tenantA.projectId);
const cyclic = await evaluateAndRecordScheduleExposure(pmA.client, scopeA, depRef);
equal(cyclic.evaluation.status, "invalid_topology", "cycle → invalid_topology");
equal(cyclic.evaluation.topologyIssues[0]?.type, "cycle_detected", "cycle is named");
equal(cyclic.evaluation.criticalTaskIds.length, 0, "no critical path fabricated from a cycle");
equal(cyclic.recorded, null, "invalid topology records nothing");
const afterCycle = await snapshotCounts(tenantA.projectId);
for (const table of CANONICAL) equal(afterCycle[table], beforeCycle[table], `invalid topology adds no ${table} row`);
assert.ifError((await admin.from("execution_task_dependencies").update({ status: "invalidated" }).eq("id", cycleId)).error);

// ── 7. Tenancy ────────────────────────────────────────────────────────────────────────
const validPayload = buildScheduleExposurePayload(first.evaluation, [{ id: scheduleA.a, title: "Design" }, { id: scheduleA.b, title: "Build" }]);
const captureArgs = (workspaceId: string, projectId: string, payload: unknown) => ({
  p_workspace_id: workspaceId, p_project_id: projectId, p_payload: payload,
  p_occurred_at: new Date().toISOString(), p_evaluated_at: new Date().toISOString(), p_correlation_id: randomUUID(),
});
await rejects(evaluateAndRecordScheduleExposure(viewerA.client, { ...scopeA, userId: viewerA.id, role: "viewer" }, depRef), /schedule_exposure_role_denied/, "viewer is refused by the service");
await rpcError(viewerA.client, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, validPayload), /schedule_exposure_access_denied/, "viewer is refused by the database even when calling the RPC directly");
await rpcError(tenantB.owner.client, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, validPayload), /schedule_exposure_access_denied/, "cross-tenant owner cannot capture into tenant A");
await rpcError(tenantB.owner.client, "derive_schedule_exposure_evidence", { p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_normalized_event_id: event.id }, /evidence_access_denied/, "cross-tenant owner cannot derive tenant A Evidence");
await rpcError(tenantB.owner.client, "materialize_schedule_exposure_finding", { p_evidence_item_id: evidence.id }, /operational_write_denied/, "cross-tenant owner cannot materialize tenant A Finding");
await rejects(
  evaluateAndRecordScheduleExposure(tenantB.owner.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId, userId: tenantB.owner.id, role: "owner" }, depRef),
  /schedule_exposure_trigger_not_found/,
  "cross-tenant caller cannot even see tenant A's dependency (RLS)",
);
const scopeB = { workspaceId: tenantB.workspaceId, projectId: tenantB.projectId };
for (const table of ["operational_raw_inputs", "operational_normalized_events", "evidence_items", "operational_signals", "recommended_actions"]) {
  const { data, error } = await tenantB.owner.client.from(table).select("id").eq("project_id", tenantA.projectId);
  check(!error && (data ?? []).length === 0, `RLS: tenant B reads no tenant A ${table}`);
}
equal((await listScheduleExposures(tenantB.owner.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId })).length, 0, "tenant B projection of tenant A is empty");
check((await listScheduleExposures(viewerA.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId })).length >= 2, "same-tenant viewer can read the exposures");
// Wrong project: tenant A's pm points a trigger from tenant B's project at tenant A's scope, and vice versa.
const foreignTrigger = { ...validPayload, trigger: { ...(validPayload.trigger as object), entityId: scheduleB.dep } };
await rpcError(pmA.client, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, foreignTrigger), /schedule_exposure_trigger_scope_mismatch/, "a trigger entity from another project is refused");
await rpcError(pmA.client, "capture_schedule_exposure_evaluation", captureArgs(tenantB.workspaceId, tenantB.projectId, validPayload), /schedule_exposure_access_denied/, "pm A cannot write into project B");
await rpcError(pmA.client, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantB.projectId, validPayload), /schedule_exposure_access_denied/, "workspace A + project B mismatch is refused");
const anon = createClient(supabaseUrl, anonKey, options);
await rpcError(anon, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, validPayload), /permission denied|schedule_exposure_unauthenticated/, "anonymous callers are refused");

// ── 8. Contract misuse and boundary with the P2-04 manual path ────────────────────────
await rpcError(pmA.client, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, { ...validPayload, adapter: "someone-else:v9" }), /schedule_exposure_payload_invalid/, "unknown adapter version refused");
await rpcError(pmA.client, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, { ...validPayload, evaluation: { ...(validPayload.evaluation as object), confidence: 92 } }), /schedule_exposure_confidence_invalid/, "a percentage-scale confidence is refused at the 0–1 boundary");
await rpcError(pmA.client, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, { ...validPayload, evaluation: { ...(validPayload.evaluation as object), status: "invalid_topology" } }), /schedule_exposure_not_qualified/, "a non-qualified evaluation cannot be recorded");
await rpcError(pmA.client, "derive_operational_evidence", {
  p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_normalized_event_id: event.id, p_idempotency_key: `p2-16-${suffix}`,
  p_assertion_type: "FACT", p_classification: "RISK", p_confidence_score: 1, p_missing_data_state: "COMPLETE", p_evaluated_at: new Date().toISOString(),
}, /normalized_event_version_unsupported/, "the P2-04 manual derivation refuses a schedule event (no FACT relabelling)");
const manual = await pmA.client.rpc("capture_live_operational_input", {
  p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_source_key: "live-observation:v1", p_idempotency_key: `p2-16-manual-${suffix}`,
  p_title: "Manual note", p_content: "A manual observation.", p_occurred_at: new Date().toISOString(), p_correlation_id: randomUUID(),
});
assert.ifError(manual.error);
await rpcError(pmA.client, "derive_schedule_exposure_evidence", { p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_normalized_event_id: manual.data.normalizedEvent.id }, /normalized_event_version_unsupported/, "schedule derivation refuses a manual event");
await rpcError(tenantB.owner.client, "capture_live_operational_input", {
  p_workspace_id: tenantB.workspaceId, p_project_id: tenantB.projectId, p_source_key: SCHEDULE_EXPOSURE_SOURCE_KEY, p_idempotency_key: `p2-16-poison-${suffix}`,
  p_title: "Poison", p_content: "Attempt to mint the engine Source as a connector.", p_occurred_at: new Date().toISOString(), p_correlation_id: randomUUID(),
}, /operational_sources_engine_identity_check/, "live intake cannot mint the engine Source identity");

// ── 9. Compatibility: the existing canonical read model consumes the result unchanged ─
const summary = await getOperationalSummary(pmA.client, tenantA.workspaceId, tenantA.projectId, pmA.id) as unknown as {
  signals: Array<{ id: string }>; recommendations: Array<{ id: string; source_signal_id?: string }>;
};
check(summary.signals.some((s) => s.id === rec.findingId), "operational summary lists the schedule Finding");
check(summary.recommendations.some((r) => r.id === rec.recommendationId), "operational summary lists the governed schedule Recommendation");
const projection = await listScheduleExposures(pmA.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId });
const projected = projection.find((p) => p.evidenceId === rec.evidenceId)!;
equal(projected.finding?.confidenceScore, 90, "projection keeps the Finding on its persisted 0–100 scale");
equal(projected.confidence, 0.9, "projection keeps Evidence on its 0–1 scale");
equal(projected.snapshotDigest, first.evaluation.snapshot.digest, "projection exposes the bound snapshot");
equal(projected.recommendation?.status, "proposed", "projection shows the Recommendation undecided");

// Recomputing the snapshot from the live rows reproduces the recorded digest.
const reeval = evaluateScheduleExposure({
  tasks: (await pmA.client.from("execution_tasks").select("*").eq("project_id", tenantA.projectId)).data as never,
  dependencies: ((await pmA.client.from("execution_task_dependencies").select("*").eq("project_id", tenantA.projectId)).data ?? []).filter((d: { id: string }) => d.id !== cycleId) as never,
  milestones: (await pmA.client.from("project_milestones").select("*").eq("project_id", tenantA.projectId)).data as never,
  trigger: first.evaluation.trigger,
  evaluatedAt: new Date().toISOString(),
});
equal(reeval.snapshot.digest, first.evaluation.snapshot.digest, "the recorded snapshot is reproducible from the restored schedule");
void scopeB;

console.log(`P2-16 DB verification PASS (${assertions} assertions).`);
console.log(`CHAIN ${source.source_key} → raw ${raw.id} → event ${event.id} → evidence ${evidence.id} → finding ${signal.id} → recommendation ${recommendation.id} (proposed)`);
console.log(`SNAPSHOT ${first.evaluation.snapshot.digest}`);
