/**
 * P2-16 live verification — Schedule Exposure adapter against the disposable local stack.
 *
 * Drives the REAL adapter service (src/lib/critical-path/schedule-exposure-service.ts) the way
 * the route does: every READ runs on the caller's own authenticated client (anon key + session,
 * so RLS applies), and the three canonical adapter RPCs run on the service-role client, which is
 * the trusted write transport in production (src/lib/critical-path/schedule-exposure-trusted-writer.ts).
 * The service-role client is otherwise used only to seed fixtures, perturb the schedule between
 * steps, and count rows. It never makes an invalid human actor valid — that is asserted below.
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
  resumeScheduleExposureMaterialization,
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
/** Seeding/counting AND the trusted adapter write transport (as in production). */
const admin = createClient(supabaseUrl, serviceRoleKey, options);
const writer = admin;
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

type Actor = { id: string; client: SupabaseClient };
async function actor(label: string): Promise<Actor> {
  const email = `p2-16-${label}-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const client = createClient(supabaseUrl!, anonKey!, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  return { id: created.data.user!.id, client };
}

async function seedTenant(label: string) {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const owner = await actor(`${label}-owner`);
  assert.ifError((await admin.from("workspaces").insert({ id: workspaceId, name: `P2-16 ${label} ${suffix}`, created_by_user_id: owner.id })).error);
  assert.ifError((await admin.from("projects").insert({ id: projectId, workspace_id: workspaceId, user_id: owner.id, name: `P2-16 ${label} project ${suffix}` })).error);
  assert.ifError((await admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: owner.id, role: "owner" })).error);
  return { workspaceId, projectId, owner };
}

async function member(tenant: { workspaceId: string }, label: string, role: string) {
  const a = await actor(label);
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

/** The trusted writer with materialisation forced to fail — a transient failure after derive. */
function failingMaterializeWriter(): SupabaseClient {
  return new Proxy(writer, {
    get(target, prop) {
      if (prop === "rpc") {
        return (name: string, args: Record<string, unknown>) =>
          name === "materialize_schedule_exposure_finding"
            ? Promise.resolve({ data: null, error: { message: "forced_materialize_failure" } })
            : target.rpc(name, args);
      }
      return Reflect.get(target, prop);
    },
  }) as SupabaseClient;
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
const first = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, depRef, { evaluatedAt: new Date().toISOString() });
equal(first.evaluation.status, "qualified", "same-tenant PM: dependency change qualifies");
equal(first.recorded?.disposition, "created", "first evaluation creates the canonical chain");
const rec = first.recorded!;

const source = (await admin.from("operational_sources").select("*").eq("id", rec.sourceId).single()).data!;
equal(source.source_kind, "engine", "Source kind is engine");
equal(source.source_key, SCHEDULE_EXPOSURE_SOURCE_KEY, "Source key is pinned server-side");
equal(source.is_fixture, false, "engine Source is not a fixture");
equal(source.created_by, pmA.id, "Source is attributed to the verified human, not the service role");

const changeEvent = (await admin.from("execution_task_events").select("id,created_at").eq("project_id", tenantA.projectId).eq("event_type", "dependency_activated").single()).data!;
const raw = (await admin.from("operational_raw_inputs").select("*").eq("id", rec.rawInputId).single()).data!;
check(/^sha256:[a-f0-9]{64}$/.test(raw.content_digest) && !/^sha256:0{64}$/.test(raw.content_digest), "Raw Input carries a real content digest");
check(/^schedule-exposure:v1:[a-f0-9]{64}$/.test(raw.idempotency_key), "idempotency key is derived from snapshot + trigger (a digest, not a timestamp)");
equal(raw.actor_user_id, pmA.id, "Raw Input actor is the verified human PM");
equal(raw.provenance.capturedBy, pmA.id, "provenance names the verified human");
equal(raw.causation_id, changeEvent.id, "Raw Input causation is the H7 change event");
equal(new Date(raw.occurred_at).toISOString(), new Date(changeEvent.created_at).toISOString(), "occurredAt is when H7 recorded the dependency change");
equal(raw.provenance.snapshotDigest, first.evaluation.snapshot.digest, "Raw Input provenance names the evaluated snapshot");
check(raw.provenance.evaluatedAt, "evaluatedAt is recorded in provenance");

const event = (await admin.from("operational_normalized_events").select("*").eq("id", rec.normalizedEventId).single()).data!;
equal(event.event_type, "schedule_exposure.evaluated", "typed Normalized Event");
equal(event.schema_version, 1, "event schema version 1");
equal(event.raw_input_id, raw.id, "Event → Raw Input");
equal(event.causation_id, raw.id, "Event causation is its Raw Input");
equal(event.correlation_id, raw.correlation_id, "correlation carried Raw → Event");
equal(event.actor_user_id, pmA.id, "Event actor is the verified human");

const evidence = (await admin.from("evidence_items").select("*").eq("id", rec.evidenceId).single()).data!;
equal(evidence.normalized_event_id, event.id, "Evidence → Normalized Event");
equal(evidence.raw_input_id, raw.id, "Evidence → Raw Input");
equal(evidence.created_by, pmA.id, "Evidence authorship is the upstream verified human");
equal(evidence.source_type, "schedule_evaluation", "Evidence is not labelled as a manual note");
equal(evidence.assertion_type, "INFERENCE", "schedule exposure is an inference, not a fact");
equal(evidence.classification, "RISK", "classification RISK");
equal(Number(evidence.confidence_score), 0.9, "Evidence confidence persisted on the 0–1 scale");
equal(evidence.missing_data_state, "COMPLETE", "complete coverage");
equal(evidence.fixture_state, "LIVE", "engine Evidence is live, never DEMO_FIXTURE");
equal(evidence.metadata.snapshotDigest, first.evaluation.snapshot.digest, "Evidence is bound to the snapshot");
equal(evidence.causation_id, event.id, "Evidence causation is its Event");
check(/^[a-f0-9]{64}$/.test(evidence.evidence_hash) && evidence.evidence_hash !== "0".repeat(64), "Evidence hash is real, not a placeholder");
const evidenceEvent = (await admin.from("platform_events").select("actor_id").eq("raw_reference_table", "evidence_items").eq("raw_reference_id", evidence.id).single()).data!;
equal(evidenceEvent.actor_id, pmA.id, "platform event actor is the verified human, not the service role");

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
const replay = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, depRef, { evaluatedAt: new Date(Date.now() + 60_000).toISOString() });
equal(replay.recorded?.disposition, "duplicate", "replay is reported as duplicate");
equal(replay.recorded?.evidenceId, rec.evidenceId, "replay resolves to the same Evidence");
equal(replay.recorded?.findingId, rec.findingId, "replay resolves to the same Finding");
equal(replay.recorded?.recommendationId, rec.recommendationId, "replay resolves to the same Recommendation");
equal(replay.recorded?.correlationId, rec.correlationId, "replay keeps the first correlation");
const afterReplay = await snapshotCounts(tenantA.projectId);
for (const table of Object.keys(afterReplay)) equal(afterReplay[table], afterFirst[table], `replay adds no ${table} row`);

// Same idempotency identity, different content → explicit conflict, never a second row.
const tampered = buildScheduleExposurePayload(first.evaluation, [{ id: scheduleA.a, title: "Design (renamed only in payload)" }, { id: scheduleA.b, title: "Build" }]);
const captureArgs = (workspaceId: string, projectId: string, actorUserId: string | null, payload: unknown) => ({
  p_workspace_id: workspaceId, p_project_id: projectId, p_actor_user_id: actorUserId, p_payload: payload,
  p_occurred_at: new Date().toISOString(), p_evaluated_at: new Date().toISOString(), p_correlation_id: randomUUID(),
});
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, tampered), /schedule_exposure_idempotency_conflict/, "same snapshot+change with different content is a conflict");

// ── 4. FINDING #1 — trusted write boundary ────────────────────────────────────────────
const validPayload = buildScheduleExposurePayload(first.evaluation, [{ id: scheduleA.a, title: "Design" }, { id: scheduleA.b, title: "Build" }]);
const fabricated = { ...validPayload, severity: "critical", title: "Fabricated exposure", exposures: [{ milestoneId: scheduleA.milestone, title: "Go-live", reasons: ["made up"] }], evaluation: { ...(validPayload.evaluation as object), confidence: 0.99 } };
// The exact hole: a same-project owner/PM calling the RPCs directly through Supabase.
for (const [label, client] of [["same-project PM", pmA.client], ["same-project owner", tenantA.owner.client], ["same-project viewer", viewerA.client], ["cross-tenant owner", tenantB.owner.client]] as const) {
  await rpcError(client, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, fabricated), /permission denied for function capture_schedule_exposure_evaluation/, `${label}: direct capture is denied at the privilege boundary`);
  await rpcError(client, "derive_schedule_exposure_evidence", { p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_normalized_event_id: event.id, p_actor_user_id: pmA.id }, /permission denied for function derive_schedule_exposure_evidence/, `${label}: direct derive is denied`);
  await rpcError(client, "materialize_schedule_exposure_finding", { p_evidence_item_id: evidence.id, p_actor_user_id: pmA.id }, /permission denied for function materialize_schedule_exposure_finding/, `${label}: direct materialize is denied`);
}
const anon = createClient(supabaseUrl, anonKey, options);
await rpcError(anon, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, fabricated), /permission denied for function/, "anonymous callers are denied");
// The service role is transport, not authority: an invalid human actor stays invalid.
const outsider = tenantB.owner;
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, viewerA.id, validPayload), /schedule_exposure_access_denied/, "service role + viewer actor → denied");
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, outsider.id, validPayload), /schedule_exposure_access_denied/, "service role + actor outside the workspace → denied");
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantB.projectId, pmA.id, validPayload), /schedule_exposure_access_denied/, "service role + workspace/project mismatch → denied");
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, randomUUID(), validPayload), /schedule_exposure_access_denied/, "service role + nonexistent actor → denied");
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, null, validPayload), /schedule_exposure_actor_required/, "service role + no actor → denied");
await rpcError(writer, "derive_schedule_exposure_evidence", { p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_normalized_event_id: event.id, p_actor_user_id: viewerA.id }, /evidence_access_denied/, "service role + viewer requester cannot derive");
await rpcError(writer, "materialize_schedule_exposure_finding", { p_evidence_item_id: evidence.id, p_actor_user_id: outsider.id }, /operational_write_denied/, "service role + outsider requester cannot materialize");
const afterBoundary = await snapshotCounts(tenantA.projectId);
for (const table of CANONICAL) equal(afterBoundary[table], afterFirst[table], `no refused call wrote ${table}`);
equal(await count("operational_signals", { project_id: tenantA.projectId, severity: "critical" }), 0, "no fabricated critical Finding exists");
await rejects(evaluateAndRecordScheduleExposure(viewerA.client, writer, { ...scopeA, userId: viewerA.id, role: "viewer" }, depRef), /schedule_exposure_role_denied/, "viewer is refused by the service before any write");

// ── 5. FINDING #3 — payload-affecting labels are snapshot-bound ───────────────────────
assert.ifError((await admin.from("execution_tasks").update({ title: "Design (v2)" }).eq("id", scheduleA.a)).error);
const renamedTask = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, depRef);
equal(renamedTask.recorded?.disposition, "created", "task rename → a new valid evaluation, not idempotency_conflict");
check(renamedTask.evaluation.snapshot.digest !== first.evaluation.snapshot.digest, "task rename → new snapshot digest");
assert.ifError((await admin.from("project_milestones").update({ title: "Go-live (phase 1)" }).eq("id", scheduleA.milestone)).error);
const renamedMilestone = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, depRef);
equal(renamedMilestone.recorded?.disposition, "created", "milestone rename → a new valid evaluation, not idempotency_conflict");
check(renamedMilestone.evaluation.snapshot.digest !== renamedTask.evaluation.snapshot.digest, "milestone rename → new snapshot digest");
const sameAgain = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, depRef);
equal(sameAgain.recorded?.disposition, "duplicate", "same schedule + same labels → duplicate");
assert.ifError((await admin.from("execution_tasks").update({ title: "Design" }).eq("id", scheduleA.a)).error);
assert.ifError((await admin.from("project_milestones").update({ title: "Go-live" }).eq("id", scheduleA.milestone)).error);

// ── 6. FINDING #4 — the milestone path is a current-state evaluation ───────────────────
assert.ifError((await admin.from("project_milestones").update({ forecast_date: day(20) }).eq("id", scheduleA.milestone)).error);
const milestoneEvalAt = new Date().toISOString();
const milestoneRun = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, { kind: "milestone_state_evaluation", entityId: scheduleA.milestone }, { evaluatedAt: milestoneEvalAt });
equal(milestoneRun.recorded?.disposition, "created", "milestone state evaluation records");
const milestoneRaw = (await admin.from("operational_raw_inputs").select("payload,occurred_at,causation_id").eq("id", milestoneRun.recorded!.rawInputId).single()).data!;
equal(milestoneRaw.payload.trigger.kind, "milestone_state_evaluation", "persisted trigger is a current-state evaluation");
equal("changedAt" in milestoneRaw.payload.trigger, false, "no change time is claimed for the milestone");
check(typeof milestoneRaw.payload.trigger.sourceUpdatedAt === "string", "updated_at is kept as source-row provenance only");
equal(new Date(milestoneRaw.occurred_at).toISOString(), milestoneEvalAt, "occurredAt is the evaluation, not the row's updated_at");
equal(milestoneRaw.causation_id, null, "no fabricated change event");
check(!/date[_ ]change|dates recorded/i.test(JSON.stringify(milestoneRaw.payload)), "the payload never claims a date change");
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, { ...validPayload, trigger: { ...(validPayload.trigger as object), kind: "milestone_date_change" } }), /schedule_exposure_trigger_invalid/, "the retired milestone_date_change kind is refused by the database");
assert.ifError((await admin.from("project_milestones").update({ forecast_date: null }).eq("id", scheduleA.milestone)).error);

// ── 7. FINDING #5 — partial chain is visible and resumes for the exact Evidence ───────
assert.ifError((await admin.from("execution_task_dependencies").update({ lag_days: 2 }).eq("id", scheduleA.dep)).error);
await rejects(evaluateAndRecordScheduleExposure(pmA.client, failingMaterializeWriter(), scopeA, depRef), /forced_materialize_failure/, "a materialisation failure is surfaced, never reported as success");
let projection = await listScheduleExposures(pmA.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId });
const partial = projection.find((p) => p.materializationState === "incomplete");
check(partial, "the committed Evidence without a Finding is listed as incomplete");
equal(partial!.finding, null, "no Finding is fabricated for the incomplete chain");
equal(partial!.recommendation, null, "no Recommendation is fabricated for the incomplete chain");
check(projection.filter((p) => p.evidenceId !== partial!.evidenceId).every((p) => p.materializationState === "complete"), "complete chains stay complete");
await rejects(resumeScheduleExposureMaterialization(viewerA.client, writer, { ...scopeA, userId: viewerA.id, role: "viewer" }, partial!.evidenceId), /schedule_exposure_role_denied/, "viewer cannot resume");
await rejects(resumeScheduleExposureMaterialization(outsider.client, writer, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId, userId: outsider.id, role: "owner" }, partial!.evidenceId), /schedule_exposure_evidence_not_found/, "cross-tenant actor cannot resume (Evidence not visible)");
await rejects(resumeScheduleExposureMaterialization(outsider.client, writer, { workspaceId: tenantB.workspaceId, projectId: tenantB.projectId, userId: outsider.id, role: "owner" }, partial!.evidenceId), /schedule_exposure_evidence_not_found/, "wrong-project Evidence cannot be resumed");
equal(await count("operational_signals", { evidence_item_id: partial!.evidenceId }), 0, "refused resumes wrote nothing");
const resumed = await resumeScheduleExposureMaterialization(pmA.client, writer, scopeA, partial!.evidenceId);
equal(resumed.disposition, "created", "authorised PM resume materialises the exact persisted Evidence");
equal((await admin.from("operational_signals").select("evidence_item_id").eq("id", resumed.findingId).single()).data!.evidence_item_id, partial!.evidenceId, "the Finding belongs to that exact Evidence");
equal((await resumeScheduleExposureMaterialization(pmA.client, writer, scopeA, partial!.evidenceId)).disposition, "duplicate", "repeated resume is idempotent");
projection = await listScheduleExposures(pmA.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId });
equal(projection.find((p) => p.evidenceId === partial!.evidenceId)?.materializationState, "complete", "after resume the chain is complete");

// ── 8. FINDING #2 — concurrent materialisation is serialised ──────────────────────────
assert.ifError((await admin.from("execution_task_dependencies").update({ lag_days: 3 }).eq("id", scheduleA.dep)).error);
await rejects(evaluateAndRecordScheduleExposure(pmA.client, failingMaterializeWriter(), scopeA, depRef), /forced_materialize_failure/, "prepare an unmaterialised Evidence for the race");
projection = await listScheduleExposures(pmA.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId });
const raceEvidence = projection.find((p) => p.materializationState === "incomplete")!.evidenceId;
const CONCURRENCY = 12;
const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => writer.rpc("materialize_schedule_exposure_finding", { p_evidence_item_id: raceEvidence, p_actor_user_id: pmA.id })));
check(results.every((r) => !r.error), `all ${CONCURRENCY} concurrent materialisations succeed`);
equal(results.filter((r) => r.data.disposition === "created").length, 1, "exactly one concurrent call reports created");
equal(results.filter((r) => r.data.disposition === "duplicate").length, CONCURRENCY - 1, "every other concurrent call reports duplicate");
const raceSignals = (await admin.from("operational_signals").select("id").eq("evidence_item_id", raceEvidence)).data ?? [];
equal(raceSignals.length, 1, "exactly 1 Finding");
equal(await count("risk_issue_records", { signal_id: raceSignals[0].id }), 1, "exactly 1 risk record");
const raceRisk = (await admin.from("risk_issue_records").select("id").eq("signal_id", raceSignals[0].id).single()).data!;
equal(await count("governance_events", { related_entity_id: raceRisk.id }), 1, "exactly 1 governance event");
equal(await count("recommended_actions", { source_signal_id: raceSignals[0].id }), 1, "exactly 1 Recommendation");
const raceOutputs = (await admin.from("agent_outputs").select("agent_run_id").eq("output_payload->>evidenceItemId", raceEvidence)).data ?? [];
equal(raceOutputs.length, 1, "exactly 1 agent_output");
equal(await count("agent_runs", { id: raceOutputs[0].agent_run_id }), 1, "exactly 1 agent_run");
assert.ifError((await admin.from("execution_task_dependencies").update({ lag_days: 0 }).eq("id", scheduleA.dep)).error);

// ── 9. Partial data: honest lower confidence on both scales ──────────────────────────
assert.ifError((await admin.from("execution_tasks").update({ planned_start_date: null, planned_finish_date: null }).eq("id", scheduleA.c)).error);
const partialData = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, depRef);
equal(partialData.evaluation.missingDataState, "PARTIAL", "missing task dates → PARTIAL");
equal(partialData.recorded?.disposition, "created", "a different snapshot is a new, separately bound chain");
const partialEvidence = (await admin.from("evidence_items").select("confidence_score,missing_data_state").eq("id", partialData.recorded!.evidenceId).single()).data!;
equal(Number(partialEvidence.confidence_score), 0.6, "PARTIAL Evidence confidence 0.6000");
equal(Number((await admin.from("operational_signals").select("confidence_score").eq("id", partialData.recorded!.findingId).single()).data!.confidence_score), 60, "PARTIAL Finding 60.00");
assert.ifError((await admin.from("execution_tasks").update({ planned_start_date: day(1), planned_finish_date: day(6) }).eq("id", scheduleA.c)).error);

// ── 10. Insufficient data: nothing recorded, and the database refuses UNKNOWN directly
assert.ifError((await admin.from("project_milestones").update({ target_date: null }).eq("id", scheduleA.milestone)).error);
const beforeInsufficient = await snapshotCounts(tenantA.projectId);
const insufficient = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, depRef);
equal(insufficient.evaluation.status, "insufficient_data", "missing milestone target → insufficient_data");
equal(insufficient.recorded, null, "insufficient data is not recorded");
const afterInsufficient = await snapshotCounts(tenantA.projectId);
for (const table of CANONICAL) equal(afterInsufficient[table], beforeInsufficient[table], `insufficient data adds no ${table} row`);
assert.ifError((await admin.from("project_milestones").update({ target_date: day(12) }).eq("id", scheduleA.milestone)).error);
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, { ...validPayload, evaluation: { ...(validPayload.evaluation as object), missingDataState: "UNKNOWN" } }), /schedule_exposure_insufficient_data/, "the database refuses an UNKNOWN evaluation");

// ── 11. Invalid topology: refused, nothing recorded, no fabricated path ───────────────
const cycleId = randomUUID();
assert.ifError((await admin.from("execution_task_dependencies").insert({ id: cycleId, workspace_id: tenantA.workspaceId, project_id: tenantA.projectId, predecessor_task_id: scheduleA.b, successor_task_id: scheduleA.a, dependency_type: "finish_to_start", status: "active", lag_days: 0 })).error);
const beforeCycle = await snapshotCounts(tenantA.projectId);
const cyclic = await evaluateAndRecordScheduleExposure(pmA.client, writer, scopeA, depRef);
equal(cyclic.evaluation.status, "invalid_topology", "cycle → invalid_topology");
equal(cyclic.evaluation.topologyIssues[0]?.type, "cycle_detected", "cycle is named");
equal(cyclic.evaluation.criticalTaskIds.length, 0, "no critical path fabricated from a cycle");
equal(cyclic.recorded, null, "invalid topology records nothing");
const afterCycle = await snapshotCounts(tenantA.projectId);
for (const table of CANONICAL) equal(afterCycle[table], beforeCycle[table], `invalid topology adds no ${table} row`);
assert.ifError((await admin.from("execution_task_dependencies").update({ status: "invalidated" }).eq("id", cycleId)).error);

// ── 12. Read tenancy ──────────────────────────────────────────────────────────────────
await rejects(
  evaluateAndRecordScheduleExposure(outsider.client, writer, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId, userId: outsider.id, role: "owner" }, depRef),
  /schedule_exposure_trigger_not_found/,
  "cross-tenant caller cannot even see tenant A's dependency (RLS)",
);
for (const table of ["operational_raw_inputs", "operational_normalized_events", "evidence_items", "operational_signals", "recommended_actions"]) {
  const { data, error } = await outsider.client.from(table).select("id").eq("project_id", tenantA.projectId);
  check(!error && (data ?? []).length === 0, `RLS: tenant B reads no tenant A ${table}`);
}
equal((await listScheduleExposures(outsider.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId })).length, 0, "tenant B projection of tenant A is empty");
check((await listScheduleExposures(viewerA.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId })).length >= 2, "same-tenant viewer can read the exposures");
const foreignTrigger = { ...validPayload, trigger: { ...(validPayload.trigger as object), entityId: scheduleB.dep } };
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, foreignTrigger), /schedule_exposure_trigger_scope_mismatch/, "a trigger entity from another project is refused");

// ── 13. Contract misuse and boundary with the P2-04 manual path ───────────────────────
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, { ...validPayload, adapter: "someone-else:v9" }), /schedule_exposure_payload_invalid/, "unknown adapter version refused");
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, { ...validPayload, evaluation: { ...(validPayload.evaluation as object), confidence: 92 } }), /schedule_exposure_confidence_invalid/, "a percentage-scale confidence is refused at the 0–1 boundary");
await rpcError(writer, "capture_schedule_exposure_evaluation", captureArgs(tenantA.workspaceId, tenantA.projectId, pmA.id, { ...validPayload, evaluation: { ...(validPayload.evaluation as object), status: "invalid_topology" } }), /schedule_exposure_not_qualified/, "a non-qualified evaluation cannot be recorded");
await rpcError(pmA.client, "derive_operational_evidence", {
  p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_normalized_event_id: event.id, p_idempotency_key: `p2-16-${suffix}`,
  p_assertion_type: "FACT", p_classification: "RISK", p_confidence_score: 1, p_missing_data_state: "COMPLETE", p_evaluated_at: new Date().toISOString(),
}, /normalized_event_version_unsupported/, "the P2-04 manual derivation refuses a schedule event (no FACT relabelling)");
const manual = await pmA.client.rpc("capture_live_operational_input", {
  p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_source_key: "live-observation:v1", p_idempotency_key: `p2-16-manual-${suffix}`,
  p_title: "Manual note", p_content: "A manual observation.", p_occurred_at: new Date().toISOString(), p_correlation_id: randomUUID(),
});
assert.ifError(manual.error);
await rpcError(writer, "derive_schedule_exposure_evidence", { p_workspace_id: tenantA.workspaceId, p_project_id: tenantA.projectId, p_normalized_event_id: manual.data.normalizedEvent.id, p_actor_user_id: pmA.id }, /normalized_event_version_unsupported/, "schedule derivation refuses a manual event");
await rpcError(outsider.client, "capture_live_operational_input", {
  p_workspace_id: tenantB.workspaceId, p_project_id: tenantB.projectId, p_source_key: SCHEDULE_EXPOSURE_SOURCE_KEY, p_idempotency_key: `p2-16-poison-${suffix}`,
  p_title: "Poison", p_content: "Attempt to mint the engine Source as a connector.", p_occurred_at: new Date().toISOString(), p_correlation_id: randomUUID(),
}, /operational_sources_engine_identity_check/, "live intake cannot mint the engine Source identity");

// ── 14. Compatibility: the existing canonical read model consumes the result unchanged ─
const summary = await getOperationalSummary(pmA.client, tenantA.workspaceId, tenantA.projectId, pmA.id) as unknown as {
  signals: Array<{ id: string }>; recommendations: Array<{ id: string }>;
};
check(summary.signals.some((s) => s.id === rec.findingId), "operational summary lists the schedule Finding");
check(summary.recommendations.some((r) => r.id === rec.recommendationId), "operational summary lists the governed schedule Recommendation");
projection = await listScheduleExposures(pmA.client, { workspaceId: tenantA.workspaceId, projectId: tenantA.projectId });
const projected = projection.find((p) => p.evidenceId === rec.evidenceId)!;
equal(projected.materializationState, "complete", "a full chain is complete");
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
const finalCounts = await snapshotCounts(tenantA.projectId);
for (const table of DOWNSTREAM) equal(finalCounts[table], before[table], `nothing in the whole run created ${table}`);

console.log(`P2-16 DB verification PASS (${assertions} assertions).`);
console.log(`CHAIN ${source.source_key} → raw ${raw.id} → event ${event.id} → evidence ${evidence.id} → finding ${signal.id} → recommendation ${recommendation.id} (proposed)`);
console.log(`SNAPSHOT ${first.evaluation.snapshot.digest}`);
console.log(`CONCURRENCY ${CONCURRENCY} calls → created 1, duplicate ${CONCURRENCY - 1}; Finding 1, risk 1, governance 1, Recommendation 1, agent_run 1, agent_output 1`);
