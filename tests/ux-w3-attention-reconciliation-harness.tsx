/**
 * UX-W3 — an OLD attention root keeps its drawer and its history.
 *
 * The authoritative attention root reaches Recommendations older than every history window.
 * Two consequences follow, and both are false-absence defects of the same family the rest
 * of W3 has been closing:
 *
 *   post-decision  deciding an old root terminally removes it from the open set, and it was
 *                  never in the newest-30 Recommendation window — so the drawer the PM was
 *                  just using resolved to nothing at the moment their decision succeeded.
 *   history        `escalated` / `needs_more_evidence` write a real Decision and return the
 *                  Recommendation to `proposed`. An open root can therefore carry judgment
 *                  older than the newest-30 Decision window, and reading history from that
 *                  window alone loses it.
 *
 * Runs the REAL `getOperationalSummary` against the same faithful Data API stub, so both
 * windows truncate exactly as PostgREST would.
 *
 * Executed by `tests/ux-w3-needs-you-interaction-quality.test.mjs` through tsx.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { getOperationalSummary } from "@/lib/operational-flow/operational-flow-service";
import { deriveNeedsYou, deriveAllGovernedAttention } from "../src/modules/workspace/presentation/command-center/operational-data";
import { DetailDrawer } from "../src/modules/workspace/presentation/command-center/detail-drawer";

type Row = Record<string, unknown>;

const WORKSPACE = "ws-1";
const PROJECT = "proj-1";
const ACTOR = "actor-pm";

const ASSURANCE_AS_OF = "2027-01-01T00:00:00Z";

const scoped = (row: Row): Row => ({ workspace_id: WORKSPACE, project_id: PROJECT, ...row });

const OLD = "2026-01-01T00:00:00Z";
const NEWER = (index: number) => `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`;

/** A complete governed lineage, so nothing is blocked for lineage reasons. */
function lineageFor(id: string, createdAt: string, status: string): Row[] {
  return [
    scoped({ id: `ev-${id}`, title: `Evidence ${id}`, source_type: "email", source_reference: `mail/${id}`, evidence_hash: `sha256:${"c".repeat(64)}`, version: 3, fixture_state: "LIVE", freshness_state: "CURRENT", lifecycle: "RECORDED", evaluated_at: createdAt, created_at: createdAt }),
    scoped({ id: `sig-${id}`, evidence_item_id: `ev-${id}`, signal_type: "scope_creep", severity: "high", summary: `Finding ${id}`, rationale: `Rationale ${id}`, created_at: createdAt }),
    scoped({ id: `risk-${id}`, signal_id: `sig-${id}`, type: "risk", status: "open", rationale: `Risk rationale ${id}`, created_at: createdAt }),
    scoped({ id: `gov-${id}`, related_entity_id: `risk-${id}`, rule_key: "scope_change_requires_sponsor", authority_required: "project manager", governance_status: "decision_required", explanation: `Explanation ${id}`, created_at: createdAt }),
    scoped({ id: `rec-${id}`, recommendation: `Recommendation ${id}`, status, governance_event_id: `gov-${id}`, risk_issue_id: `risk-${id}`, created_at: createdAt, updated_at: createdAt }),
  ];
}

/** 30 newer governed Recommendations, so the history window is full and excludes rec-old. */
const NEWER_HISTORY = Array.from({ length: 30 }, (_, index) =>
  lineageFor(`new-${index}`, NEWER(index), ["accepted", "rejected", "modified"][index % 3]),
);

function tablesFrom(groups: Row[][], openCount: number, decisions: Row[], links: Row[]): Record<string, Row[]> {
  const all = groups.flat();
  const pick = (prefix: string) => all.filter((row) => String(row.id).startsWith(prefix));
  return {
    recommended_actions: pick("rec-"),
    evidence_items: pick("ev-"),
    operational_signals: pick("sig-"),
    risk_issue_records: pick("risk-"),
    governance_events: pick("gov-"),
    operational_decision_records: decisions,
    decision_evidence_links: links,
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
    __assurance: [{ openRecommendations: openCount, asOf: ASSURANCE_AS_OF }],
  };
}

// ── Scenario 1: before and after a terminal Decision on the old root ─────────

const preDecisionTables = tablesFrom([...NEWER_HISTORY, lineageFor("old", OLD, "proposed")], 1, [], []);

/** The same project a moment later: the canonical write flipped `rec-old` to `accepted` and
 *  appended a Decision. The Recommendation's own `created_at` is unchanged, so it is still
 *  outside the history window. */
const TERMINAL_DECISION = scoped({
  id: "dec-new",
  recommendation_id: "rec-old",
  governance_event_id: "gov-old",
  decision_status: "accepted",
  decision: "Recommendation accepted by an authorized reviewer.",
  rationale: "Sponsor confirmed the change in writing.",
  decided_by: "8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60",
  authority_basis: "owner workspace authority (PMFreak role mapping v1)",
  created_at: "2026-07-01T00:00:00Z",
});

