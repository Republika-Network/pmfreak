/**
 * P2-16 — Schedule Exposure adapter (pure).
 *
 * Projects one typed schedule change through the EXISTING H9 engine
 * (validateGraph → forwardPass → backwardPass → computeFloat → computeCriticalPath →
 * computeCriticalMilestones) into a snapshot-bound, confidence-qualified evaluation that
 * the canonical spine can record as Raw Input → Normalized Event → Evidence → Finding →
 * Recommendation. No engine math is reimplemented here and nothing is persisted here.
 *
 * Honesty rules this module enforces:
 *   - invalid topology (cycle, self-dependency, dependency to a task outside the
 *     project graph) is REFUSED — no critical path is computed from it;
 *   - missing planned dates / milestone targets are reported, never silently assumed,
 *     and lower confidence; with no usable basis the result is `insufficient_data`;
 *   - confidence is a 0–1 fraction (the Evidence scale). The Finding re-expresses it on
 *     its own persisted 0–100 scale in the database; nothing here emits a percentage;
 *   - the snapshot digest covers the schedule STATE only — never a timestamp — so the
 *     same state always yields the same digest.
 */
import { createHash } from "node:crypto";
import type {
  ExecutionTaskDependencyRow,
  ExecutionTaskRow,
  ProjectMilestoneRow,
} from "@/lib/db/database-contract";
import { buildNormalizedDag } from "./normalize-graph";
import { validateGraph } from "./validate-graph";
import { forwardPass } from "./forward-pass";
import { backwardPass } from "./backward-pass";
import { computeFloat } from "./float";
import { computeCriticalPath } from "./compute-critical-path";
import { computeCriticalMilestones } from "./milestones";

export const SCHEDULE_EXPOSURE_ADAPTER = "pmfreak/schedule-exposure-adapter:v1";
export const SCHEDULE_ENGINE_KEY = "pmfreak/h9-critical-path:v1";
export const SCHEDULE_SNAPSHOT_CANONICALIZATION = "schedule-snapshot:v1";
export const SCHEDULE_CONFIDENCE_METHOD = "schedule-coverage:v1";
/** The engine models every dependency as finish-to-start + lag with no working calendar,
 *  so even complete input never yields more than this confidence. */
export const SCHEDULE_CONFIDENCE_CEILING = 0.9;
export const SCHEDULE_ENGINE_LIMITATIONS = [
  "Every dependency type is evaluated as finish-to-start plus lag.",
  "No working calendar: durations and lags are calendar days.",
  "Float is clamped at zero, so negative float is not reported.",
  "Projected finish assumes every task starts as early as the network allows from the earliest planned start.",
] as const;

const DAY_MS = 1000 * 60 * 60 * 24;

export type ScheduleExposureStatus = "qualified" | "no_exposure" | "insufficient_data" | "invalid_topology";
export type ScheduleMissingDataState = "COMPLETE" | "PARTIAL" | "UNKNOWN";
export type ScheduleExposureSeverity = "low" | "medium" | "high" | "critical";

export type ScheduleExposureTrigger =
  | {
      kind: "dependency_change";
      entityType: "execution_task_dependency";
      entityId: string;
      predecessorTaskId: string;
      successorTaskId: string;
      dependencyType: string;
      status: string;
      lagDays: number;
      previousStatus: string | null;
      changeEventId: string | null;
      changedAt: string;
    }
  | {
      /**
       * An explicit PM evaluation of a milestone's CURRENT schedule state. H8 keeps no durable
       * milestone date-change history, so this is never presented as an observed date change.
       */
      kind: "milestone_state_evaluation";
      entityType: "project_milestone";
      entityId: string;
      title: string;
      status: string;
      targetDate: string | null;
      forecastDate: string | null;
      baselineDate: string | null;
      /** The milestone row's updated_at — source-row provenance only; any field edit moves it. */
      sourceUpdatedAt: string;
    };

export type ScheduleSnapshot = {
  digest: string;
  canonicalization: typeof SCHEDULE_SNAPSHOT_CANONICALIZATION;
  engine: typeof SCHEDULE_ENGINE_KEY;
  taskCount: number;
  activeDependencyCount: number;
  milestoneCount: number;
};

