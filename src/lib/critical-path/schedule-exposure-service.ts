/**
 * P2-16 — Schedule Exposure service (server).
 *
 * Every read and write runs on the caller's request-scoped client, so RLS applies, and is
 * filtered by BOTH workspace and project. The three canonical transitions are separate
 * RPCs called in order — capture (Raw Input + Normalized Event), derive (Evidence),
 * materialize (Finding + governed Recommendation) — and each is idempotent, so a retry
 * after a partial failure resumes instead of duplicating. Nothing downstream of the
 * Recommendation is ever called from here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  EXECUTION_TASK_DEPENDENCY_SELECTABLE_COLUMNS,
  EXECUTION_TASK_SELECTABLE_COLUMNS,
  PROJECT_MILESTONE_SELECTABLE_COLUMNS,
  type ExecutionTaskDependencyRow,
  type ExecutionTaskRow,
  type ProjectMilestoneRow,
} from "@/lib/db/database-contract";
import { canCreateOperationalEvidence, type OperationalWorkspaceRole } from "@/lib/operational-flow/authority";
import {
  buildScheduleExposurePayload,
  evaluateScheduleExposure,
  type MilestoneExposure,
  type ScheduleExposureEvaluation,
  type ScheduleExposureSeverity,
  type ScheduleExposureTrigger,
  type ScheduleMissingDataItem,
  type ScheduleMissingDataState,
} from "./schedule-exposure";

type Client = SupabaseClient;
export type ScheduleExposureScope = {
  workspaceId: string;
  projectId: string;
  userId: string;
  role: OperationalWorkspaceRole | null;
};
export type ScheduleTriggerRef = { kind: "dependency_change" | "milestone_date_change"; entityId: string };

export const SCHEDULE_EXPOSURE_SOURCE_KEY = "schedule-engine:h9-v1";
const DEPENDENCY_EVENT_TYPES = ["dependency_created", "dependency_added", "dependency_activated", "dependency_resolved", "dependency_invalidated", "dependency_updated"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(operation: string, error: { message: string } | null): never {
  throw new Error(`${operation}: ${error?.message ?? "no_data"}`);
}

export async function loadScheduleInputs(client: Client, scope: Pick<ScheduleExposureScope, "workspaceId" | "projectId">) {
  const [tasks, deps, milestones] = await Promise.all([
    client.from("execution_tasks").select(EXECUTION_TASK_SELECTABLE_COLUMNS.join(","))
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
      .overrideTypes<ExecutionTaskRow[], { merge: false }>(),
    client.from("execution_task_dependencies").select(EXECUTION_TASK_DEPENDENCY_SELECTABLE_COLUMNS.join(","))
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
      .overrideTypes<ExecutionTaskDependencyRow[], { merge: false }>(),
    client.from("project_milestones").select(PROJECT_MILESTONE_SELECTABLE_COLUMNS.join(","))
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
      .overrideTypes<ProjectMilestoneRow[], { merge: false }>(),
  ]);
  if (tasks.error) fail("schedule_exposure_load_tasks", tasks.error);
  if (deps.error) fail("schedule_exposure_load_dependencies", deps.error);
  if (milestones.error) fail("schedule_exposure_load_milestones", milestones.error);
  return { tasks: tasks.data ?? [], dependencies: deps.data ?? [], milestones: milestones.data ?? [] };
}

/**
 * Resolves the typed change from PERSISTED state only. The caller names the entity; every
 * fact about the change (endpoints, status, dates, the H7 change event) is read back from
 * the database under the project scope, so a caller cannot describe a change that did not
 * happen or point at another project's entity.
 */
