/**
 * P2-16 — Schedule Exposure adapter and experience.
 *
 * Behavioural tests. The real H9 engine (validateGraph / forwardPass / backwardPass /
 * computeFloat / computeCriticalPath / computeCriticalMilestones) runs on production-shaped
 * rows; the real route handlers run with only their authorization and service seams
 * injected; the real service runs against a recording fake of the Supabase client so the
 * exact canonical RPC sequence, scoping filters and payload determinism are observable.
 * Database behaviour (RLS, idempotency, the RPC contracts themselves) is proven separately
 * against isolated local Supabase by scripts/check-p2-16-db.mts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import type {
  ExecutionTaskDependencyRow,
  ExecutionTaskRow,
  ProjectMilestoneRow,
} from "../src/lib/db/database-contract";
import {
  SCHEDULE_CONFIDENCE_CEILING,
  buildScheduleExposurePayload,
  computeScheduleSnapshot,
  evaluateScheduleExposure,
  type ScheduleExposureTrigger,
} from "../src/lib/critical-path/schedule-exposure";
import { buildNormalizedDag } from "../src/lib/critical-path/normalize-graph";
import { evaluateAndRecordScheduleExposure } from "../src/lib/critical-path/schedule-exposure-service";
import {
  handleGetScheduleExposure,
  handlePostScheduleExposure,
  type ScheduleExposureRouteDeps,
} from "../src/app/api/critical-path/schedule-exposure/route";

// ── Production-shaped fixtures ─────────────────────────────────────────────────────────
const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const TASK_A = "a0000000-0000-4000-8000-00000000000a";
const TASK_B = "b0000000-0000-4000-8000-00000000000b";
const TASK_C = "c0000000-0000-4000-8000-00000000000c";
const DEP_AB = "d0000000-0000-4000-8000-0000000000ab";
const MILESTONE = "e0000000-0000-4000-8000-00000000000e";
const CHANGE_EVENT = "f0000000-0000-4000-8000-00000000000f";

const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString(); // October 2026

function task(id: string, title: string, start: number | null, finish: number | null, extra: Partial<ExecutionTaskRow> = {}): ExecutionTaskRow {
  return {
    id, workspace_id: WS, project_id: PROJECT, task_draft_id: null, recommended_action_id: null, raid_item_id: null,
    title, description: "", status: "not_started", priority: "medium", owner_user_id: null, owner_name: null,
    start_date: null, due_date: null, completed_at: null, progress_percent: 0, acceptance_criteria: [], checklist: [],
    confidence_score: null, source_payload: {}, created_by: null, created_at: day(1), updated_at: day(1),
    planned_start_date: start === null ? null : day(start), planned_finish_date: finish === null ? null : day(finish),
    baseline_start_date: null, baseline_finish_date: null, forecast_start_date: null, forecast_finish_date: null,
    milestone_id: null, schedule_status: "scheduled", schedule_confidence: null,
    is_critical: false, early_start: null, early_finish: null, late_start: null, late_finish: null,
    total_float: null, free_float: null, variance_days: null, criticality_score: null,
    ...extra,
  } as ExecutionTaskRow;
}

function dependency(id: string, pred: string, succ: string, extra: Partial<ExecutionTaskDependencyRow> = {}): ExecutionTaskDependencyRow {
  return {
    id, workspace_id: WS, project_id: PROJECT, predecessor_task_id: pred, successor_task_id: succ,
    dependency_type: "finish_to_start", status: "active", lag_days: 0, reason: null, source_type: "manual",
    source_payload: {}, confidence_score: null, created_by: null, created_at: day(2), updated_at: day(3),
    ...extra,
  } as ExecutionTaskDependencyRow;
}

function milestone(extra: Partial<ProjectMilestoneRow> = {}): ProjectMilestoneRow {
  return {
    id: MILESTONE, workspace_id: WS, project_id: PROJECT, title: "Go-live", description: null, milestone_type: "go_live",
    status: "planned", target_date: day(12), baseline_date: day(12), forecast_date: null, completed_at: null,
    confidence_score: null, source_type: "manual", source_payload: {}, created_by: null, created_at: day(1), updated_at: day(4),
    ...extra,
  } as ProjectMilestoneRow;
}

/** A (Oct 1–6, 5d) → B (Oct 6–16, 10d, feeds Go-live, target Oct 12); C (Oct 1–6) is independent. */
function baseSchedule(overrides: { dep?: Partial<ExecutionTaskDependencyRow>; milestone?: Partial<ProjectMilestoneRow>; tasks?: ExecutionTaskRow[] } = {}) {
  const tasks = overrides.tasks ?? [
    task(TASK_A, "Design", 1, 6),
    task(TASK_B, "Build", 6, 16, { milestone_id: MILESTONE }),
    task(TASK_C, "Training plan", 1, 6),
  ];
  return { tasks, dependencies: [dependency(DEP_AB, TASK_A, TASK_B, overrides.dep)], milestones: [milestone(overrides.milestone)] };
}