export type ScheduleTopologyIssue = {
  type: "cycle_detected" | "self_dependency" | "orphan_reference" | "trigger_outside_graph";
  message: string;
  entityIds: string[];
};

export type ScheduleMissingDataItem = {
  code:
    | "no_tasks"
    | "task_planned_dates_missing"
    | "project_anchor_missing"
    | "milestone_target_date_missing"
    | "milestone_link_unresolved"
    | "no_milestone_linkage";
  message: string;
  entityIds: string[];
};

export type MilestoneExposure = {
  milestoneId: string;
  title: string;
  targetDate: string | null;
  forecastDate: string | null;
  projectedFinishDate: string | null;
  /** Days the dependency network pushes the linked work past the target date (engine-derived). */
  networkSlipDays: number | null;
  /** Days the recorded forecast is past the target date (as recorded by the PM). */
  forecastVarianceDays: number | null;
  isCritical: boolean;
  isAtRisk: boolean;
  isDelayed: boolean;
  linkedTaskIds: string[];
  reasons: string[];
};

export type ScheduleExposureEvaluation = {
  status: ScheduleExposureStatus;
  evaluatedAt: string;
  snapshot: ScheduleSnapshot;
  trigger: ScheduleExposureTrigger;
  topologyIssues: ScheduleTopologyIssue[];
  missingDataState: ScheduleMissingDataState;
  missingData: ScheduleMissingDataItem[];
  /** 0–1 fraction. Null when the evaluation was refused or had no usable basis. */
  confidence: number | null;
  confidenceMethod: typeof SCHEDULE_CONFIDENCE_METHOD;
  confidenceDrivers: string[];
  engineLimitations: string[];
  criticalTaskIds: string[];
  /** Project finish as an integer day offset from the earliest planned start (H9 convention). */
  projectFinishDays: number | null;
  exposures: MilestoneExposure[];
  severity: ScheduleExposureSeverity | null;
};

export type ScheduleExposureInput = {
  tasks: ExecutionTaskRow[];
  /** Every dependency of the project, any status. Only `active` edges enter the engine. */
  dependencies: ExecutionTaskDependencyRow[];
  milestones: ProjectMilestoneRow[];
  trigger: ScheduleExposureTrigger;
  /** Explicit evaluation clock. Recorded, never part of any digest. */
  evaluatedAt: string;
};

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function daysBetween(later: string, earlier: string): number {
  return Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / DAY_MS);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Content address of the schedule state the engine evaluates. Ordered tuples of every field
 * the engine, the milestone projection or the rendered canonical payload read — never
 * updated_at or any clock — so an identical schedule always digests identically and any edit
 * that would change the recorded content changes the identity.
 */
export function computeScheduleSnapshot(
  tasks: ExecutionTaskRow[],
  activeDependencies: ExecutionTaskDependencyRow[],
  milestones: ProjectMilestoneRow[],
): ScheduleSnapshot {
  const canonical = {
    canonicalization: SCHEDULE_SNAPSHOT_CANONICALIZATION,
    engine: SCHEDULE_ENGINE_KEY,
    // Titles are bound because the canonical payload renders them: a rename must be a new
    // snapshot, never the same identity with different content.
    tasks: [...tasks].sort(byId).map((t) => [
      t.id,
      t.title,
      isoOrNull(t.planned_start_date),
      isoOrNull(t.planned_finish_date),
      isoOrNull(t.forecast_finish_date),
      t.milestone_id ?? null,
      t.status,
    ]),
    dependencies: [...activeDependencies].sort(byId).map((d) => [
      d.id,
      d.predecessor_task_id,
      d.successor_task_id,
      d.dependency_type,
      d.lag_days ?? 0,
    ]),
    milestones: [...milestones].sort(byId).map((m) => [
      m.id,
      m.title,
      isoOrNull(m.target_date),
      isoOrNull(m.forecast_date),
      isoOrNull(m.baseline_date),
      m.status,
    ]),
  };
  return {
    digest: sha256(JSON.stringify(canonical)),
    canonicalization: SCHEDULE_SNAPSHOT_CANONICALIZATION,
    engine: SCHEDULE_ENGINE_KEY,
    taskCount: tasks.length,
    activeDependencyCount: activeDependencies.length,
    milestoneCount: milestones.length,
  };
}

