/**
 * UX-W3 — the governed attention ROOT must be the open set, not a history window.
 *
 * `getOperationalSummary` loads `recommended_actions` as a recent history window: governed,
 * newest 30, every status. Thirty newer accepted/rejected/modified Recommendations push an
 * older still-`proposed` one out of it, and an attention queue rooted on that window then
 * renders "You're clear." while a real governed decision waits. History and attention are
 * different questions.
 *
 * This harness runs the REAL `getOperationalSummary` against the same faithful Data API stub
 * P2-12 and the lineage harness use — filters, then order, then limit, then range, exactly as
 * PostgREST does — so the window that hides the open item is real rather than simulated.
 *
 * Two scenarios:
 *   falseClear   30 newer terminal Recommendations + 1 older open one, RAID empty.
 *   manyOpen     35 genuinely open Recommendations, to prove the root pages past 30.
 *
 * Executed by `tests/ux-w3-needs-you-interaction-quality.test.mjs` through tsx.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { getOperationalSummary } from "@/lib/operational-flow/operational-flow-service";
import { selectPendingAttention, buildCanonicalAttention } from "../src/modules/workspace/presentation/command-center/attention-read-model";
import { deriveNeedsYou } from "../src/modules/workspace/presentation/command-center/operational-data";
import { assessAttentionCompleteness } from "../src/modules/workspace/presentation/command-center/attention-completeness";
import { NeedsYouQueue } from "../src/modules/workspace/presentation/command-center/needs-you-queue";

type Row = Record<string, unknown>;

const WORKSPACE = "ws-1";
const PROJECT = "proj-1";
const ACTOR = "actor-pm";

const scoped = (row: Row): Row => ({ workspace_id: WORKSPACE, project_id: PROJECT, ...row });

/** One complete governed lineage per Recommendation, so nothing is blocked for lineage
 *  reasons and the ONLY thing under test is whether the root set found the item. */
function lineageFor(id: string, createdAt: string, status: string): Row[] {
  return [
    scoped({ id: `ev-${id}`, title: `Evidence ${id}`, source_type: "email", source_reference: `mail/${id}`, fixture_state: "LIVE", freshness_state: "CURRENT", lifecycle: "RECORDED", normalized_event_id: null, evaluated_at: createdAt, created_at: createdAt }),
    scoped({ id: `sig-${id}`, evidence_item_id: `ev-${id}`, signal_type: "scope_creep", severity: "high", summary: `Finding ${id}`, rationale: `Rationale ${id}`, created_at: createdAt }),
    scoped({ id: `risk-${id}`, signal_id: `sig-${id}`, type: "risk", status: "open", rationale: `Risk rationale ${id}`, created_at: createdAt }),
    scoped({ id: `gov-${id}`, related_entity_id: `risk-${id}`, rule_key: "scope_change_requires_sponsor", authority_required: "project manager", governance_status: "decision_required", explanation: `Explanation ${id}`, created_at: createdAt }),
    scoped({ id: `rec-${id}`, recommendation: `Recommendation ${id}`, status, governance_event_id: `gov-${id}`, risk_issue_id: `risk-${id}`, created_at: createdAt }),
  ];
}

const OLD = "2026-01-01T00:00:00Z";
const NEWER = (index: number) => `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`;

/** Splits the per-recommendation lineage rows back into their tables. */
function tablesFrom(groups: Row[][], openCount: number): Record<string, Row[]> {
  const all = groups.flat();
  const pick = (prefix: string) => all.filter((row) => String(row.id).startsWith(prefix));
  return {
    recommended_actions: pick("rec-"),
    evidence_items: pick("ev-"),
    operational_signals: pick("sig-"),
    risk_issue_records: pick("risk-"),
    governance_events: pick("gov-"),
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
    /** The assurance RPC's own project-wide open count, carried through the stub. */
    __assurance: [{ openRecommendations: openCount }],
  };
}

/** 30 NEWER terminal Recommendations, plus one OLDER still-open one. */
const falseClearTables = tablesFrom(
  [
    ...Array.from({ length: 30 }, (_, index) =>
      lineageFor(`new-${index}`, NEWER(index), ["accepted", "rejected", "modified"][index % 3]),
    ),
    lineageFor("old-open", OLD, "proposed"),
  ],
  1,
);