function depTrigger(dep: ExecutionTaskDependencyRow): ScheduleExposureTrigger {
  return {
    kind: "dependency_change", entityType: "execution_task_dependency", entityId: dep.id,
    predecessorTaskId: dep.predecessor_task_id, successorTaskId: dep.successor_task_id,
    dependencyType: dep.dependency_type, status: dep.status, lagDays: dep.lag_days,
    previousStatus: "proposed", changeEventId: CHANGE_EVENT, changedAt: dep.updated_at,
  };
}

function evaluate(schedule = baseSchedule(), evaluatedAt = "2026-09-20T12:00:00.000Z") {
  return evaluateScheduleExposure({ ...schedule, trigger: depTrigger(schedule.dependencies[0]), evaluatedAt });
}

// ── Positive: typed dependency change → deterministic engine result ────────────────────
test("P2-16 positive: an active dependency pushes the linked milestone past its target → qualified exposure", () => {
  const result = evaluate();
  assert.equal(result.status, "qualified");
  assert.equal(result.missingDataState, "COMPLETE");
  assert.equal(result.confidence, SCHEDULE_CONFIDENCE_CEILING);
  assert.deepEqual(result.criticalTaskIds, [TASK_A, TASK_B].sort(), "the H9 engine marks A→B as the zero-float path");
  assert.equal(result.projectFinishDays, 15);
  assert.equal(result.exposures.length, 1);
  const [exposure] = result.exposures;
  assert.equal(exposure.milestoneId, MILESTONE);
  assert.equal(exposure.networkSlipDays, 4, "B cannot finish before Oct 16 once it waits for A; target is Oct 12");
  assert.equal(exposure.projectedFinishDate, day(16));
  assert.equal(exposure.isCritical, true);
  assert.equal(result.severity, "high");
  assert.deepEqual(result.topologyIssues, []);
});

test("P2-16 positive: the change is what drives the result — the same schedule without the edge has no exposure", () => {
  const resolved = evaluate(baseSchedule({ dep: { status: "resolved" } }));
  assert.equal(resolved.status, "no_exposure");
  assert.equal(resolved.exposures.length, 0);
  assert.equal(resolved.severity, null);
  assert.notEqual(resolved.snapshot.digest, evaluate().snapshot.digest, "removing the edge is a different schedule state");
});

test("P2-16 positive: lag is carried through the engine and increases slippage deterministically", () => {
  const lagged = evaluate(baseSchedule({ dep: { lag_days: 10 } }));
  assert.equal(lagged.exposures[0].networkSlipDays, 14);
  assert.equal(lagged.severity, "high");
  const heavy = evaluate(baseSchedule({ dep: { lag_days: 12 } }));
  assert.equal(heavy.exposures[0].networkSlipDays, 16);
  assert.equal(heavy.severity, "critical");
});

test("P2-16 positive: a milestone date change is evaluated as its own typed trigger", () => {
  const schedule = baseSchedule({ dep: { status: "resolved" }, milestone: { forecast_date: day(20) } });
  const m = schedule.milestones[0];
  const result = evaluateScheduleExposure({
    ...schedule,
    trigger: { kind: "milestone_date_change", entityType: "project_milestone", entityId: m.id, targetDate: m.target_date, forecastDate: m.forecast_date, baselineDate: m.baseline_date, changedAt: m.updated_at },
    evaluatedAt: "2026-09-20T12:00:00.000Z",
  });
  assert.equal(result.status, "qualified");
  assert.equal(result.exposures[0].isDelayed, true);
  assert.equal(result.exposures[0].forecastVarianceDays, 8);
});