export async function resolveScheduleTrigger(
  client: Client,
  scope: Pick<ScheduleExposureScope, "workspaceId" | "projectId">,
  ref: ScheduleTriggerRef,
  inputs: { dependencies: ExecutionTaskDependencyRow[]; milestones: ProjectMilestoneRow[] },
): Promise<ScheduleExposureTrigger> {
  if (!UUID_PATTERN.test(ref.entityId)) throw new Error("schedule_exposure_trigger_invalid");
  if (ref.kind === "dependency_change") {
    const dep = inputs.dependencies.find((d) => d.id === ref.entityId);
    if (!dep) throw new Error("schedule_exposure_trigger_not_found");
    const events = await client.from("execution_task_events")
      .select("id,event_type,event_payload,created_at")
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
      .in("task_id", [dep.predecessor_task_id, dep.successor_task_id])
      .in("event_type", DEPENDENCY_EVENT_TYPES)
      .order("created_at", { ascending: false })
      .limit(50);
    if (events.error) fail("schedule_exposure_load_change_event", events.error);
    const latest = (events.data ?? []).find((e) => (e.event_payload as Record<string, unknown> | null)?.dependencyId === dep.id) ?? null;
    const payload = (latest?.event_payload ?? {}) as Record<string, unknown>;
    return {
      kind: "dependency_change",
      entityType: "execution_task_dependency",
      entityId: dep.id,
      predecessorTaskId: dep.predecessor_task_id,
      successorTaskId: dep.successor_task_id,
      dependencyType: dep.dependency_type,
      status: dep.status,
      lagDays: dep.lag_days ?? 0,
      previousStatus: typeof payload.previousStatus === "string" ? payload.previousStatus : null,
      changeEventId: latest ? String(latest.id) : null,
      changedAt: new Date(dep.updated_at).toISOString(),
    };
  }
  if (ref.kind === "milestone_date_change") {
    const milestone = inputs.milestones.find((m) => m.id === ref.entityId);
    if (!milestone) throw new Error("schedule_exposure_trigger_not_found");
    return {
      kind: "milestone_date_change",
      entityType: "project_milestone",
      entityId: milestone.id,
      targetDate: milestone.target_date ? new Date(milestone.target_date).toISOString() : null,
      forecastDate: milestone.forecast_date ? new Date(milestone.forecast_date).toISOString() : null,
      baselineDate: milestone.baseline_date ? new Date(milestone.baseline_date).toISOString() : null,
      changedAt: new Date(milestone.updated_at).toISOString(),
    };
  }
  throw new Error("schedule_exposure_trigger_invalid");
}

export type RecordedScheduleExposure = {
  disposition: "created" | "duplicate";
  sourceId: string;
  rawInputId: string;
  normalizedEventId: string;
  evidenceId: string;
  findingId: string;
  recommendationId: string;
  correlationId: string;
  idempotencyKey: string;
};

export type ScheduleExposureEvaluationResult = {
  evaluation: ScheduleExposureEvaluation;
  /** Null unless the evaluation qualified: refused/insufficient/no-exposure results are never recorded. */
  recorded: RecordedScheduleExposure | null;
};

export async function evaluateAndRecordScheduleExposure(
  client: Client,
  scope: ScheduleExposureScope,
  ref: ScheduleTriggerRef,
  options: { evaluatedAt?: string; correlationId?: string } = {},
): Promise<ScheduleExposureEvaluationResult> {
  if (!canCreateOperationalEvidence(scope.role)) throw new Error("schedule_exposure_role_denied");
  const inputs = await loadScheduleInputs(client, scope);
  const trigger = await resolveScheduleTrigger(client, scope, ref, inputs);
  const evaluation = evaluateScheduleExposure({ ...inputs, trigger, evaluatedAt: options.evaluatedAt ?? new Date().toISOString() });
  if (evaluation.status !== "qualified") return { evaluation, recorded: null };

  const payload = buildScheduleExposurePayload(evaluation, inputs.tasks);
  const correlationId = options.correlationId ?? randomUUID();
  const captured = await client.rpc("capture_schedule_exposure_evaluation", {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_payload: payload,
    p_occurred_at: trigger.changedAt,
    p_evaluated_at: evaluation.evaluatedAt,
    p_correlation_id: correlationId,
    p_causation_id: trigger.kind === "dependency_change" ? trigger.changeEventId : null,
  });
  if (captured.error || !captured.data) fail("capture_schedule_exposure_evaluation", captured.error);
  const capture = captured.data as {
    disposition: "created" | "duplicate";
    idempotencyKey: string;
    source: { id: string };
    rawInput: { id: string; correlation_id: string };
    normalizedEvent: { id: string };
  };

  const derived = await client.rpc("derive_schedule_exposure_evidence", {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_normalized_event_id: capture.normalizedEvent.id,
  });
  if (derived.error || !derived.data) fail("derive_schedule_exposure_evidence", derived.error);
  const evidence = (derived.data as { evidence: { id: string } }).evidence;

  const materialized = await client.rpc("materialize_schedule_exposure_finding", { p_evidence_item_id: evidence.id });
  if (materialized.error || !materialized.data) fail("materialize_schedule_exposure_finding", materialized.error);
  const finding = materialized.data as { disposition: "created" | "duplicate"; signal: { id: string }; recommendation: { id: string } };

  return {
    evaluation,
    recorded: {
      disposition: capture.disposition === "duplicate" && finding.disposition === "duplicate" ? "duplicate" : "created",
      sourceId: capture.source.id,
      rawInputId: capture.rawInput.id,
      normalizedEventId: capture.normalizedEvent.id,
      evidenceId: evidence.id,
      findingId: finding.signal.id,
      recommendationId: finding.recommendation.id,
      // The persisted correlation of the FIRST evaluation; a replay keeps it.
      correlationId: capture.rawInput.correlation_id,
      idempotencyKey: capture.idempotencyKey,
    },
  };
}

