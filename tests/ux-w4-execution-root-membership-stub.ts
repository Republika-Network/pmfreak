/**
 * UX-W4 — a faithful stand-in for `get_governed_execution_root`.
 *
 * The harnesses that exercise the real `getOperationalSummary` need a Data API stub, and
 * that stub must answer the membership RPC the way the DATABASE does — otherwise the
 * client would be tested against a projection nobody wrote. This module is that answer,
 * and it is a direct transcription of the predicate in
 * `supabase/migrations/20260909000000_ux_w4_governed_execution_root_membership.sql`:
 *
 *     open(D)  ⇔  D.decision_status in ('accepted','modified')
 *                 AND ( D has no Material Action
 *                       OR some Material Action of D is UNRESOLVED )
 *
 *     unresolved(A)  ⇔  A's branch has no Outcome that TERMINATES it
 *
 *     terminates(O)  ⇔  O.state = 'superseded'
 *                       OR ( O.state is a resolved result
 *                            AND an Observation for O exists )
 *
 * Crucially it is evaluated over ONE table snapshot, exactly as one SQL statement is. That
 * is what makes the MVCC harness a real proof rather than a restatement: the client cannot
 * assemble this set across instants because the projection is not assembled at all.
 *
 * The SQL text itself is separately pinned by the migration contract assertions in
 * `tests/ux-w4-decision-execution-loop.test.mjs`, so this transcription cannot drift away
 * from the statement it models without a test saying so.
 */

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

/** Decision statuses that can carry work, per `persist_governed_material_action`. */
const WORK_BEARING = ["accepted", "modified"];
/** Outcome states in which a result has actually been established. */
const RESOLVED_OUTCOME_STATES = [
  "achieved",
  "partially_achieved",
  "not_achieved",
  "disputed",
  "inconclusive",
];

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

export type ExecutionRootProjection = {
  scope: "project";
  workspaceId: string;
  projectId: string;
  asOf: string;
  openExecutionDecisions: number;
  openExecutionDecisionIds: string[];
};

export function computeGovernedExecutionRoot(
  tables: Tables,
  workspaceId: string,
  projectId: string,
  asOf: string
): ExecutionRootProjection {
  const scopeOf = (row: Row): boolean =>
    str(row.workspace_id) === workspaceId && str(row.project_id) === projectId;

  const decisions = (tables.operational_decision_records ?? []).filter(scopeOf);
  const actions = (tables.material_action_proposals ?? []).filter(scopeOf);
  const tasks = (tables.execution_tasks ?? []).filter(scopeOf);
  const outcomes = (tables.canonical_task_outcomes ?? []).filter(scopeOf);
  const observations = (tables.canonical_outcome_observations ?? []).filter(scopeOf);

  /** P2-07: at most one governed Task per Action. */
  const taskByAction = new Map<string, Row>();
  for (const task of tasks) {
    const payload = task.source_payload as { source?: unknown; sourceActionId?: unknown } | null;
    if (!payload || str(payload.source) !== "governed_action") continue;
    const actionId = str(payload.sourceActionId);
    if (actionId && !taskByAction.has(actionId)) taskByAction.set(actionId, task);
  }
  /** P2-09 `canonical_task_outcomes_one_per_task`: at most one Outcome per Task. */
  const outcomeByTask = new Map<string, Row>();
  for (const outcome of outcomes) {
    const taskId = str(outcome.task_id);
    if (taskId && !outcomeByTask.has(taskId)) outcomeByTask.set(taskId, outcome);
  }
  const observedOutcomeIds = new Set(observations.map((row) => str(row.outcome_id)));

  const actionsByDecision = new Map<string, Row[]>();
  for (const action of actions) {
    const decisionId = str(action.source_decision_id);
    if (!decisionId) continue;
    const bucket = actionsByDecision.get(decisionId);
    if (bucket) bucket.push(action);
    else actionsByDecision.set(decisionId, [action]);
  }

  /** Does an Outcome end this branch — superseded, or a result with its Observation? */
  const branchIsUnresolved = (action: Row): boolean => {
    const task = taskByAction.get(str(action.id));
    if (!task) return true;
    const outcome = outcomeByTask.get(str(task.id));
    if (!outcome) return true;
    const state = str(outcome.state);
    if (state === "superseded") return false;
    if (RESOLVED_OUTCOME_STATES.includes(state) && observedOutcomeIds.has(str(outcome.id))) return false;
    return true;
  };

  const open = decisions.filter((decision) => {
    if (!WORK_BEARING.includes(str(decision.decision_status))) return false;
    const branches = actionsByDecision.get(str(decision.id)) ?? [];
    if (branches.length === 0) return true;
    return branches.some(branchIsUnresolved);
  });

  // Same deterministic order the SQL declares: newest Decision first, id as the tiebreak.
  const ordered = [...open].sort((a, b) => {
    const at = str(b.created_at).localeCompare(str(a.created_at));
    return at !== 0 ? at : str(a.id).localeCompare(str(b.id));
  });

  return {
    scope: "project",
    workspaceId,
    projectId,
    asOf,
    // Count and ids come from ONE evaluation, exactly as they come from one statement.
    openExecutionDecisions: ordered.length,
    openExecutionDecisionIds: ordered.map((row) => str(row.id)),
  };
}