// ── Snapshot integrity and determinism ────────────────────────────────────────────────
test("P2-16 snapshot: the digest is content-addressed — order, updated_at and the evaluation clock never change it", () => {
  const a = baseSchedule();
  const shuffled = { ...a, tasks: [...a.tasks].reverse().map((t) => ({ ...t, updated_at: day(28) })) };
  const first = evaluate(a, "2026-09-20T12:00:00.000Z");
  const second = evaluate(shuffled, "2026-09-21T08:30:00.000Z");
  assert.match(first.snapshot.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.snapshot.digest, second.snapshot.digest);
  assert.notEqual(first.evaluatedAt, second.evaluatedAt);
  assert.deepEqual(
    buildScheduleExposurePayload(first, a.tasks),
    buildScheduleExposurePayload(second, shuffled.tasks),
    "same snapshot + same change → byte-identical canonical payload",
  );
});

test("P2-16 snapshot: a material schedule edit produces a different digest", () => {
  const base = computeScheduleSnapshot(baseSchedule().tasks, baseSchedule().dependencies, baseSchedule().milestones).digest;
  const moved = baseSchedule({ milestone: { target_date: day(13) } });
  assert.notEqual(computeScheduleSnapshot(moved.tasks, moved.dependencies, moved.milestones).digest, base);
  const relagged = baseSchedule({ dep: { lag_days: 1 } });
  assert.notEqual(computeScheduleSnapshot(relagged.tasks, relagged.dependencies, relagged.milestones).digest, base);
});

test("P2-16 snapshot: the recorded payload binds the Finding to the evaluated snapshot and change, and carries no clock", () => {
  const result = evaluate();
  const payload = buildScheduleExposurePayload(result, baseSchedule().tasks);
  assert.equal((payload.snapshot as { digest: string }).digest, result.snapshot.digest);
  assert.equal((payload.trigger as { entityId: string }).entityId, DEP_AB);
  assert.equal(payload.adapter, "pmfreak/schedule-exposure-adapter:v1");
  assert.equal(payload.schemaVersion, 1);
  assert.equal(JSON.stringify(payload).includes(result.evaluatedAt), false, "evaluatedAt must not enter the digested payload");
  assert.match(String(payload.content), /inference of the deterministic schedule engine, not an observed fact/);
  assert.match(String(payload.content), /Dependency "Design" → "Build" \(finish to start\) is proposed → active\./);
});

// ── Confidence scale ───────────────────────────────────────────────────────────────────
test("P2-16 confidence: the adapter emits a 0–1 fraction only; the 0–100 Finding scale is produced in the database", () => {
  const payload = buildScheduleExposurePayload(evaluate(), baseSchedule().tasks);
  const evaluation = payload.evaluation as { confidence: number; confidenceScale: string };
  assert.equal(evaluation.confidenceScale, "0-1");
  assert.ok(evaluation.confidence > 0 && evaluation.confidence <= 1);
  const sql = readFileSync("supabase/migrations/20260913000000_p2_16_schedule_exposure_adapter.sql", "utf8");
  assert.match(sql, /v_confidence_pct := round\(e\.confidence_score \* 100, 2\);/);
  assert.match(sql, /if v_confidence < 0 or v_confidence > 1 then raise exception 'schedule_exposure_confidence_invalid'/);
});

// ── Missing data ───────────────────────────────────────────────────────────────────────
test("P2-16 missing data: a task without planned dates yields PARTIAL coverage and reduced confidence, never COMPLETE", () => {
  const schedule = baseSchedule({
    tasks: [task(TASK_A, "Design", 1, 6), task(TASK_B, "Build", 6, 16, { milestone_id: MILESTONE }), task(TASK_C, "Training plan", null, null)],
  });
  const result = evaluate(schedule);
  assert.equal(result.status, "qualified");
  assert.equal(result.missingDataState, "PARTIAL");
  assert.equal(result.confidence, 0.6, "0.9 ceiling × 2/3 task date coverage");
  assert.ok(result.missingData.some((m) => m.code === "task_planned_dates_missing" && m.entityIds.includes(TASK_C)));
});

