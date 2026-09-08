/**
 * UX-W4 — the governed EXECUTION root must be open work, not a history window.
 *
 * `getOperationalSummary` loads `operational_decision_records` as a recent history window:
 * newest 30, project-wide. The chain projection walks outward from it, so thirty newer
 * decisions push an older one out and take every Action, Task, Execution and Outcome
 * beneath it off the surface. "In Progress" then renders empty while the work runs.
 *
 * This harness runs the REAL `getOperationalSummary` against the same faithful Data API
 * stub the W3 root harness uses — filters, then order, then limit, then range, exactly as
 * PostgREST does — so the window that hides the running work is real rather than simulated.
 * The chains and the rendered section come from the REAL read models on top of it.
 *
 * Scenarios:
 *   falseClear      30 newer decisions with no work + 1 OLDER decision with a RUNNING
 *                   execution. The old decision is genuinely outside `decisions`.
 *   pendingResult   the same shape, but the old chain is complete with an unobserved
 *                   Outcome — the VERIFY case, which must not read as "no result".
 *   ceilingOverflow more active executions than the root ceiling, so membership is
 *                   UNPROVEN and the section must withhold its claims.
 *
 * Executed by `tests/ux-w4-decision-execution-loop.test.mjs` through tsx.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { getOperationalSummary } from "@/lib/operational-flow/operational-flow-service";
import { buildExecutionChains } from "../src/modules/workspace/presentation/command-center/execution-read-model";
import { projectChainProgress } from "../src/modules/workspace/presentation/command-center/in-progress-read-model";
import { deriveDecisionJourney } from "../src/modules/workspace/presentation/command-center/decision-journey";
import { ExecutionQueue } from "../src/modules/workspace/presentation/command-center/execution-queue";

type Row = Record<string, unknown>;

const WORKSPACE = "ws-1";
const PROJECT = "proj-1";
const ACTOR = "actor-pm";

const AS_OF = "2027-01-01T00:00:00Z";
const NOW = new Date(AS_OF);
const OLD = "2026-01-01T00:00:00Z";
const FUTURE = "2027-12-01T00:00:00Z";
const NEWER = (index: number) => `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`;

const scoped = (row: Row): Row => ({ workspace_id: WORKSPACE, project_id: PROJECT, ...row });

/** A Decision with NOTHING beneath it — pure window filler. */
function barrenDecision(id: string, createdAt: string): Row {
  return scoped({
    id,
    decision_status: "rejected",
    decided_by: ACTOR,
    recommendation_id: null,
    rationale: `Filler ${id}`,
    governance_event_id: `gov-${id}`,
    created_at: createdAt,
  });
}

/** A full canonical chain: Decision -> Action -> Task -> Execution, and optionally an
 *  Outcome. Every row carries the columns its migration declares. */
function workingChain(
  id: string,
  createdAt: string,
  executionStatus: string,
  outcomeState: string | null
): Record<string, Row[]> {
  const rows: Record<string, Row[]> = {
    operational_decision_records: [
      scoped({
        id: `dec-${id}`,
        decision_status: "accepted",
        decided_by: ACTOR,
        recommendation_id: `rec-${id}`,
        rationale: `We accepted ${id} because the change was justified.`,
        governance_event_id: `gov-${id}`,
        created_at: createdAt,
      }),
    ],
    material_action_proposals: [
      scoped({
        id: `act-${id}`,
        source_decision_id: `dec-${id}`,
        proposed_by: ACTOR,
        proposal_digest: "a".repeat(64),
        idempotency_key: `idem-${id}`,
        action_class: "ordinary_business_write",
        materiality: "ordinary",
        proposal: { actionType: "prepare_change_request", evidenceReferenceIds: [] },
        correlation_id: `corr-${id}`,
        expires_at: FUTURE,
        created_at: createdAt,
        persisted_at: createdAt,
      }),
    ],
    material_action_governance_evaluations: [
      scoped({
        id: `eval-${id}`,
        action_id: `act-${id}`,
        proposal_digest: "a".repeat(64),
        governance_state: "not_required",
        can_commit_action: true,
        can_execute: false,
        grant_references: [],
        policy_decision_reference: null,
        evaluated_at: createdAt,
        recorded_at: createdAt,
        valid_until: null,
      }),
    ],
    execution_tasks: [
      scoped({
        id: `task-${id}`,
        title: `Work for ${id}`,
        status: executionStatus === "completed" ? "completed" : "in_progress",
        source_payload: { source: "governed_action", sourceActionId: `act-${id}` },
        created_at: createdAt,
        completed_at: executionStatus === "completed" ? createdAt : null,
      }),
    ],
    internal_task_executions: [
      scoped({
        id: `exec-${id}`,
        task_id: `task-${id}`,
        source_action_id: `act-${id}`,
        status: executionStatus,
        attempt_count: 1,
        dispatched_by: ACTOR,
        queued_at: createdAt,
        started_at: createdAt,
        completed_at: executionStatus === "completed" ? createdAt : null,
        last_transition_at: createdAt,
        created_at: createdAt,
      }),
    ],
    canonical_task_outcomes: outcomeState
      ? [
          scoped({
            id: `out-${id}`,
            task_id: `task-${id}`,
            source_action_id: `act-${id}`,
            internal_execution_id: `exec-${id}`,
            state: outcomeState,
            expected_result: `Expected result for ${id}`,
            success_criteria: [],
            correlation_id: `corr-${id}`,
            created_by: ACTOR,
            created_at: createdAt,
          }),
        ]
      : [],
    recommended_actions: [
      scoped({
        id: `rec-${id}`,
        recommendation: `Recommendation ${id}`,
        status: "accepted",
        governance_event_id: `gov-${id}`,
        created_at: createdAt,
        updated_at: createdAt,
      }),
    ],
  };
  return rows;
}

