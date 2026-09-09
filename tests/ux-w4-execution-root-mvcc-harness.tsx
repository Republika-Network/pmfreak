/**
 * UX-W4 — the cross-statement MVCC counterexample, and the single-snapshot proof.
 *
 * The first cut of the governed execution root asked THREE independent questions:
 *
 *     Q1  active executions      (status in queued/running/blocked/failed)
 *     Q2  pending outcomes       (state in expected/observing)
 *     Q3  unexpired actions      (expires_at > asOf)
 *
 * and treated their union as the authoritative membership of "work that is still open",
 * calling it COMPLETE whenever none of the three hit its row ceiling.
 *
 * Three statements are three snapshots. `Promise.all` starts them together; it does not
 * give them a shared MVCC snapshot, and PostgreSQL takes a new snapshot per statement under
 * READ COMMITTED. So a canonical transition that moves work from one predicate to another
 * can fall through the gap between two of the reads:
 *
 *     initial:   Execution E = running          Outcome = absent      Action A = expired
 *
 *     Q2 reads  (pending outcomes)   ── snapshot BEFORE the transition ──▶  {}
 *     ┄┄ the transition COMMITS:  E → completed,  Outcome O → expected ┄┄
 *     Q1 reads  (active executions)  ── snapshot AFTER  the transition ──▶  {}
 *     Q3 reads  (unexpired actions)  ── A expired, so it cannot rescue ──▶  {}
 *
 *     union = {}
 *
 * No snapshot of the database ever contained that union: BEFORE the commit Q2 would have
 * matched nothing but Q1 would have matched E, and AFTER the commit Q1 matches nothing but
 * Q2 matches O. The union is an artefact of reading across the commit, and the Decision it
 * belongs to — whose journey is VERIFY/open — disappears from the surface. Worse, all three
 * result sets are far below the ceiling, so the old code reported the answer as COMPLETE.
 *
 * This harness makes that interleave real. The Data API stub resolves each table against a
 * named world, so `canonical_task_outcomes` can be read in the BEFORE world while
 * `internal_task_executions` is read in the AFTER world — exactly one legal interleaving of
 * two statements around one commit, not a simulation of one.
 *
 * Scenarios:
 *   interleaved              the counterexample above, with the single-statement membership
 *                            projection taken in the EARLIER world — the adversarial choice,
 *                            the same instant the old Q2 read.
 *   interleavedLateSnapshot  the same interleave with the projection taken in the LATER
 *                            world. The Decision is open on both sides of the commit, so one
 *                            statement names it either way — which is what makes the repair
 *                            independent of WHEN the snapshot was taken.
 *   consistent               the SAME rows read from ONE world everywhere, which is what a
 *                            single statement would have seen. This is the control: the
 *                            discarded three-predicate proof FINDS the Decision here, so
 *                            `interleaved` losing it is the cross-statement read and not an
 *                            unreachable fixture.
 *
 * Every scenario also reports what `legacyThreeStatementRoot` would have concluded from the
 * same interleave, so the regression proves the defect rather than asserting it about code
 * that no longer exists.
 *
 * Executed by `tests/ux-w4-decision-execution-loop.test.mjs` through tsx.
 */

import { getOperationalSummary } from "@/lib/operational-flow/operational-flow-service";
import { buildExecutionChains } from "../src/modules/workspace/presentation/command-center/execution-read-model";
import { deriveDecisionJourney } from "../src/modules/workspace/presentation/command-center/decision-journey";
import { computeGovernedExecutionRoot } from "./ux-w4-execution-root-membership-stub";

type Row = Record<string, unknown>;

const WORKSPACE = "ws-1";
const PROJECT = "proj-1";
const ACTOR = "actor-pm";

const AS_OF = "2027-01-01T00:00:00Z";
const NOW = new Date(AS_OF);
/** The Decision under test is OLD, so the newest-30 history window cannot reach it. */
const OLD = "2026-01-01T00:00:00Z";
/** The Action's authorisation lapsed before the snapshot, so Q3 cannot rescue the root. */
const EXPIRED = "2026-02-01T00:00:00Z";
const NEWER = (index: number) => `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`;

const scoped = (row: Row): Row => ({ workspace_id: WORKSPACE, project_id: PROJECT, ...row });

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

const DECISION = scoped({
  id: "dec-mvcc",
  decision_status: "accepted",
  decided_by: ACTOR,
  recommendation_id: "rec-mvcc",
  rationale: "We accepted the rollout because the risk was contained.",
  governance_event_id: "gov-mvcc",
  created_at: OLD,
});