test("P2-16 missing data: an affected milestone with no target date is insufficient — no confidence is invented", () => {
  const result = evaluate(baseSchedule({ milestone: { target_date: null } }));
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.missingDataState, "UNKNOWN");
  assert.equal(result.confidence, null);
  assert.deepEqual(result.exposures, []);
  assert.ok(result.missingData.some((m) => m.code === "milestone_target_date_missing"));
  assert.throws(() => buildScheduleExposurePayload(result, []), /schedule_exposure_not_qualified/);
});

test("P2-16 missing data: no tasks and no planned starts are insufficient, not an empty 'healthy' answer", () => {
  const m = milestone();
  const empty = evaluateScheduleExposure({
    tasks: [], dependencies: [], milestones: [m],
    trigger: { kind: "milestone_date_change", entityType: "project_milestone", entityId: m.id, targetDate: m.target_date, forecastDate: null, baselineDate: m.baseline_date, changedAt: m.updated_at },
    evaluatedAt: "2026-09-20T12:00:00.000Z",
  });
  assert.equal(empty.status, "insufficient_data");
  assert.equal(empty.confidence, null);
  assert.ok(empty.missingData.some((item) => item.code === "no_tasks"));
  const emptyGraphDependency = evaluate({ ...baseSchedule(), tasks: [] });
  assert.equal(emptyGraphDependency.status, "invalid_topology", "a changed dependency cannot be evaluated in a graph without its tasks");
  const undated = evaluate(baseSchedule({ tasks: [task(TASK_A, "Design", null, null), task(TASK_B, "Build", null, null, { milestone_id: MILESTONE })] }));
  assert.equal(undated.status, "insufficient_data");
  assert.equal(undated.confidence, null);
});

// ── Invalid topology ───────────────────────────────────────────────────────────────────
test("P2-16 invalid topology: a cycle is refused — no critical path, no exposure, no confidence", () => {
  const schedule = baseSchedule();
  schedule.dependencies.push(dependency("d0000000-0000-4000-8000-0000000000ba", TASK_B, TASK_A));
  const result = evaluate(schedule);
  assert.equal(result.status, "invalid_topology");
  assert.equal(result.topologyIssues[0].type, "cycle_detected");
  assert.match(result.topologyIssues[0].message, /^Cycle detected: (Design → Build → Design|Build → Design → Build)$/, "the cycle is named by task, not by id");
  assert.deepEqual([...result.topologyIssues[0].entityIds].sort(), [TASK_A, TASK_B].sort());
  assert.deepEqual(result.criticalTaskIds, []);
  assert.deepEqual(result.exposures, []);
  assert.equal(result.confidence, null);
  assert.equal(result.projectFinishDays, null);
  assert.throws(() => buildScheduleExposurePayload(result, schedule.tasks), /schedule_exposure_not_qualified/);
});

test("P2-16 invalid topology: a self-dependency is refused", () => {
  const schedule = baseSchedule();
  schedule.dependencies.push(dependency("d0000000-0000-4000-8000-0000000000aa", TASK_A, TASK_A));
  const result = evaluate(schedule);
  assert.equal(result.status, "invalid_topology");
  assert.ok(result.topologyIssues.some((i) => i.type === "self_dependency" || i.type === "cycle_detected"));
});

test("P2-16 invalid topology: an active edge to a task outside the loaded graph is refused, not silently dropped", () => {
  const schedule = baseSchedule();
  const ghost = "00000000-0000-4000-8000-000000000999";
  schedule.dependencies.push(dependency("d0000000-0000-4000-8000-0000000000c9", TASK_C, ghost));
  const result = evaluate(schedule);
  assert.equal(result.status, "invalid_topology");
  const orphan = result.topologyIssues.find((i) => i.type === "orphan_reference");
  assert.ok(orphan && orphan.entityIds.includes(ghost));
});