// ── Read projection ────────────────────────────────────────────────────────────────────

export type ScheduleExposureRecord = {
  evidenceId: string;
  title: string;
  content: string;
  /** Evidence scale, 0–1. */
  confidence: number;
  confidenceMethod: string | null;
  confidenceDrivers: string[];
  missingDataState: ScheduleMissingDataState;
  missingData: ScheduleMissingDataItem[];
  engineLimitations: string[];
  freshnessState: string;
  fixtureState: string;
  assertionType: string;
  evaluatedAt: string;
  occurredAt: string;
  recordedAt: string;
  correlationId: string;
  snapshotDigest: string;
  trigger: ScheduleExposureTrigger | null;
  exposures: MilestoneExposure[];
  severity: ScheduleExposureSeverity | null;
  provenance: { sourceId: string; sourceKey: string | null; rawInputId: string; normalizedEventId: string; derivationDigest: string };
  finding: {
    id: string;
    /** Persisted Signal scale, 0–100 (numeric(5,2)). */
    confidenceScore: number;
    severity: string;
    status: string;
    detectedBy: string;
    summary: string;
  } | null;
  recommendation: { id: string; status: string; recommendation: string | null; urgency: string | null; actionType: string } | null;
};

export type ScheduleTriggerCandidate =
  | { kind: "dependency_change"; entityId: string; label: string; status: string; changedAt: string }
  | { kind: "milestone_date_change"; entityId: string; label: string; status: string; changedAt: string };