const postDecisionTables = tablesFrom(
  [...NEWER_HISTORY, lineageFor("old", OLD, "accepted")],
  0,
  [TERMINAL_DECISION],
  [scoped({ decision_record_id: "dec-new", evidence_item_id: "ev-old", evidence_hash_at_decision: `sha256:${"c".repeat(64)}`, evidence_version_at_decision: "3", evidence_title_snapshot: "Evidence old", created_at: "2026-07-01T00:00:00Z" })],
);

// ── Scenario 2: an OPEN old root whose escalation predates the Decision window ─

const OLD_ESCALATION = scoped({
  id: "dec-old",
  recommendation_id: "rec-old",
  governance_event_id: "gov-old",
  decision_status: "escalated",
  decision: "Recommendation escalated by an authorized reviewer.",
  rationale: "Needs sponsor review before proceeding.",
  decided_by: "8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60",
  authority_basis: "owner workspace authority (PMFreak role mapping v1)",
  created_at: OLD,
});

/** 32 newer Decisions on OTHER Recommendations, so `dec-old` falls outside the newest-30
 *  Decision window while `rec-old` stays legitimately `proposed` (escalation reopens it). */
const NEWER_DECISIONS = Array.from({ length: 32 }, (_, index) =>
  scoped({
    id: `dec-new-${index}`,
    recommendation_id: `rec-new-${index % 30}`,
    governance_event_id: `gov-new-${index % 30}`,
    decision_status: "accepted",
    decision: "Recorded.",
    rationale: `Rationale ${index}`,
    decided_by: ACTOR,
    created_at: NEWER(index),
  }),
);

const oldHistoryTables = tablesFrom(
  [...NEWER_HISTORY, lineageFor("old", OLD, "proposed")],
  1,
  [OLD_ESCALATION, ...NEWER_DECISIONS],
  [scoped({ decision_record_id: "dec-old", evidence_item_id: "ev-old", evidence_hash_at_decision: `sha256:${"c".repeat(64)}`, evidence_version_at_decision: "3", evidence_title_snapshot: "Evidence old", created_at: OLD })],
);

/** The same escalation, ALSO inside the recent window, to prove it is not counted twice. */
const duplicateHistoryTables = tablesFrom(
  [...NEWER_HISTORY, lineageFor("old", OLD, "proposed")],
  1,
  [OLD_ESCALATION],
  [],
);

/**
 * The CODEX-P2-03 case: an old root carrying a prior `escalated` Decision that is outside
 * the recent Decision window, then terminally decided.
 *
 * It leaves the open set and survives only through reconciliation — and history rooted on
 * the open set alone would then have nothing fetching the older escalation, so the PM's own
 * earlier reasoning would vanish from a drawer that stayed open.
 */
const reconciledWithOldHistoryTables = tablesFrom(
  [...NEWER_HISTORY, lineageFor("old", OLD, "accepted")],
  0,
  [OLD_ESCALATION, TERMINAL_DECISION, ...NEWER_DECISIONS],
  [
    scoped({ decision_record_id: "dec-old", evidence_item_id: "ev-old", evidence_hash_at_decision: `sha256:${"c".repeat(64)}`, evidence_version_at_decision: "3", evidence_title_snapshot: "Evidence old", created_at: OLD }),
    scoped({ decision_record_id: "dec-new", evidence_item_id: "ev-old", evidence_hash_at_decision: `sha256:${"d".repeat(64)}`, evidence_version_at_decision: "4", evidence_title_snapshot: "Evidence old", created_at: "2026-07-01T00:00:00Z" }),
  ],
);

let TABLES: Record<string, Row[]> = preDecisionTables;

/** Exactly the query-builder surface `getOperationalSummary` uses. Naming it keeps the
 *  stub honest: a method the service starts calling fails to type rather than silently
 *  resolving to `undefined`. */