/** Authorised once, and long expired by `asOf`. Q3 therefore returns nothing for it. */
const ACTION = scoped({
  id: "act-mvcc",
  source_decision_id: "dec-mvcc",
  proposed_by: ACTOR,
  proposal_digest: "a".repeat(64),
  idempotency_key: "idem-mvcc",
  action_class: "ordinary_business_write",
  materiality: "ordinary",
  proposal: { actionType: "prepare_change_request", evidenceReferenceIds: [] },
  correlation_id: "corr-mvcc",
  expires_at: EXPIRED,
  created_at: OLD,
  persisted_at: OLD,
});

const EVALUATION = scoped({
  id: "eval-mvcc",
  action_id: "act-mvcc",
  proposal_digest: "a".repeat(64),
  governance_state: "not_required",
  can_commit_action: true,
  can_execute: false,
  grant_references: [],
  policy_decision_reference: null,
  evaluated_at: OLD,
  recorded_at: OLD,
  valid_until: null,
});

const task = (status: string): Row =>
  scoped({
    id: "task-mvcc",
    title: "Roll out the contained change",
    status,
    source_payload: { source: "governed_action", sourceActionId: "act-mvcc" },
    created_at: OLD,
    completed_at: status === "completed" ? OLD : null,
  });

const execution = (status: string): Row =>
  scoped({
    id: "exec-mvcc",
    task_id: "task-mvcc",
    source_action_id: "act-mvcc",
    status,
    attempt_count: 1,
    dispatched_by: ACTOR,
    queued_at: OLD,
    started_at: OLD,
    completed_at: status === "completed" ? OLD : null,
    last_transition_at: OLD,
    created_at: OLD,
  });

const OUTCOME = scoped({
  id: "out-mvcc",
  task_id: "task-mvcc",
  source_action_id: "act-mvcc",
  internal_execution_id: "exec-mvcc",
  state: "expected",
  expected_result: "The contained change is live and stable.",
  success_criteria: [],
  correlation_id: "corr-mvcc",
  created_by: ACTOR,
  created_at: OLD,
});

const FILLER = Array.from({ length: 30 }, (_, index) => barrenDecision(`dec-filler-${index}`, NEWER(index)));

function world(phase: "before" | "after"): Record<string, Row[]> {
  const done = phase === "after";
  return {
    recommended_actions: [
      scoped({
        id: "rec-mvcc",
        recommendation: "Roll out the contained change",
        status: "accepted",
        governance_event_id: "gov-mvcc",
        created_at: OLD,
        updated_at: OLD,
      }),
    ],
    evidence_items: [],
    operational_signals: [],
    risk_issue_records: [],
    governance_events: [],
    operational_decision_records: [...FILLER, DECISION],
    decision_evidence_links: [],
    material_action_proposals: [ACTION],
    material_action_governance_evaluations: [EVALUATION],
    execution_tasks: [task(done ? "completed" : "in_progress")],
    internal_task_executions: [execution(done ? "completed" : "running")],
    // The commit that ends the work is the same commit that creates the expected Outcome:
    // `ensure_canonical_expected_outcome` requires a completed execution.
    canonical_task_outcomes: done ? [OUTCOME] : [],
    canonical_outcome_observations: [],
    operational_sources: [],
    operational_raw_inputs: [],
    operational_normalized_events: [],
    workspace_memberships: [{ workspace_id: WORKSPACE, user_id: ACTOR, role: "owner" }],
  };
}

const WORLDS: Record<"before" | "after", Record<string, Row[]>> = {
  before: world("before"),
  after: world("after"),
};

const ASSURANCE: Row = { openRecommendations: 0, asOf: AS_OF, openRecommendationIds: [] };

/**
 * Which world each TABLE is read from.
 *
 * This is the whole point of the harness. A snapshot assignment per table is exactly one
 * legal interleaving of independent statements around a single commit: every read of
 * `canonical_task_outcomes` happened before it, every read of `internal_task_executions`
 * and `execution_tasks` after it. No single database snapshot yields this combination,
 * which is what makes it a proof about cross-statement reads rather than about the data.
 */
let SNAPSHOT: Record<string, "before" | "after"> = {};
const DEFAULT_SNAPSHOT: "before" | "after" = "after";

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