test("P2-16 invalid topology: a changed dependency whose endpoint is not in the project graph is refused", () => {
  const schedule = baseSchedule({ tasks: [task(TASK_B, "Build", 6, 16, { milestone_id: MILESTONE })] });
  schedule.dependencies = [dependency(DEP_AB, TASK_A, TASK_B, { status: "invalidated" })];
  const result = evaluate(schedule);
  assert.equal(result.status, "invalid_topology");
  assert.ok(result.topologyIssues.some((i) => i.type === "trigger_outside_graph"));
});

// ── Compatibility: the shared normalizer keeps loadGraph's historical behaviour ───────
test("P2-16 compatibility: buildNormalizedDag keeps loadGraph's edge-dropping behaviour and only adds visibility", () => {
  const schedule = baseSchedule();
  schedule.dependencies.push(dependency("d0000000-0000-4000-8000-0000000000c9", TASK_C, "00000000-0000-4000-8000-000000000999"));
  const { dag, droppedEdges } = buildNormalizedDag(schedule.tasks, schedule.dependencies, schedule.milestones);
  assert.equal(dag.edges.length, 1, "the orphan edge is still excluded from the DAG the H9 materializer computes on");
  assert.equal(droppedEdges.length, 1);
  const loadGraph = readFileSync("src/lib/critical-path/load-graph.ts", "utf8");
  assert.match(loadGraph, /buildNormalizedDag\(tasks, deps, milestones\)/);
  assert.match(loadGraph, /\.eq\("status", "active"\)/);
});

// ── Route: authorization, tenancy and degraded contract ───────────────────────────────
type Auth = Awaited<ReturnType<ScheduleExposureRouteDeps["authorize"]>>;
const fakeClient = {} as never;

function authFor(tenant: { workspaceId: string; role: string } | null, projectWorkspace: Record<string, string> = { [PROJECT]: WS }) {
  const calls: Array<{ projectId: string; workspaceId: string; permission: string }> = [];
  const authorize = async (projectId: string, workspaceId: string, permission: "read" | "write"): Promise<Auth> => {
    calls.push({ projectId, workspaceId, permission });
    if (!tenant) return { ok: false, status: 401 };
    // Server-side truth: the project's real workspace and the caller's membership in it.
    if (projectWorkspace[projectId] !== workspaceId || tenant.workspaceId !== workspaceId) return { ok: false, status: 403 };
    if (permission === "write" && !["owner", "admin", "pm"].includes(tenant.role)) return { ok: false, status: 403 };
    return { ok: true, userId: "user-a", role: tenant.role, client: fakeClient };
  };
  return { authorize, calls };
}

const getReq = (workspaceId: string, projectId: string) =>
  new NextRequest(`http://localhost/api/critical-path/schedule-exposure?workspaceId=${workspaceId}&projectId=${projectId}`);