type QueryBuilder = {
  select: (columns: string) => QueryBuilder;
  eq: (column: string, value: unknown) => QueryBuilder;
  in: (column: string, values: unknown[]) => QueryBuilder;
  lte: (column: string, value: unknown) => QueryBuilder;
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

/** A faithful-enough stand-in for the PostgREST query builder: filters, then orders, then
 *  limits — in that order, which is what makes the truncation under test real. */
function makeClient() {
  const queries: Array<{ table: string; filters: string[] }> = [];

  function builder(table: string): QueryBuilder {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const notNull: string[] = [];
    const isNull: string[] = [];
    const lte: Array<[string, unknown]> = [];
    // Ordered clauses in CALL order, not a single column. A `.order(a).order(b)` chain is a
    // lexicographic sort in PostgREST, and modelling only the last column would make this
    // stub unable to see the very defect multi-column ordering exists to prevent: tied rows
    // drifting across a page boundary.
    const orderBy: Array<{ column: string; ascending: boolean }> = [];
    let limit: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    const filters: string[] = [];

    const read = (column: string, row: Row): unknown => {
      // PostgREST JSON path filters, e.g. `source_payload->>sourceActionId`.
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
      // PostgREST applies range AFTER filter+order, exactly as the service assumes.
      if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
      queries.push({ table, filters: [...filters] });
      return { data: rows, error: null };
    };

    const chain: QueryBuilder = {
      select: () => chain,
      eq: (column: string, value: unknown) => { eqs.push([column, value]); filters.push(`eq:${column}`); return chain; },
      in: (column: string, values: unknown[]) => { ins.push([column, values]); filters.push(`in:${column}`); return chain; },
      lte: (column: string, value: unknown) => { lte.push([column, value]); filters.push(`lte:${column}`); return chain; },
      is: (column: string, value: unknown) => {
        if (value !== null) throw new Error(`unsupported_stub_filter: is(${column}, ${String(value)})`);
        isNull.push(column);
        return chain;
      },
      not: (column: string, operator: string, value: unknown) => {
        // The service only ever issues `.not(col, "is", null)`. Anything else would be a
        // filter this stub does not implement, and silently ignoring it would make the
        // truncation test pass against a query it never actually modelled.
        if (operator !== "is" || value !== null) {
          throw new Error(`unsupported_stub_filter: not(${column}, ${operator}, ${String(value)})`);
        }
        notNull.push(column);
        return chain;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orderBy.push({ column, ascending: options?.ascending !== false });
        return chain;
      },
      limit: (value: number) => { limit = value; return chain; },
      range: (from: number, to: number) => { rangeFrom = from; rangeTo = to; return chain; },
      maybeSingle: async () => { const result = resolve(); return { data: result.data[0] ?? null, error: null }; },
      single: async () => { const result = resolve(); return { data: result.data[0] ?? null, error: null }; },
      // Thenable, so `await client.from(...).select(...)` resolves to the query result the
      // service expects — the same shape PostgREST returns.
      then: (
        onFulfilled: (value: { data: Row[]; error: null }) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return chain;
  }

  return {
    client: {
      from: (table: string) => builder(table),
      rpc: async (name: string) => (name === "get_operational_assurance_summary" ? { data: TABLES.__assurance?.[0] ?? {}, error: null } : { data: null, error: null }),
    },
    queries,
  };
}
const noopDecide = async () => {};
const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function summaryFor(tables: Record<string, Row[]>) {
  TABLES = tables;
  const { client } = makeClient();
  return getOperationalSummary(client as never, WORKSPACE, PROJECT, ACTOR);
}

const has = (rows: Array<Record<string, unknown>> | undefined, id: string) =>
  (rows ?? []).some((row) => String(row.id) === id);

async function snapshot(tables: Record<string, Row[]>) {
  const summary = await summaryFor(tables);
  const pending = deriveNeedsYou(summary, noopDecide);
  const all = deriveAllGovernedAttention(summary, noopDecide);
  const old = all.find((item) => item.id === "governed-rec-rec-old") ?? null;
  const drawer = old ? renderToStaticMarkup(<DetailDrawer content={old.drawer} onClose={() => {}} />) : null;
  const primary = drawer ? text(drawer.slice(0, drawer.indexOf("Evidence &amp; governance"))) : null;
  const detail = drawer ? drawer.slice(drawer.indexOf("Evidence &amp; governance")) : null;
  return {
    historyContainsOld: has(summary.recommendations, "rec-old"),
    attentionRootContainsOld: has(summary.governedAttentionRecommendations, "rec-old"),
    reconciliationContainsOld: has(summary.governedAttentionReconciliationRecommendations, "rec-old"),
    recentDecisionIds: (summary.decisions ?? []).map((row) => String(row.id)),
    attentionDecisionIds: (summary.governedAttentionDecisions ?? []).map((row) => String(row.id)),
    attentionLinkDecisionIds: (summary.governedAttentionDecisionEvidenceLinks ?? []).map((row) => String(row.decision_record_id)),
    needsYouIds: pending.map((item) => item.id),
    allGovernedIds: all.map((item) => item.id),
    oldResolvable: old !== null,
    oldRecordedDecisionIds: (old?.drawer.decisionPanel?.decisions ?? []).map((d) => d.decisionId),
    oldRecordedStatuses: (old?.drawer.decisionPanel?.decisions ?? []).map((d) => d.decisionStatus),
    oldRecordedRationales: (old?.drawer.decisionPanel?.decisions ?? []).map((d) => d.rationale),
    oldEvidenceSnapshots: (old?.drawer.decisionPanel?.decisions ?? []).map((d) => d.evidenceSnapshot),
    oldBadge: old?.badge.label ?? null,
    drawerPrimary: primary,
    drawerDetail: detail,
    drawerSubmitButtons: primary
      ? ["Accept", "Reject", "Record modification"].filter((verb) => new RegExp(`>\\s*${verb}\\s*<`).test(drawer!.slice(0, drawer!.indexOf("Evidence &amp; governance"))))
      : null,
  };
}

async function main() {
  const preDecision = await snapshot(preDecisionTables);
  const postDecision = await snapshot(postDecisionTables);
  const oldHistory = await snapshot(oldHistoryTables);
  const duplicateHistory = await snapshot(duplicateHistoryTables);
  const reconciledWithOldHistory = await snapshot(reconciledWithOldHistoryTables);
  process.stdout.write(
    JSON.stringify({ preDecision, postDecision, oldHistory, duplicateHistory, reconciledWithOldHistory }, null, 2),
  );
}

void main();