/** Filters, then order, then limit, then range — the order PostgREST applies them in. */
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
      let rows = [...(WORLDS[SNAPSHOT[table] ?? DEFAULT_SNAPSHOT][table] ?? [])];
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
    rpc: async (name: string) => {
      if (name === "get_operational_assurance_summary") return { data: ASSURANCE, error: null };
      if (name === "get_governed_execution_root") {
        /*
         * ONE statement, therefore ONE world. This is the whole repair: the membership
         * projection cannot be assembled across the commit, so there is no gap for the
         * transition to fall through. `ROOT_SNAPSHOT` is set to the adversarial choice —
         * the EARLIER world, the same instant the old Q2 read — and the Decision is named
         * from either side, because it is open in both.
         */
        return {
          data: computeGovernedExecutionRoot(WORLDS[ROOT_SNAPSHOT], WORKSPACE, PROJECT, AS_OF),
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
}

/** Which single world the membership statement is taken in. */
let ROOT_SNAPSHOT: "before" | "after" = "before";

/**
 * The OLD proof shape, evaluated over the SAME per-table interleave.
 *
 * The three-statement root is gone from the source, so this reproduces its predicates here
 * rather than asserting a claim about code that no longer exists. It is what makes W4-R3 a
 * discriminating regression instead of a comment: the union it computes is empty and every
 * result set is far below the ceiling — so the old implementation would have reported
 * `governedExecutionRootComplete = true` over a Decision it had just lost — while the
 * single-statement membership in the same run names that Decision.
 */
function legacyThreeStatementRoot(snapshot: Record<string, "before" | "after">) {
  const CEILING = 500;
  const ACTIVE_EXECUTION_STATUSES = ["queued", "running", "blocked", "failed"];
  const RESULT_PENDING_OUTCOME_STATES = ["expected", "observing"];
  const table = (name: string): Row[] => WORLDS[snapshot[name] ?? DEFAULT_SNAPSHOT][name] ?? [];

  // Q1 — an execution in a non-terminal status.
  const activeExecutions = table("internal_task_executions").filter((row) =>
    ACTIVE_EXECUTION_STATUSES.includes(String(row.status))
  );
  // Q2 — an Outcome whose result is not yet established.
  const pendingOutcomes = table("canonical_task_outcomes").filter((row) =>
    RESULT_PENDING_OUTCOME_STATES.includes(String(row.state))
  );
  // Q3 — an unexpired Action.
  const openActions = table("material_action_proposals").filter((row) => String(row.expires_at) > AS_OF);

  const actionIds = new Set<string>();
  for (const row of activeExecutions) if (row.source_action_id) actionIds.add(String(row.source_action_id));
  for (const row of pendingOutcomes) if (row.source_action_id) actionIds.add(String(row.source_action_id));
  for (const row of openActions) actionIds.add(String(row.id));

  const decisionIds = new Set<string>();
  for (const action of table("material_action_proposals")) {
    if (actionIds.has(String(action.id)) && action.source_decision_id) {
      decisionIds.add(String(action.source_decision_id));
    }
  }
  return {
    activeExecutionCount: activeExecutions.length,
    pendingOutcomeCount: pendingOutcomes.length,
    openActionCount: openActions.length,
    decisionIds: [...decisionIds],
    /** No read hit its ceiling, which is the ONLY thing the old code checked. */
    withinCeiling:
      activeExecutions.length <= CEILING && pendingOutcomes.length <= CEILING && openActions.length <= CEILING,
  };
}

async function scenario(
  snapshot: Record<string, "before" | "after">,
  rootSnapshot: "before" | "after" = "before"
) {
  SNAPSHOT = snapshot;
  ROOT_SNAPSHOT = rootSnapshot;
  const summary = await getOperationalSummary(makeClient() as never, WORKSPACE, PROJECT, ACTOR);
  const chains = buildExecutionChains(summary, NOW);
  const journey = chains
    .map((chain) => deriveDecisionJourney(chain, ACTOR))
    .find((entry) => entry.decisionId === "dec-mvcc") ?? null;
  return {
    /** What the discarded three-statement proof would have concluded from this interleave. */
    legacyThreeStatementRoot: legacyThreeStatementRoot(snapshot),
    rootComplete: summary.governedExecutionRootComplete ?? null,
    /** Membership as the single statement named it, in whichever world it was taken. */
    frozenMembershipIds:
      computeGovernedExecutionRoot(WORLDS[ROOT_SNAPSHOT], WORKSPACE, PROJECT, AS_OF).openExecutionDecisionIds,
    windowDecisionIds: (summary.decisions ?? []).map((row) => String(row.id)),
    rootDecisionIds: (summary.governedExecutionRootDecisions ?? []).map((row) => String(row.id)),
    /** Did the surface reach the Decision at all? */
    recovered: chains.some((chain) => chain.decisionId === "dec-mvcc"),
    journey: journey && { phase: journey.phase, closure: journey.closure },
  };
}

async function main() {
  const out = {
    // The counterexample: outcomes read before the commit, executions after it, with the
    // membership statement taken in the EARLIER world — the adversarial choice.
    interleaved: await scenario({ canonical_task_outcomes: "before" }, "before"),
    // The same interleave with the membership statement taken in the LATER world. The
    // Decision is open on both sides of the commit, so a single statement names it either
    // way; that is what makes the repair independent of WHEN the snapshot was taken.
    interleavedLateSnapshot: await scenario({ canonical_task_outcomes: "before" }, "after"),
    // The control: one world everywhere, which is what one statement would have seen.
    consistent: await scenario({}, "after"),
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack : error));
  process.exit(1);
});
