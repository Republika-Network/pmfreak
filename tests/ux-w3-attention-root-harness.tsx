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

const ASSURANCE_AS_OF = "2027-01-01T00:00:00Z";

const scoped = (row: Row): Row => ({ workspace_id: WORKSPACE, project_id: PROJECT, ...row });

/** One complete governed lineage per Recommendation, so nothing is blocked for lineage
 *  reasons and the ONLY thing under test is whether the root set found the item. */
function lineageFor(id: string, createdAt: string, status: string): Row[] {
  return [
    scoped({ id: `ev-${id}`, title: `Evidence ${id}`, source_type: "email", source_reference: `mail/${id}`, fixture_state: "LIVE", freshness_state: "CURRENT", lifecycle: "RECORDED", normalized_event_id: null, evaluated_at: createdAt, created_at: createdAt }),
    scoped({ id: `sig-${id}`, evidence_item_id: `ev-${id}`, signal_type: "scope_creep", severity: "high", summary: `Finding ${id}`, rationale: `Rationale ${id}`, created_at: createdAt }),
    scoped({ id: `risk-${id}`, signal_id: `sig-${id}`, type: "risk", status: "open", rationale: `Risk rationale ${id}`, created_at: createdAt }),
    scoped({ id: `gov-${id}`, related_entity_id: `risk-${id}`, rule_key: "scope_change_requires_sponsor", authority_required: "project manager", governance_status: "decision_required", explanation: `Explanation ${id}`, created_at: createdAt }),
    // `updated_at` is NOT NULL in the schema and maintained by a BEFORE UPDATE trigger; the
    // attention snapshot predicate reads it, so a faithful fixture must carry it.
    scoped({ id: `rec-${id}`, recommendation: `Recommendation ${id}`, status, governance_event_id: `gov-${id}`, risk_issue_id: `risk-${id}`, created_at: createdAt, updated_at: createdAt }),
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
    // `asOf` and the count come from ONE statement in the real RPC; the snapshot predicate
    // freezes membership to this instant.
    __assurance: [{ openRecommendations: openCount, asOf: ASSURANCE_AS_OF }],
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

/**
 * 501 genuinely-open governed Recommendations that cross a real page boundary, with the
 * rows either side of it sharing an identical `created_at`.
 *
 * `ROW_PAGE_SIZE` is 500, so page 1 ends at index 499 and page 2 begins at 500. Every row
 * from 480 to 519 carries the SAME timestamp, so `ORDER BY created_at DESC` alone leaves
 * forty rows mutually tied across that boundary — free to come back in a different sequence
 * per request, which duplicates one and drops another. Only a total order (created_at, id)
 * makes the boundary stable.
 *
 * The ids are zero-padded so their lexicographic order is their numeric order, and the tied
 * block is therefore checkable.
 */
const TIE_TIMESTAMP = "2026-05-05T05:05:05Z";
const boundaryTables = tablesFrom(
  Array.from({ length: 501 }, (_, index) =>
    lineageFor(
      `page-${String(index).padStart(4, "0")}`,
      // The tied block spans the boundary; everything else is distinctly older, so the tied
      // rows sort together in the middle of the set rather than at one end.
      index >= 480 && index <= 519 ? TIE_TIMESTAMP : `2026-04-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      "proposed",
    ),
  ),
  501,
);

let TABLES: Record<string, Row[]> = falseClearTables;

/**
 * Models a database whose ORDER BY is NOT total.
 *
 * When set, the stub honours only the FIRST order clause and rotates rows that tie on it by
 * one position per request — which is what a real engine is free to do when the sort key is
 * not unique. Across a `range` boundary that returns one row twice and drops another. This
 * injects the hazard; it does not fabricate the outcome, and the assertions read whatever
 * the service then concludes.
 */
let UNSTABLE_TIE_ORDER = false;
let unstableRequestCount = 0;
let attentionRootRawRowsReturned = 0;

/**
 * Mutates the fixture between root pages, modelling concurrent writes during a multi-page
 * read. Fires once, after the first page of the attention-root query.
 */
let MUTATE_AFTER_FIRST_ROOT_PAGE: (() => void) | null = null;
let rootPagesServed = 0;

/** Chunk-level concurrency observation for the exact-reference readers. */
let inFlightChunkRequests = 0;
let maxObservedChunkConcurrency = 0;
let CHUNK_REQUEST_DELAY_MS = 0;
/** Table whose chunked reads should fail, to prove errors propagate out of concurrency. */
let FAIL_CHUNK_TABLE: string | null = null;

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
        const effective = UNSTABLE_TIE_ORDER ? orderBy.slice(0, 1) : orderBy;
        rows.sort((a, b) => {
          for (const { column, ascending } of effective) {
            const left = String(a[column] ?? "");
            const right = String(b[column] ?? "");
            const compared = ascending ? left.localeCompare(right) : right.localeCompare(left);
            if (compared !== 0) return compared;
          }
          return 0;
        });
        if (UNSTABLE_TIE_ORDER) {
          // Rotate each tied block by one more position on every request, exactly as an
          // engine may legally reorder rows a non-unique sort cannot separate.
          const shift = ++unstableRequestCount;
          const key = (row: Row) => String(row[effective[0].column] ?? "");
          const rotated: Row[] = [];
          for (let start = 0; start < rows.length; ) {
            let end = start;
            while (end < rows.length && key(rows[end]) === key(rows[start])) end += 1;
            const block = rows.slice(start, end);
            const offset = block.length > 1 ? shift % block.length : 0;
            rotated.push(...block.slice(offset), ...block.slice(0, offset));
            start = end;
          }
          rows = rotated;
        }
      }
      if (limit !== null) rows = rows.slice(0, limit);
      // PostgREST applies range AFTER filter+order, exactly as the service assumes.
      if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
      queries.push({ table, filters: [...filters] });
      if (table === "recommended_actions" && filters.includes("eq:status")) {
        rootPagesServed += 1;
        if (rootPagesServed === 1 && MUTATE_AFTER_FIRST_ROOT_PAGE) {
          const mutate = MUTATE_AFTER_FIRST_ROOT_PAGE;
          MUTATE_AFTER_FIRST_ROOT_PAGE = null;
          mutate();
        }
      }
      // Raw rows delivered for the governed attention root query, before any de-duplication.
      // The difference between this and the unique id count IS the page-boundary hazard.
      if (table === "recommended_actions" && filters.includes("eq:status")) {
        attentionRootRawRowsReturned += rows.length;
      }
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
      ) => {
        // Only id-filtered (chunked) reads participate in the concurrency observation; the
        // windowed queries are a single request each.
        const chunked = ins.length > 0;
        if (!chunked) return Promise.resolve(resolve()).then(onFulfilled, onRejected);
        inFlightChunkRequests += 1;
        maxObservedChunkConcurrency = Math.max(maxObservedChunkConcurrency, inFlightChunkRequests);
        return new Promise<{ data: Row[]; error: unknown }>((settle) => {
          setTimeout(() => {
            const value = FAIL_CHUNK_TABLE === table
              ? { data: [] as Row[], error: { message: `stub_chunk_failure:${table}` } }
              : resolve();
            settle(value as { data: Row[]; error: unknown });
          }, CHUNK_REQUEST_DELAY_MS);
        })
          .then((value) => { inFlightChunkRequests -= 1; return value; })
          .then(onFulfilled as never, onRejected as never);
      },
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
  attentionRootRawRowsReturned = 0;
  rootPagesServed = 0;
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

  const rootIds = (summary.governedAttentionRecommendations ?? []).map((row) => String(row.id));
  return {
    rootIds,
    attentionRootRawRowsReturned,
    uniqueRootIds: new Set(rootIds).size,
    duplicateRootIds: rootIds.length - new Set(rootIds).size,
    // The ids either side of the page boundary, in the order the projection produced them.
    boundaryOrder: rootIds.slice(0, 0).concat(
      rootIds.filter((id) => {
        const n = Number(id.replace("rec-page-", ""));
        return Number.isFinite(n) && n >= 496 && n <= 503;
      }),
    ),
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

/** Runs a scenario while a concurrent write lands between root pages. */
async function concurrentScenario(mutate: (tables: Record<string, Row[]>) => void) {
  const tables = tablesFrom(
    Array.from({ length: 501 }, (_, index) => lineageFor(`page-${String(index).padStart(4, "0")}`, `2026-04-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`, "proposed")),
    501,
  );
  MUTATE_AFTER_FIRST_ROOT_PAGE = () => mutate(tables);
  const result = await scenario(tables);
  MUTATE_AFTER_FIRST_ROOT_PAGE = null;
  return result;
}

/** A row created AFTER the assurance instant — outside the frozen snapshot. */
const insertedDuringRead = (tables: Record<string, Row[]>) => {
  for (const row of lineageFor("inserted-mid-read", "2027-06-01T00:00:00Z", "proposed")) {
    const prefix = String(row.id).split("-")[0];
    const table = { rec: "recommended_actions", ev: "evidence_items", sig: "operational_signals", risk: "risk_issue_records", gov: "governance_events" }[prefix]!;
    tables[table] = [...tables[table], { ...row, updated_at: "2027-06-01T00:00:00Z" }];
  }
};

/** A snapshot member terminalized after the assurance instant. */
const closedDuringRead = (tables: Record<string, Row[]>) => {
  tables.recommended_actions = tables.recommended_actions.map((row) =>
    String(row.id) === "rec-page-0400" ? { ...row, status: "accepted", updated_at: "2027-06-01T00:00:00Z" } : row,
  );
};

/** A non-member reopened after the assurance instant. */
const reopenedDuringRead = (tables: Record<string, Row[]>) => {
  tables.recommended_actions = [
    ...tables.recommended_actions,
    ...lineageFor("reopened-mid-read", "2026-04-01T00:00:00Z", "proposed")
      .filter((row) => String(row.id).startsWith("rec-"))
      .map((row) => ({ ...row, updated_at: "2027-06-01T00:00:00Z" })),
  ];
};

async function main() {
  const falseClear = await scenario(falseClearTables);
  const manyOpen = await scenario(manyOpenTables);
  const knownIncomplete = await scenario(skewedTables);
  const tieBoundary = await scenario(boundaryTables);
  // The same 501 open rows, read from a database whose tie ordering is unstable.
  UNSTABLE_TIE_ORDER = true;
  unstableRequestCount = 0;
  const unstableBoundary = await scenario(boundaryTables);
  UNSTABLE_TIE_ORDER = false;

  // Concurrent writes during a multi-page root read.
  const concurrentInsert = await concurrentScenario(insertedDuringRead);
  const concurrentClose = await concurrentScenario(closedDuringRead);
  const concurrentReopen = await concurrentScenario(reopenedDuringRead);

  // Bounded chunk concurrency, observed with a delayed stub so overlap is real.
  CHUNK_REQUEST_DELAY_MS = 5;
  maxObservedChunkConcurrency = 0;
  inFlightChunkRequests = 0;
  const concurrencyRun = await scenario(boundaryTables);
  const observedConcurrency = maxObservedChunkConcurrency;
  CHUNK_REQUEST_DELAY_MS = 0;

  // A failure inside one concurrent chunk must fail the whole read.
  FAIL_CHUNK_TABLE = "risk_issue_records";
  let chunkFailurePropagated = false;
  let chunkFailureMessage: string | null = null;
  try {
    await scenario(boundaryTables);
  } catch (error) {
    chunkFailurePropagated = true;
    chunkFailureMessage = error instanceof Error ? error.message : String(error);
  }
  FAIL_CHUNK_TABLE = null;
  process.stdout.write(
    JSON.stringify(
      {
        falseClear,
        manyOpen,
        knownIncomplete,
        tieBoundary: { ...tieBoundary, queueMarkup: undefined, queueText: undefined },
        unstableBoundary: { ...unstableBoundary, queueMarkup: undefined, rootIds: undefined, boundaryOrder: undefined },
        concurrency: {
          insert: { ...concurrentInsert, queueMarkup: undefined, rootIds: undefined, boundaryOrder: undefined },
          close: { ...concurrentClose, queueMarkup: undefined, rootIds: undefined, boundaryOrder: undefined },
          reopen: { ...concurrentReopen, queueMarkup: undefined, rootIds: undefined, boundaryOrder: undefined },
          observedChunkConcurrency: observedConcurrency,
          allRowsWithConcurrency: concurrencyRun.uniqueRootIds,
          duplicatesWithConcurrency: concurrencyRun.duplicateRootIds,
          completeWithConcurrency: concurrencyRun.governedAttentionComplete,
          chunkFailurePropagated,
          chunkFailureMessage,
        },
      },
      null,
      2,
    ),
  );
}

void main();
