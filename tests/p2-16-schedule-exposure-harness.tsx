/**
 * P2-16 UI harness. Executed by tests/p2-16-schedule-exposure-ui.test.mjs through tsx.
 *
 * Renders the real ScheduleExposureView through react-dom/server for every state the PM can
 * meet, from records produced by the REAL adapter (evaluateScheduleExposure →
 * buildScheduleExposurePayload) and shaped exactly like listScheduleExposures() returns them,
 * then prints one JSON document of markup for the test file to assert on.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ExecutionTaskDependencyRow, ExecutionTaskRow, ProjectMilestoneRow } from "@/lib/db/database-contract";
import { buildScheduleExposurePayload, evaluateScheduleExposure, type ScheduleExposureEvaluation } from "@/lib/critical-path/schedule-exposure";
import type { ScheduleExposureRecord } from "@/lib/critical-path/schedule-exposure-service";
import { ScheduleExposureView, formatEvidenceConfidence, formatFindingScore } from "@/components/pmfreak/schedule-exposure/schedule-exposure-panel";

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();

const task = (id: string, title: string, start: number | null, finish: number | null, milestoneId: string | null = null) => ({
  id, workspace_id: WS, project_id: PROJECT, title, status: "not_started", milestone_id: milestoneId,
  planned_start_date: start === null ? null : day(start), planned_finish_date: finish === null ? null : day(finish),
  forecast_finish_date: null, updated_at: day(1),
}) as unknown as ExecutionTaskRow;
const dep = { id: "d0000000-0000-4000-8000-0000000000ab", workspace_id: WS, project_id: PROJECT, predecessor_task_id: "a", successor_task_id: "b", dependency_type: "finish_to_start", status: "active", lag_days: 0, updated_at: day(3) } as unknown as ExecutionTaskDependencyRow;
const milestone = { id: "e0000000-0000-4000-8000-00000000000e", workspace_id: WS, project_id: PROJECT, title: "Go-live", status: "planned", target_date: day(12), forecast_date: null, baseline_date: day(12), updated_at: day(4) } as unknown as ProjectMilestoneRow;
const trigger = { kind: "dependency_change" as const, entityType: "execution_task_dependency" as const, entityId: dep.id, predecessorTaskId: "a", successorTaskId: "b", dependencyType: "finish_to_start", status: "active", lagDays: 0, previousStatus: "proposed", changeEventId: null, changedAt: day(3) };

function evaluation(tasks: ExecutionTaskRow[], deps: ExecutionTaskDependencyRow[] = [dep]): ScheduleExposureEvaluation {
  return evaluateScheduleExposure({ tasks, dependencies: deps, milestones: [milestone], trigger, evaluatedAt: "2026-09-20T12:00:00.000Z" });
}

/** Exactly the listScheduleExposures() projection of the canonical rows the RPCs would write. */
function record(ev: ScheduleExposureEvaluation, tasks: ExecutionTaskRow[]): ScheduleExposureRecord {
  const payload = buildScheduleExposurePayload(ev, tasks) as Record<string, unknown>;
  const pct = Math.round((ev.confidence ?? 0) * 100 * 100) / 100; // what the SQL persists on the Signal
  return {
    evidenceId: "evd-1", title: String(payload.title), content: String(payload.content),
    confidence: ev.confidence!, confidenceMethod: ev.confidenceMethod, confidenceDrivers: ev.confidenceDrivers,
    missingDataState: ev.missingDataState, missingData: ev.missingData, engineLimitations: ev.engineLimitations,
    freshnessState: "CURRENT", fixtureState: "LIVE", assertionType: "INFERENCE",
    evaluatedAt: ev.evaluatedAt, occurredAt: day(3), recordedAt: "2026-09-20T12:00:01.000Z", correlationId: "corr-1",
    snapshotDigest: ev.snapshot.digest, trigger: ev.trigger, exposures: ev.exposures, severity: ev.severity,
    provenance: { sourceId: "src-1", sourceKey: "schedule-engine:h9-v1", rawInputId: "raw-1", normalizedEventId: "evt-1", derivationDigest: "sha256:" + "ab".repeat(32) },
    finding: { id: "sig-1", confidenceScore: pct, severity: ev.severity!, status: "open", detectedBy: "system/deterministic:schedule_exposure_adapter_v1", summary: String(payload.title) },
    recommendation: { id: "rec-1", status: "proposed", recommendation: String(payload.recommendation), urgency: "high", actionType: "confirm_dependency" },
  };
}

const completeTasks = [task("a", "Design", 1, 6), task("b", "Build", 6, 16, milestone.id), task("c", "Training plan", 1, 6)];
const partialTasks = [task("a", "Design", 1, 6), task("b", "Build", 6, 16, milestone.id), task("c", "Training plan", null, null)];
const complete = evaluation(completeTasks);
const partial = evaluation(partialTasks);
const cyclic = evaluation(completeTasks, [dep, { ...dep, id: "d0000000-0000-4000-8000-0000000000ba", predecessor_task_id: "b", successor_task_id: "a" } as ExecutionTaskDependencyRow]);
const insufficient = evaluateScheduleExposure({ tasks: [task("a", "Design", null, null), task("b", "Build", null, null, milestone.id)], dependencies: [dep], milestones: [milestone], trigger, evaluatedAt: "2026-09-20T12:00:00.000Z" });
const candidates = [
  { kind: "dependency_change" as const, entityId: dep.id, label: "Design → Build", status: "active", changedAt: day(3) },
  { kind: "milestone_date_change" as const, entityId: milestone.id, label: "Go-live", status: "planned", changedAt: day(4) },
];
const markup = (node: React.ReactElement) => renderToStaticMarkup(node);

const completeRecord = record(complete, completeTasks);
console.log(JSON.stringify({
  statuses: { complete: complete.status, partial: partial.status, cyclic: cyclic.status, insufficient: insufficient.status },
  confidence: { evidence: formatEvidenceConfidence(completeRecord.confidence), finding: formatFindingScore(completeRecord.finding!.confidenceScore), persistedFinding: completeRecord.finding!.confidenceScore },
  loading: markup(<ScheduleExposureView state={{ kind: "loading" }} />),
  error: markup(<ScheduleExposureView state={{ kind: "error", message: "Schedule exposure could not be loaded." }} onRetry={() => {}} />),
  denied: markup(<ScheduleExposureView state={{ kind: "denied" }} />),
  empty: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [], candidates, canEvaluate: true }} />),
  viewer: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [completeRecord], candidates, canEvaluate: false }} />),
  qualified: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [completeRecord], candidates, canEvaluate: true }} feedback={{ kind: "recorded", disposition: "created", evaluation: complete }} />),
  duplicate: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [completeRecord], candidates, canEvaluate: true }} feedback={{ kind: "recorded", disposition: "duplicate", evaluation: complete }} />),
  partial: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [record(partial, partialTasks)], candidates, canEvaluate: true }} />),
  refused: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [], candidates, canEvaluate: true }} feedback={{ kind: "refused", evaluation: cyclic }} />),
  insufficient: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [], candidates, canEvaluate: true }} feedback={{ kind: "not_recorded", evaluation: insufficient }} />),
  evaluateDenied: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [], candidates, canEvaluate: true }} feedback={{ kind: "denied" }} />),
  busy: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [], candidates, canEvaluate: true }} busyEntityId={dep.id} />),
  fixture: markup(<ScheduleExposureView state={{ kind: "ready", exposures: [{ ...completeRecord, fixtureState: "DEMO_FIXTURE" }], candidates: [], canEvaluate: false }} />),
}));