const EMPTY_TABLES = (): Record<string, Row[]> => ({
  recommended_actions: [],
  evidence_items: [],
  operational_signals: [],
  risk_issue_records: [],
  governance_events: [],
  operational_decision_records: [],
  decision_evidence_links: [],
  material_action_proposals: [],
  material_action_governance_evaluations: [],
  execution_tasks: [],
  internal_task_executions: [],
  canonical_task_outcomes: [],
  canonical_outcome_observations: [],
  operational_sources: [],
  operational_raw_inputs: [],
  operational_normalized_events: [],
  workspace_memberships: [{ workspace_id: WORKSPACE, user_id: ACTOR, role: "owner" }],
  __assurance: [{ openRecommendations: 0, asOf: AS_OF, openRecommendationIds: [] }],
});

function merge(base: Record<string, Row[]>, ...groups: Record<string, Row[]>[]): Record<string, Row[]> {
  const out = { ...base };
  for (const group of groups) {
    for (const [table, rows] of Object.entries(group)) {
      out[table] = [...(out[table] ?? []), ...rows];
    }
  }
  return out;
}

/** 30 newer barren Decisions push the older WORKING one out of the newest-30 window. */
function rootScenario(executionStatus: string, outcomeState: string | null): Record<string, Row[]> {
  const filler = Array.from({ length: 30 }, (_, index) => barrenDecision(`dec-filler-${index}`, NEWER(index)));
  return merge(
    { ...EMPTY_TABLES(), operational_decision_records: filler },
    workingChain("old", OLD, executionStatus, outcomeState)
  );
}

const falseClearTables = rootScenario("running", null);
const pendingResultTables = rootScenario("completed", "expected");

/**
 * More active executions than the root ceiling.
 *
 * `EXECUTION_ROOT_CEILING` is 500 and the read asks for 501. Getting 501 back is the
 * overflow signal, and the only honest answer is that this page does not hold every open
 * chain — not a silently truncated list presented as the whole project.
 */
const overflowTables = (() => {
  let tables = { ...EMPTY_TABLES() };
  for (let index = 0; index < 501; index += 1) {
    tables = merge(tables, workingChain(`bulk-${String(index).padStart(4, "0")}`, NEWER(index), "running", null));
  }
  return tables;
})();

let TABLES: Record<string, Row[]> = falseClearTables;