const postReq = (body: unknown) =>
  new NextRequest("http://localhost/api/critical-path/schedule-exposure", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("P2-16 tenancy: same-tenant read succeeds; cross-tenant and wrong-project reads are denied before any data access", async () => {
  let listed = 0;
  const deps = { listExposures: async () => { listed += 1; return []; }, listCandidates: async () => [] };
  const same = await handleGetScheduleExposure(getReq(WS, PROJECT), { ...deps, authorize: authFor({ workspaceId: WS, role: "viewer" }).authorize });
  assert.equal(same.status, 200);
  assert.equal((await same.json()).canEvaluate, false, "a viewer can read but is not offered evaluation");

  const cross = await handleGetScheduleExposure(getReq(OTHER_WS, PROJECT), { ...deps, authorize: authFor({ workspaceId: OTHER_WS, role: "owner" }).authorize });
  assert.equal(cross.status, 403);
  const wrongProject = await handleGetScheduleExposure(getReq(WS, "33333333-3333-4333-8333-333333333333"), { ...deps, authorize: authFor({ workspaceId: WS, role: "owner" }).authorize });
  assert.equal(wrongProject.status, 403);
  const anonymous = await handleGetScheduleExposure(getReq(WS, PROJECT), { ...deps, authorize: authFor(null).authorize });
  assert.equal(anonymous.status, 401);
  assert.equal(listed, 1, "only the authorized request reached the data layer");
});

test("P2-16 tenancy: evaluation requires write authority in the project's own workspace", async () => {
  let evaluated = 0;
  const evaluateAndRecord = (async () => { evaluated += 1; throw new Error("unreachable"); }) as unknown as ScheduleExposureRouteDeps["evaluateAndRecord"];
  const body = { workspaceId: WS, projectId: PROJECT, trigger: { kind: "dependency_change", entityId: DEP_AB } };
  const viewer = authFor({ workspaceId: WS, role: "viewer" });
  assert.equal((await handlePostScheduleExposure(postReq(body), { authorize: viewer.authorize, evaluateAndRecord })).status, 403);
  assert.equal(viewer.calls[0].permission, "write");
  const crossTenant = authFor({ workspaceId: OTHER_WS, role: "owner" });
  assert.equal((await handlePostScheduleExposure(postReq({ ...body, workspaceId: OTHER_WS }), { authorize: crossTenant.authorize, evaluateAndRecord })).status, 403);
  assert.equal(evaluated, 0);
  assert.equal((await handlePostScheduleExposure(postReq({ ...body, trigger: { kind: "delete_everything", entityId: DEP_AB } }), { authorize: viewer.authorize, evaluateAndRecord })).status, 400);
});

test("P2-16 route: invalid topology is an explicit 422 refusal with nothing recorded", async () => {
  const schedule = baseSchedule();
  schedule.dependencies.push(dependency("d0000000-0000-4000-8000-0000000000ba", TASK_B, TASK_A));
  const evaluation = evaluate(schedule);
  const response = await handlePostScheduleExposure(postReq({ workspaceId: WS, projectId: PROJECT, trigger: { kind: "dependency_change", entityId: DEP_AB } }), {
    authorize: authFor({ workspaceId: WS, role: "pm" }).authorize,
    evaluateAndRecord: async () => ({ evaluation, recorded: null }),
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.disposition, "refused");
  assert.equal(body.failureClass, "invalid_topology");
  assert.equal(body.recorded, null);
});

test("P2-16 route: created, duplicate and not-recorded dispositions are reported honestly; errors do not leak internals", async () => {
  const auth = authFor({ workspaceId: WS, role: "pm" }).authorize;
  const body = { workspaceId: WS, projectId: PROJECT, trigger: { kind: "dependency_change", entityId: DEP_AB } };
  const evaluation = evaluate();
  const recorded = { disposition: "created" as const, sourceId: "s", rawInputId: "r", normalizedEventId: "n", evidenceId: "e", findingId: "f", recommendationId: "rec", correlationId: "c", idempotencyKey: "k" };
  assert.equal((await handlePostScheduleExposure(postReq(body), { authorize: auth, evaluateAndRecord: async () => ({ evaluation, recorded }) })).status, 201);
  const dup = await handlePostScheduleExposure(postReq(body), { authorize: auth, evaluateAndRecord: async () => ({ evaluation, recorded: { ...recorded, disposition: "duplicate" as const } }) });
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).disposition, "duplicate");
  const none = await handlePostScheduleExposure(postReq(body), { authorize: auth, evaluateAndRecord: async () => ({ evaluation: evaluate(baseSchedule({ dep: { status: "resolved" } })), recorded: null }) });
  assert.equal(none.status, 200);
  assert.equal((await none.json()).disposition, "not_recorded");
  const missing = await handlePostScheduleExposure(postReq(body), { authorize: auth, evaluateAndRecord: async () => { throw new Error("schedule_exposure_trigger_not_found"); } });
  assert.equal(missing.status, 404);
  const conflict = await handlePostScheduleExposure(postReq(body), { authorize: auth, evaluateAndRecord: async () => { throw new Error("capture_schedule_exposure_evaluation: schedule_exposure_idempotency_conflict"); } });
  assert.equal(conflict.status, 409);
  const internal = await handlePostScheduleExposure(postReq(body), { authorize: auth, evaluateAndRecord: async () => { throw new Error("relation public.secret_table does not exist"); } });
  assert.equal(internal.status, 500);
  assert.doesNotMatch(JSON.stringify(await internal.json()), /secret_table/);
});

// ── Service: canonical RPC sequence, scoping, idempotent replay, no auto-downstream ───
type Filter = { table: string; column: string; op: string; value: unknown };