function refused(
  base: Omit<ScheduleExposureEvaluation, "status" | "missingDataState" | "confidence" | "confidenceDrivers" | "criticalTaskIds" | "projectFinishDays" | "exposures" | "severity">,
  status: "invalid_topology" | "insufficient_data",
  confidenceDrivers: string[],
): ScheduleExposureEvaluation {
  return {
    ...base,
    status,
    missingDataState: "UNKNOWN",
    confidence: null,
    confidenceDrivers,
    criticalTaskIds: [],
    projectFinishDays: null,
    exposures: [],
    severity: null,
  };
}

function severityFor(exposures: MilestoneExposure[]): ScheduleExposureSeverity {
  const maxSlip = Math.max(0, ...exposures.map((e) => Math.max(e.networkSlipDays ?? 0, e.forecastVarianceDays ?? 0)));
  if (maxSlip >= 15) return "critical";
  if (maxSlip >= 5 || (maxSlip > 0 && exposures.some((e) => e.isCritical))) return "high";
  if (maxSlip > 0) return "medium";
  return "low";
}

export function evaluateScheduleExposure(input: ScheduleExposureInput): ScheduleExposureEvaluation {
  const { tasks, milestones, trigger } = input;
  const activeDependencies = input.dependencies.filter((d) => d.status === "active");
  const snapshot = computeScheduleSnapshot(tasks, activeDependencies, milestones);
  const base = {
    evaluatedAt: new Date(input.evaluatedAt).toISOString(),
    snapshot,
    trigger,
    topologyIssues: [] as ScheduleTopologyIssue[],
    missingData: [] as ScheduleMissingDataItem[],
    confidenceMethod: SCHEDULE_CONFIDENCE_METHOD as typeof SCHEDULE_CONFIDENCE_METHOD,
    engineLimitations: [...SCHEDULE_ENGINE_LIMITATIONS] as string[],
  };

  // ── Topology. Anything structurally wrong is refused before the engine runs. ──────────
  const { dag, droppedEdges } = buildNormalizedDag(tasks, activeDependencies, milestones);
  for (const dropped of droppedEdges) {
    base.topologyIssues.push({
      type: "orphan_reference",
      message: `Dependency ${dropped.dependencyId} references a task that is not in this project's schedule.`,
      entityIds: [dropped.dependencyId, ...dropped.missingTaskIds],
    });
  }
  const validation = validateGraph(dag);
  const titleOf = (id: string) => dag.nodes.get(id)?.task.title ?? id;
  for (const issue of validation.issues) {
    if (issue.type === "cycle_detected") {
      // Same cycle the engine found, named by task so the PM can act on it; ids stay in entityIds.
      const path = issue.taskIds ?? [];
      const message = path.length > 0 ? `Cycle detected: ${[...path, path[0]].map(titleOf).join(" → ")}` : issue.message;
      base.topologyIssues.push({ type: "cycle_detected", message, entityIds: path });
    } else if (issue.type === "invalid_dependency") {
      base.topologyIssues.push({ type: "self_dependency", message: issue.message, entityIds: issue.taskIds ?? [] });
    } else {
      base.topologyIssues.push({ type: "orphan_reference", message: issue.message, entityIds: issue.taskIds ?? [] });
    }
  }
  if (trigger.kind === "dependency_change" && (!dag.nodes.has(trigger.predecessorTaskId) || !dag.nodes.has(trigger.successorTaskId))) {
    base.topologyIssues.push({
      type: "trigger_outside_graph",
      message: "The changed dependency connects a task that is not in this project's schedule.",
      entityIds: [trigger.entityId],
    });
  }
  if (trigger.kind === "milestone_state_evaluation" && !milestones.some((m) => m.id === trigger.entityId)) {
    base.topologyIssues.push({
      type: "trigger_outside_graph",
      message: "The changed milestone is not in this project's schedule.",
      entityIds: [trigger.entityId],
    });
  }
  if (base.topologyIssues.length > 0) {
    return refused(base, "invalid_topology", ["Schedule topology is invalid; no critical path was computed."]);
  }

  if (tasks.length === 0) {
    base.missingData.push({ code: "no_tasks", message: "The project has no scheduled tasks to evaluate.", entityIds: [] });
    return refused(base, "insufficient_data", ["No tasks: there is no schedule to evaluate."]);
  }

  // ── Existing H9 engine, unchanged. ────────────────────────────────────────────────────
  const forward = forwardPass(dag);
  const { result: backward, projectFinish } = backwardPass(dag, forward);
  const floats = computeFloat(dag, forward, backward);
  const { result: cp, criticalityMap } = computeCriticalPath(dag, forward, backward, floats, projectFinish);
  const engineMilestones = computeCriticalMilestones(milestones, tasks, criticalityMap);

  // ── Coverage. ────────────────────────────────────────────────────────────────────────
  const undatedTasks = tasks.filter((t) => !isoOrNull(t.planned_start_date) || !isoOrNull(t.planned_finish_date));
  if (undatedTasks.length > 0) {
    base.missingData.push({
      code: "task_planned_dates_missing",
      message: `${undatedTasks.length} of ${tasks.length} task(s) have no planned start/finish; the engine treats each as one day.`,
      entityIds: undatedTasks.map((t) => t.id).sort(),
    });
  }
  const plannedStarts = tasks.map((t) => isoOrNull(t.planned_start_date)).filter((v): v is string => v !== null).sort();
  const anchor = plannedStarts[0] ?? null;
  if (!anchor) {
    base.missingData.push({ code: "project_anchor_missing", message: "No task has a planned start, so network finish dates cannot be placed on the calendar.", entityIds: [] });
  }
  const milestoneIds = new Set(milestones.map((m) => m.id));
  const unresolvedLinks = tasks.filter((t) => t.milestone_id && !milestoneIds.has(t.milestone_id));
  if (unresolvedLinks.length > 0) {
    base.missingData.push({
      code: "milestone_link_unresolved",
      message: `${unresolvedLinks.length} task(s) link to a milestone that is not in this project.`,
      entityIds: unresolvedLinks.map((t) => t.id).sort(),
    });
  }

  // ── Which milestones can this change expose? ─────────────────────────────────────────
  const openMilestones = milestones.filter((m) => m.status !== "completed" && m.status !== "cancelled");
  let candidateIds: Set<string>;
  if (trigger.kind === "dependency_change") {
    const downstream = new Set<string>();
    const queue = [trigger.successorTaskId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (downstream.has(id)) continue;
      downstream.add(id);
      for (const next of dag.successorMap.get(id) ?? []) queue.push(next);
    }
    candidateIds = new Set(
      engineMilestones
        .filter((m) => openMilestones.some((o) => o.id === m.milestoneId) && m.linkedTaskIds.some((id) => downstream.has(id)))
        .map((m) => m.milestoneId),
    );
  } else {
    candidateIds = new Set(openMilestones.some((m) => m.id === trigger.entityId) ? [trigger.entityId] : []);
  }

  const linkedAnywhere = engineMilestones.some((m) => m.linkedTaskIds.length > 0);
  if (candidateIds.size === 0 && !linkedAnywhere) {
    base.missingData.push({ code: "no_milestone_linkage", message: "No task is linked to an open milestone, so milestone exposure cannot be assessed.", entityIds: [] });
  }
  const candidates = milestones.filter((m) => candidateIds.has(m.id)).sort(byId);
  const untargeted = candidates.filter((m) => !isoOrNull(m.target_date));
  if (untargeted.length > 0) {
    base.missingData.push({
      code: "milestone_target_date_missing",
      message: `${untargeted.length} affected milestone(s) have no target date, so slippage against them cannot be measured.`,
      entityIds: untargeted.map((m) => m.id),
    });
  }

  // ── Missing-data state and confidence (0–1). ─────────────────────────────────────────
  const taskCoverage = (tasks.length - undatedTasks.length) / tasks.length;
  const milestoneCoverage = candidates.length === 0 ? 1 : (candidates.length - untargeted.length) / candidates.length;
  const noBasis =
    taskCoverage === 0 ||
    !anchor ||
    (candidates.length > 0 && untargeted.length === candidates.length) ||
    (candidates.length === 0 && !linkedAnywhere);
  if (noBasis) {
    return refused(base, "insufficient_data", [
      "Required schedule inputs are missing; exposure cannot be stated with any confidence.",
    ]);
  }
  const missingDataState: ScheduleMissingDataState = base.missingData.length === 0 ? "COMPLETE" : "PARTIAL";
  const linkPenalty = unresolvedLinks.length > 0 ? 0.9 : 1;
  const confidence = Math.round(SCHEDULE_CONFIDENCE_CEILING * taskCoverage * milestoneCoverage * linkPenalty * 10000) / 10000;
  const confidenceDrivers = [
    `Engine ceiling ${SCHEDULE_CONFIDENCE_CEILING} (dependency types, calendars and negative float are not modelled).`,
    `Task planned-date coverage ${(taskCoverage * 100).toFixed(0)}%.`,
    `Affected-milestone target-date coverage ${(milestoneCoverage * 100).toFixed(0)}%.`,
    ...(unresolvedLinks.length > 0 ? ["Unresolved milestone links reduce confidence by 10%."] : []),
  ];

  // ── Exposure per affected milestone. ─────────────────────────────────────────────────
  const exposures: MilestoneExposure[] = [];
  for (const milestone of candidates) {
    const engine = engineMilestones.find((m) => m.milestoneId === milestone.id)!;
    const targetDate = isoOrNull(milestone.target_date);
    const forecastDate = isoOrNull(milestone.forecast_date);
    const linkedFinishes = engine.linkedTaskIds.map((id) => forward.get(id)?.earlyFinish).filter((v): v is number => typeof v === "number");
    const projectedFinishDate =
      anchor && linkedFinishes.length > 0 ? new Date(new Date(anchor).getTime() + Math.max(...linkedFinishes) * DAY_MS).toISOString() : null;
    const networkSlipDays = projectedFinishDate && targetDate ? daysBetween(projectedFinishDate, targetDate) : null;
    const forecastVarianceDays = forecastDate && targetDate ? engine.varianceDays : null;

    const reasons: string[] = [];
    if (networkSlipDays !== null && networkSlipDays > 0) {
      reasons.push(`The dependency network finishes the linked work ${networkSlipDays} day(s) after the target date.`);
    }
    if (engine.isDelayed) reasons.push(`The recorded forecast is ${engine.varianceDays} day(s) past the target date.`);
    if (engine.isAtRisk) reasons.push("A linked task's forecast finish is later than its planned finish.");
    if (reasons.length === 0) continue;
    if (engine.isCritical) reasons.push("The milestone is fed by critical-path work (zero float).");

    exposures.push({
      milestoneId: milestone.id,
      title: milestone.title,
      targetDate,
      forecastDate,
      projectedFinishDate,
      networkSlipDays,
      forecastVarianceDays,
      isCritical: engine.isCritical,
      isAtRisk: engine.isAtRisk,
      isDelayed: engine.isDelayed,
      linkedTaskIds: [...engine.linkedTaskIds].sort(),
      reasons,
    });
  }
  exposures.sort((a, b) => {
    const slip = (e: MilestoneExposure) => Math.max(e.networkSlipDays ?? 0, e.forecastVarianceDays ?? 0);
    return slip(b) - slip(a) || (a.milestoneId < b.milestoneId ? -1 : a.milestoneId > b.milestoneId ? 1 : 0);
  });

  return {
    ...base,
    status: exposures.length > 0 ? "qualified" : "no_exposure",
    missingDataState,
    confidence,
    confidenceDrivers,
    criticalTaskIds: [...cp.criticalTaskIds].sort(),
    projectFinishDays: projectFinish,
    exposures,
    severity: exposures.length > 0 ? severityFor(exposures) : null,
  };
}