export async function listScheduleExposures(client: Client, scope: Pick<ScheduleExposureScope, "workspaceId" | "projectId">, limit = 20): Promise<ScheduleExposureRecord[]> {
  const evidenceResult = await client.from("evidence_items")
    .select("id,title,content,confidence_score,missing_data_state,freshness_state,fixture_state,assertion_type,evaluated_at,occurred_at,recorded_at,correlation_id,source_id,source_reference,raw_input_id,normalized_event_id,derivation_digest")
    .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
    .eq("source_type", "schedule_evaluation")
    .not("normalized_event_id", "is", null)
    .order("recorded_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 50)));
  if (evidenceResult.error) fail("schedule_exposure_list_evidence", evidenceResult.error);
  const evidence = (evidenceResult.data ?? []) as Array<Record<string, unknown>>;
  if (evidence.length === 0) return [];

  const evidenceIds = evidence.map((e) => String(e.id));
  const eventIds = evidence.map((e) => String(e.normalized_event_id));
  const [events, signals] = await Promise.all([
    client.from("operational_normalized_events").select("id,event_payload")
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId).in("id", eventIds),
    client.from("operational_signals").select("id,evidence_item_id,confidence_score,severity,status,detected_by,summary")
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
      .in("evidence_item_id", evidenceIds).eq("signal_type", "schedule_risk"),
  ]);
  if (events.error) fail("schedule_exposure_list_events", events.error);
  if (signals.error) fail("schedule_exposure_list_findings", signals.error);
  const signalRows = (signals.data ?? []) as Array<Record<string, unknown>>;
  const signalIds = signalRows.map((s) => String(s.id));
  const recommendations = signalIds.length === 0 ? { data: [], error: null } : await client.from("recommended_actions")
    .select("id,source_signal_id,status,recommendation,urgency,recommended_action_type")
    .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
    .in("source_signal_id", signalIds);
  if (recommendations.error) fail("schedule_exposure_list_recommendations", recommendations.error);

  const payloadByEvent = new Map((events.data ?? []).map((e) => [String(e.id), (e.event_payload ?? {}) as Record<string, unknown>]));
  const signalByEvidence = new Map(signalRows.map((s) => [String(s.evidence_item_id), s]));
  const recommendationBySignal = new Map(((recommendations.data ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.source_signal_id), r]));

  return evidence.map((e) => {
    const payload = payloadByEvent.get(String(e.normalized_event_id)) ?? {};
    const evaluation = (payload.evaluation ?? {}) as Record<string, unknown>;
    const signal = signalByEvidence.get(String(e.id)) ?? null;
    const recommendation = signal ? recommendationBySignal.get(String(signal.id)) ?? null : null;
    return {
      evidenceId: String(e.id),
      title: String(e.title),
      content: String(e.content),
      confidence: Number(e.confidence_score),
      confidenceMethod: typeof evaluation.confidenceMethod === "string" ? evaluation.confidenceMethod : null,
      confidenceDrivers: Array.isArray(evaluation.confidenceDrivers) ? (evaluation.confidenceDrivers as string[]) : [],
      missingDataState: e.missing_data_state as ScheduleMissingDataState,
      missingData: Array.isArray(evaluation.missingData) ? (evaluation.missingData as ScheduleMissingDataItem[]) : [],
      engineLimitations: Array.isArray(evaluation.engineLimitations) ? (evaluation.engineLimitations as string[]) : [],
      freshnessState: String(e.freshness_state),
      fixtureState: String(e.fixture_state),
      assertionType: String(e.assertion_type),
      evaluatedAt: String(e.evaluated_at),
      occurredAt: String(e.occurred_at),
      recordedAt: String(e.recorded_at),
      correlationId: String(e.correlation_id),
      snapshotDigest: String(((payload.snapshot ?? {}) as Record<string, unknown>).digest ?? ""),
      trigger: (payload.trigger ?? null) as ScheduleExposureTrigger | null,
      exposures: Array.isArray(payload.exposures) ? (payload.exposures as MilestoneExposure[]) : [],
      severity: (payload.severity ?? null) as ScheduleExposureSeverity | null,
      provenance: {
        sourceId: String(e.source_id),
        sourceKey: e.source_reference ? String(e.source_reference) : null,
        rawInputId: String(e.raw_input_id),
        normalizedEventId: String(e.normalized_event_id),
        derivationDigest: String(e.derivation_digest),
      },
      finding: signal ? {
        id: String(signal.id),
        confidenceScore: Number(signal.confidence_score),
        severity: String(signal.severity),
        status: String(signal.status),
        detectedBy: String(signal.detected_by),
        summary: String(signal.summary),
      } : null,
      recommendation: recommendation ? {
        id: String(recommendation.id),
        status: String(recommendation.status),
        recommendation: recommendation.recommendation ? String(recommendation.recommendation) : null,
        urgency: recommendation.urgency ? String(recommendation.urgency) : null,
        actionType: String(recommendation.recommended_action_type),
      } : null,
    };
  });
}

/** The typed changes a PM can evaluate: recent dependencies and dated milestones of this project. */
export async function listScheduleTriggerCandidates(client: Client, scope: Pick<ScheduleExposureScope, "workspaceId" | "projectId">): Promise<ScheduleTriggerCandidate[]> {
  const inputs = await loadScheduleInputs(client, scope);
  const titles = new Map(inputs.tasks.map((t) => [t.id, t.title]));
  const deps: ScheduleTriggerCandidate[] = [...inputs.dependencies]
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, 10)
    .map((d) => ({
      kind: "dependency_change" as const,
      entityId: d.id,
      label: `${titles.get(d.predecessor_task_id) ?? "Unknown task"} → ${titles.get(d.successor_task_id) ?? "Unknown task"}`,
      status: d.status,
      changedAt: new Date(d.updated_at).toISOString(),
    }));
  const milestones: ScheduleTriggerCandidate[] = [...inputs.milestones]
    .filter((m) => m.status !== "completed" && m.status !== "cancelled")
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, 10)
    .map((m) => ({
      kind: "milestone_date_change" as const,
      entityId: m.id,
      label: m.title,
      status: m.status,
      changedAt: new Date(m.updated_at).toISOString(),
    }));
  return [...deps, ...milestones];
}