function recordingClient(schedule: ReturnType<typeof baseSchedule>) {
  const filters: Filter[] = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tables: Record<string, unknown[]> = {
    execution_tasks: schedule.tasks,
    execution_task_dependencies: schedule.dependencies,
    project_milestones: schedule.milestones,
    execution_task_events: [{ id: CHANGE_EVENT, event_type: "dependency_activated", event_payload: { dependencyId: DEP_AB, previousStatus: "proposed", newStatus: "active" }, created_at: day(3) }],
  };
  const from = (table: string) => {
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters.push({ table, column, op: "eq", value }); return builder; },
      in: (column: string, value: unknown) => { filters.push({ table, column, op: "in", value }); return builder; },
      order: () => builder,
      limit: () => builder,
      overrideTypes: () => builder,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] ?? [], error: null }),
    };
    return builder;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    rpcs.push({ name, args });
    const replay = rpcs.filter((r) => r.name === name).length > 1;
    if (name === "capture_schedule_exposure_evaluation") {
      return { data: { disposition: replay ? "duplicate" : "created", idempotencyKey: "schedule-exposure:v1:abc", source: { id: "src" }, rawInput: { id: "raw", correlation_id: "corr-first" }, normalizedEvent: { id: "evt" } }, error: null };
    }
    if (name === "derive_schedule_exposure_evidence") return { data: { disposition: replay ? "duplicate" : "created", evidence: { id: "evd" } }, error: null };
    if (name === "materialize_schedule_exposure_finding") return { data: { disposition: replay ? "duplicate" : "created", signal: { id: "sig" }, recommendation: { id: "rec" } }, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  };
  return { client: { from, rpc } as never, filters, rpcs };
}

const scope = { workspaceId: WS, projectId: PROJECT, userId: "user-a", role: "pm" };

test("P2-16 service: a qualified change runs capture → derive → materialize, in order, and nothing else", async () => {
  const fake = recordingClient(baseSchedule());
  const result = await evaluateAndRecordScheduleExposure(fake.client, scope, { kind: "dependency_change", entityId: DEP_AB }, { evaluatedAt: "2026-09-20T12:00:00.000Z" });
  assert.equal(result.evaluation.status, "qualified");
  assert.deepEqual(fake.rpcs.map((r) => r.name), ["capture_schedule_exposure_evaluation", "derive_schedule_exposure_evidence", "materialize_schedule_exposure_finding"]);
  const capture = fake.rpcs[0].args;
  assert.equal(capture.p_occurred_at, day(3), "occurredAt is when the dependency changed");
  assert.equal(capture.p_evaluated_at, "2026-09-20T12:00:00.000Z");
  assert.equal(capture.p_causation_id, CHANGE_EVENT, "the H7 change event is the causation");
  assert.equal(fake.rpcs[1].args.p_normalized_event_id, "evt");
  assert.equal(fake.rpcs[2].args.p_evidence_item_id, "evd");
  assert.equal(result.recorded?.disposition, "created");
  assert.equal(result.recorded?.recommendationId, "rec");
});

test("P2-16 no auto-downstream: the adapter never calls a Decision, Action, Task, Outcome or Observation contract", async () => {
  const fake = recordingClient(baseSchedule());
  await evaluateAndRecordScheduleExposure(fake.client, scope, { kind: "dependency_change", entityId: DEP_AB });
  for (const { name } of fake.rpcs) {
    assert.doesNotMatch(name, /decision|material_action|dispatch|task_outcome|observation|record_operational/);
  }
  const sql = readFileSync("supabase/migrations/20260913000000_p2_16_schedule_exposure_adapter.sql", "utf8");
  for (const table of ["operational_decision_records", "material_action_proposals", "execution_tasks", "canonical_task_outcomes", "canonical_outcome_observations", "decision_evidence_links"]) {
    assert.doesNotMatch(sql, new RegExp(`insert into public\\.${table}\\b`), `the migration never writes ${table}`);
  }
  assert.match(sql, /'decisionCreated', false, 'actionCreated', false, 'taskCreated', false, 'outcomeCreated', false/);
});