function describeTrigger(trigger: ScheduleExposureTrigger, taskTitles: Map<string, string>): string {
  if (trigger.kind === "dependency_change") {
    const pred = taskTitles.get(trigger.predecessorTaskId) ?? trigger.predecessorTaskId;
    const succ = taskTitles.get(trigger.successorTaskId) ?? trigger.successorTaskId;
    const transition = trigger.previousStatus && trigger.previousStatus !== trigger.status ? `${trigger.previousStatus} → ${trigger.status}` : trigger.status;
    const lag = trigger.lagDays ? `, lag ${trigger.lagDays}d` : "";
    return `Dependency "${pred}" → "${succ}" (${trigger.dependencyType.replace(/_/g, " ")}${lag}) is ${transition}.`;
  }
  const target = trigger.targetDate ? trigger.targetDate.slice(0, 10) : "no target";
  const forecast = trigger.forecastDate ? trigger.forecastDate.slice(0, 10) : "no forecast";
  return `Current state of milestone "${trigger.title}" evaluated on request (${trigger.status}; target ${target}, forecast ${forecast}).`;
}

/**
 * The canonical payload recorded as Raw Input. Deterministic for a given evaluation:
 * it carries no evaluation timestamp, so replaying the same snapshot and change produces
 * the same content digest and the same idempotency identity.
 */