type QueryBuilder = {
  select: (columns: string) => QueryBuilder;
  eq: (column: string, value: unknown) => QueryBuilder;
  in: (column: string, values: unknown[]) => QueryBuilder;
  lte: (column: string, value: unknown) => QueryBuilder;
  gt: (column: string, value: unknown) => QueryBuilder;
  not: (column: string, operator: string, value: unknown) => QueryBuilder;
  is: (column: string, value: unknown) => QueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => QueryBuilder;
  limit: (value: number) => QueryBuilder;
  range: (from: number, to: number) => QueryBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  single: () => Promise<{ data: Row | null; error: null }>;
  then: (
    onFulfilled: (value: { data: Row[]; error: null }) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise<unknown>;
};

/** Filters, then order, then limit, then range — the order that makes the truncation real. */
function makeClient() {
  function builder(table: string): QueryBuilder {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const notNull: string[] = [];
    const isNull: string[] = [];
    const lte: Array<[string, unknown]> = [];
    const gt: Array<[string, unknown]> = [];
    const orderBy: Array<{ column: string; ascending: boolean }> = [];
    let limit: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;

    const read = (column: string, row: Row): unknown => {
      const arrow = column.split("->>");
      if (arrow.length === 1) return row[column];
      const container = row[arrow[0]] as Row | undefined;
      return container?.[arrow[1]];
    };

    const resolve = () => {
      let rows = [...(TABLES[table] ?? [])];
      for (const [column, value] of eqs) rows = rows.filter((row) => String(read(column, row)) === String(value));
      for (const [column, values] of ins) rows = rows.filter((row) => values.map(String).includes(String(read(column, row))));
      for (const [column, value] of lte) {
        rows = rows.filter((row) => {
          const cell = read(column, row);
          return cell !== null && cell !== undefined && String(cell) <= String(value);
        });
      }
      for (const [column, value] of gt) {
        rows = rows.filter((row) => {
          const cell = read(column, row);
          return cell !== null && cell !== undefined && String(cell) > String(value);
        });
      }
      for (const column of notNull) rows = rows.filter((row) => read(column, row) !== null && read(column, row) !== undefined);
      for (const column of isNull) rows = rows.filter((row) => read(column, row) === null || read(column, row) === undefined);
      if (orderBy.length > 0) {
        rows.sort((a, b) => {
          for (const { column, ascending } of orderBy) {
            const left = String(a[column] ?? "");
            const right = String(b[column] ?? "");
            const compared = ascending ? left.localeCompare(right) : right.localeCompare(left);
            if (compared !== 0) return compared;
          }
          return 0;
        });
      }
      if (limit !== null) rows = rows.slice(0, limit);
      if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
      return { data: rows, error: null };
    };

    const chain: QueryBuilder = {
      select: () => chain,
      eq: (column, value) => { eqs.push([column, value]); return chain; },
      in: (column, values) => { ins.push([column, values]); return chain; },
      lte: (column, value) => { lte.push([column, value]); return chain; },
      gt: (column, value) => { gt.push([column, value]); return chain; },
      is: (column, value) => {
        if (value !== null) throw new Error(`unsupported_stub_filter: is(${column}, ${String(value)})`);
        isNull.push(column);
        return chain;
      },
      not: (column, operator, value) => {
        if (operator !== "is" || value !== null) {
          throw new Error(`unsupported_stub_filter: not(${column}, ${operator}, ${String(value)})`);
        }
        notNull.push(column);
        return chain;
      },
      order: (column, options) => { orderBy.push({ column, ascending: options?.ascending !== false }); return chain; },
      limit: (value) => { limit = value; return chain; },
      range: (from, to) => { rangeFrom = from; rangeTo = to; return chain; },
      maybeSingle: async () => ({ data: resolve().data[0] ?? null, error: null }),
      single: async () => ({ data: resolve().data[0] ?? null, error: null }),
      then: (onFulfilled, onRejected) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return chain;
  }

  return {
    from: (table: string) => builder(table),
    rpc: async (name: string) =>
      name === "get_operational_assurance_summary" ? { data: TABLES.__assurance?.[0] ?? {}, error: null } : { data: null, error: null },
  };
}

const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function scenario(tables: Record<string, Row[]>) {
  TABLES = tables;
  const summary = await getOperationalSummary(makeClient() as never, WORKSPACE, PROJECT, ACTOR);
  const chains = buildExecutionChains(summary, NOW);
  const progress = projectChainProgress(chains);
  const incomplete = summary.governedExecutionRootComplete !== true;
  const markup = renderToStaticMarkup(
    <ExecutionQueue
      chains={chains}
      onSelect={() => {}}
      actorUserId={ACTOR}
      incomplete={incomplete}
      incompleteNote={
        incomplete ? "Some of this project's work could not be read, so this list may not be complete." : null
      }
    />
  );
  return {
    rootComplete: summary.governedExecutionRootComplete ?? null,
    /** Decisions the RECENT WINDOW carries. The whole point is that the working one is not here. */
    windowDecisionIds: (summary.decisions ?? []).map((row) => String(row.id)),
    /** Decisions the EXECUTION ROOT recovered, which the window could not reach. */
    rootDecisionIds: (summary.governedExecutionRootDecisions ?? []).map((row) => String(row.id)),
    chainDecisionIds: chains.map((chain) => chain.decisionId),
    inProgressDecisionIds: progress.inProgress.map((chain) => chain.decisionId),
    journeys: chains.map((chain) => {
      const journey = deriveDecisionJourney(chain, ACTOR);
      return { decisionId: journey.decisionId, phase: journey.phase, closure: journey.closure, state: journey.state, next: journey.next };
    }),
    queue: { markup, text: text(markup) },
  };
}

async function main() {
  const out = {
    falseClear: await scenario(falseClearTables),
    pendingResult: await scenario(pendingResultTables),
    ceilingOverflow: await scenario(overflowTables),
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack : error));
  process.exit(1);
});