test("P2-16 idempotency: re-evaluating the same snapshot and change later sends a byte-identical payload", async () => {
  const fake = recordingClient(baseSchedule());
  const first = await evaluateAndRecordScheduleExposure(fake.client, scope, { kind: "dependency_change", entityId: DEP_AB }, { evaluatedAt: "2026-09-20T12:00:00.000Z" });
  const second = await evaluateAndRecordScheduleExposure(fake.client, scope, { kind: "dependency_change", entityId: DEP_AB }, { evaluatedAt: "2026-09-22T09:00:00.000Z" });
  const payloads = fake.rpcs.filter((r) => r.name === "capture_schedule_exposure_evaluation").map((r) => JSON.stringify(r.args.p_payload));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0], payloads[1], "the database derives one idempotency key from this payload's snapshot + trigger");
  assert.equal(first.recorded?.disposition, "created");
  assert.equal(second.recorded?.disposition, "duplicate");
  assert.equal(second.recorded?.correlationId, "corr-first", "a replay reports the first evaluation's persisted correlation");
});

test("P2-16 service: unqualified evaluations write nothing, and every read is scoped by workspace AND project", async () => {
  const fake = recordingClient(baseSchedule({ dep: { status: "resolved" } }));
  const result = await evaluateAndRecordScheduleExposure(fake.client, scope, { kind: "dependency_change", entityId: DEP_AB });
  assert.equal(result.evaluation.status, "no_exposure");
  assert.equal(result.recorded, null);
  assert.equal(fake.rpcs.length, 0);
  for (const table of ["execution_tasks", "execution_task_dependencies", "project_milestones", "execution_task_events"]) {
    const scoped = fake.filters.filter((f) => f.table === table);
    assert.ok(scoped.some((f) => f.column === "workspace_id" && f.value === WS), `${table} is workspace-scoped`);
    assert.ok(scoped.some((f) => f.column === "project_id" && f.value === PROJECT), `${table} is project-scoped`);
  }
});

test("P2-16 service: a viewer is refused before any read, and an entity outside the project is not found", async () => {
  const fake = recordingClient(baseSchedule());
  await assert.rejects(evaluateAndRecordScheduleExposure(fake.client, { ...scope, role: "viewer" }, { kind: "dependency_change", entityId: DEP_AB }), /schedule_exposure_role_denied/);
  assert.equal(fake.filters.length, 0);
  await assert.rejects(
    evaluateAndRecordScheduleExposure(fake.client, scope, { kind: "dependency_change", entityId: "d0000000-0000-4000-8000-00000000ffff" }),
    /schedule_exposure_trigger_not_found/,
  );
  await assert.rejects(evaluateAndRecordScheduleExposure(fake.client, scope, { kind: "dependency_change", entityId: "not-a-uuid" }), /schedule_exposure_trigger_invalid/);
});

// ── Migration contract (supplements the live DB gate; never the only proof) ──────────
test("P2-16 migration: additive only — no table, column, policy or existing-function replacement", () => {
  const sql = readFileSync("supabase/migrations/20260913000000_p2_16_schedule_exposure_adapter.sql", "utf8");
  assert.doesNotMatch(sql, /create table|add column|drop column|create policy|drop policy|alter policy|delete from|truncate/i);
  for (const existing of ["capture_live_operational_input", "capture_operational_input", "derive_operational_evidence", "materialize_operational_chain", "record_operational_decision"]) {
    assert.doesNotMatch(sql, new RegExp(`create or replace function public\\.${existing}\\(`));
  }
  assert.match(sql, /check \(source_kind in \('manual_demo','connector','import','engine'\)\)/);
  assert.match(sql, /check \(\(source_kind = 'engine'\) = \(source_key like 'schedule-engine:%'\)\)/);
  for (const fn of ["capture_schedule_exposure_evaluation", "derive_schedule_exposure_evidence", "materialize_schedule_exposure_finding"]) {
    assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon;`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated, service_role;`));
  }
  assert.match(sql, /if v_missing = 'UNKNOWN' then raise exception 'schedule_exposure_insufficient_data'/);
  assert.match(sql, /v_event\.event_type <> 'schedule_exposure\.evaluated' then raise exception 'normalized_event_version_unsupported'/);
});