/** 35 genuinely open Recommendations — more than the history window can hold. */
const manyOpenTables = tablesFrom(
  Array.from({ length: 35 }, (_, index) => lineageFor(`open-${index}`, NEWER(index), "proposed")),
  35,
);

/**
 * 35 open Recommendations, but the assurance aggregate reports 40.
 *
 * A realistic skew — rows created between the two reads — and the only honest reading is
 * that this page does not have the whole open set. The service computes that by comparing
 * what it loaded against the project-wide count; nothing here injects an incomplete flag.
 */
const skewedTables = tablesFrom(
  Array.from({ length: 35 }, (_, index) => lineageFor(`open-${index}`, NEWER(index), "proposed")),
  40,
);

let TABLES: Record<string, Row[]> = falseClearTables;

/** Exactly the query-builder surface `getOperationalSummary` uses. Naming it keeps the
 *  stub honest: a method the service starts calling fails to type rather than silently
 *  resolving to `undefined`. */
type QueryBuilder = {
  select: (columns: string) => QueryBuilder;
  eq: (column: string, value: unknown) => QueryBuilder;
  in: (column: string, values: unknown[]) => QueryBuilder;
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
    let orderColumn: string | null = null;
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
      for (const column of notNull) rows = rows.filter((row) => read(column, row) !== null && read(column, row) !== undefined);
      for (const column of isNull) rows = rows.filter((row) => read(column, row) === null || read(column, row) === undefined);
      if (orderColumn) {
        rows.sort((a, b) => String(b[orderColumn!] ?? "").localeCompare(String(a[orderColumn!] ?? "")));
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
      order: (column: string) => { orderColumn = column; return chain; },
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

async function scenario(tables: Record<string, Row[]>) {
  TABLES = tables;
  const { client } = makeClient();
  const summary = await getOperationalSummary(client as never, WORKSPACE, PROJECT, ACTOR);

  const items = deriveNeedsYou(summary, noopDecide);
  const governedPartial = summary.governedAttentionComplete === false;
  const attention = assessAttentionCompleteness([
    { label: "governed recommendations", loading: false, failed: false, partial: governedPartial },
    { label: "suggested actions", loading: false, failed: false },
  ]);
  const total = summary.governedAttentionTotal ?? null;
  const incompleteNote =
    governedPartial && total !== null
      ? `Showing ${items.filter((item) => item.kind === "governed_recommendation").length} of ${total} governed items needing review.`
      : null;

  const queue = renderToStaticMarkup(
    <NeedsYouQueue
      variant="canvas"
      items={items}
      onSelect={() => {}}
      loading={attention.loading}
      errorMessage={null}
      incomplete={attention.partial}
      incompleteNote={incompleteNote}
      emptyStateNote={null}
    />,
  );

  return {
    // What the ordinary HISTORY window holds — the root the old implementation used.
    historicalWindowSize: summary.recommendations.length,
    historicalWindowPendingCount: summary.recommendations.filter((row) => String(row.status) === "proposed").length,
    // The authoritative project-wide aggregate.
    assuranceOpenRecommendations: summary.assurance?.openRecommendations ?? null,
    // The new attention root.
    attentionRootLoaded: (summary.governedAttentionRecommendations ?? []).length,
    attentionRootIds: (summary.governedAttentionRecommendations ?? []).map((row) => String(row.id)),
    attentionRootAllProposed: (summary.governedAttentionRecommendations ?? []).every((row) => String(row.status) === "proposed"),
    governedAttentionComplete: summary.governedAttentionComplete ?? null,
    governedAttentionTotal: total,
    // What the PM ends up seeing.
    pendingCount: selectPendingAttention(buildCanonicalAttention(summary)).length,
    needsYouCount: items.length,
    needsYouIds: items.map((item) => item.id),
    completeness: attention,
    incompleteNote,
    queueText: text(queue),
    queueMarkup: queue,
    youreClearVisible: text(queue).includes("You&#x27;re clear.") || text(queue).includes("You're clear."),
  };
}

async function main() {
  const falseClear = await scenario(falseClearTables);
  const manyOpen = await scenario(manyOpenTables);
  const knownIncomplete = await scenario(skewedTables);
  process.stdout.write(JSON.stringify({ falseClear, manyOpen, knownIncomplete }, null, 2));
}

void main();