export function buildScheduleExposurePayload(
  evaluation: ScheduleExposureEvaluation,
  tasks: Pick<ExecutionTaskRow, "id" | "title">[],
): Record<string, unknown> {
  if (evaluation.status !== "qualified" || evaluation.confidence === null || !evaluation.severity) {
    throw new Error("schedule_exposure_not_qualified");
  }
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const lead = evaluation.exposures[0];
  const leadSlip = Math.max(lead.networkSlipDays ?? 0, lead.forecastVarianceDays ?? 0);
  const title =
    leadSlip > 0
      ? `Schedule exposure: milestone "${lead.title}" projected ${leadSlip} day(s) past target`
      : `Schedule exposure: milestone "${lead.title}" is at risk`;
  const whatChanged = describeTrigger(evaluation.trigger, titles);
  const whyItMatters = evaluation.exposures.map((e) => `• ${e.title}: ${e.reasons.join(" ")}`).join("\n");
  const coverage =
    evaluation.missingDataState === "COMPLETE"
      ? "All schedule inputs the engine reads were present."
      : `Partial inputs: ${evaluation.missingData.map((m) => m.message).join(" ")}`;
  const content = [
    `What changed: ${whatChanged}`,
    `Why it matters (inference of the deterministic schedule engine, not an observed fact):`,
    whyItMatters,
    `Coverage: ${coverage}`,
    `Snapshot: ${evaluation.snapshot.digest}`,
  ].join("\n");
  const recommendation =
    evaluation.trigger.kind === "dependency_change"
      ? `Confirm whether the dependency is required as modelled; if it is, re-plan the linked work or the target date of "${lead.title}" and record the chosen response as a Decision.`
      : `Review the current dates of "${lead.title}" against the dependency network and record the chosen response (re-plan, mitigate or accept) as a Decision.`;

  return {
    schemaVersion: 1,
    adapter: SCHEDULE_EXPOSURE_ADAPTER,
    engine: SCHEDULE_ENGINE_KEY,
    title,
    content,
    snapshot: evaluation.snapshot,
    trigger: evaluation.trigger,
    evaluation: {
      status: evaluation.status,
      confidence: evaluation.confidence,
      confidenceScale: "0-1",
      confidenceMethod: evaluation.confidenceMethod,
      confidenceDrivers: evaluation.confidenceDrivers,
      missingDataState: evaluation.missingDataState,
      missingData: evaluation.missingData,
      engineLimitations: evaluation.engineLimitations,
      criticalTaskIds: evaluation.criticalTaskIds,
      projectFinishDays: evaluation.projectFinishDays,
    },
    exposures: evaluation.exposures,
    severity: evaluation.severity,
    recommendation,
  };
}
