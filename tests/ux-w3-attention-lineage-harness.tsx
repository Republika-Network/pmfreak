/**
 * UX-W3 — the attention surface must not read a truncated window as canonical absence.
 *
 * `getOperationalSummary` windows each collection independently: evidence to the newest 20,
 * signals / risks / governance / recommendations to the newest 30. A governed Recommendation
 * can therefore sit inside its own window while the Evidence it links is older than the
 * newest 20 — and W3 was deciding "the evidence is missing, the decision would be refused"
 * from exactly that. `record_operational_decision` resolves the lineage by exact id and
 * would have accepted the write.
 *
 * The same truncation could silently rewrite AUTHORITY: `actor_authority` was derived from
 * the windowed governance map and fell back to "baseline review" whenever the linked
 * Governance Event was merely out of window, changing which decisions the surface offered.
 *
 * This harness runs the REAL `getOperationalSummary` against the same faithful Data API stub
 * P2-12 uses — filters, then order, then limit, exactly as PostgREST does, so the truncation
 * is real rather than simulated — and then the REAL attention read model, grouping and
 * renderer on top of its output.
 *
 * Executed by `tests/ux-w3-needs-you-interaction-quality.test.mjs` through tsx.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { getOperationalSummary } from "@/lib/operational-flow/operational-flow-service";
import { buildCanonicalAttention, selectPendingAttention } from "../src/modules/workspace/presentation/command-center/attention-read-model";
import { deriveNeedsYou } from "../src/modules/workspace/presentation/command-center/operational-data";
import { groupAttentionItems, humanJobFor } from "../src/modules/workspace/presentation/command-center/attention-presentation";
import { DetailDrawer } from "../src/modules/workspace/presentation/command-center/detail-drawer";

type Row = Record<string, unknown>;

const WORKSPACE = "ws-1";
const PROJECT = "proj-1";
const ACTOR = "actor-pm";

/** The governed item under test: old enough that every newer row outranks it everywhere. */
const OLD = "2026-01-01T00:00:00Z";
/** Unrelated rows, all newer, in every upstream collection. */
const NEWER = (index: number) => `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`;
const NOISE = 35;

const scoped = (row: Row): Row => ({ workspace_id: WORKSPACE, project_id: PROJECT, ...row });

function noise(prefix: string, build: (index: number) => Row, column: string): Row[] {
  return Array.from({ length: NOISE }, (_, index) =>
    scoped({ id: `${prefix}-${index}`, ...build(index), [column]: NEWER(index) }),
  );
}

/** The real authority this governance rule requires. If the surface ever reads it from the
 *  truncated governance window instead, it degrades to "baseline review" and the taxonomy
 *  silently changes. */
const REQUIRED_AUTHORITY = "sponsor or PMO";

const oldEvidence = scoped({
  id: "ev-old",
  title: "Client scope request",
  source_type: "email",
  source_reference: "mail-thread/991",
  evidence_hash: "b".repeat(64),
  fixture_state: "LIVE",
  freshness_state: "CURRENT",
  lifecycle: "RECORDED",
  normalized_event_id: "ne-old",
  evaluated_at: OLD,
  created_at: OLD,
});

const oldSignal = scoped({
  id: "sig-old",
  evidence_item_id: "ev-old",
  signal_type: "scope_creep",
  severity: "critical",
  summary: "Work outside the agreed scope was requested.",
  rationale: "Deterministic rule matched an out-of-scope request without approval.",
  created_at: OLD,
});

const oldRisk = scoped({
  id: "risk-old",
  signal_id: "sig-old",
  type: "risk",
  status: "open",
  rationale: "The client requested additional scope without a formal change request.",
  created_at: OLD,
});

const oldGovernance = scoped({
  id: "gov-old",
  related_entity_id: "risk-old",
  rule_key: "scope_change_requires_sponsor",
  authority_required: REQUIRED_AUTHORITY,
  governance_status: "decision_required",
  explanation: "A scope change of this size requires sponsor authority before it proceeds.",
  created_at: OLD,
});

/** A SECOND governed Recommendation whose Risk/Signal/Evidence genuinely do not exist.
 *  Not out of window — absent. This is the case the canonical write really refuses. */
const brokenGovernance = scoped({
  id: "gov-broken",
  related_entity_id: "risk-missing",
  rule_key: "scope_change_requires_sponsor",
  authority_required: REQUIRED_AUTHORITY,
  governance_status: "decision_required",
  explanation: "A scope change of this size requires sponsor authority before it proceeds.",
  created_at: OLD,
});

const TABLES: Record<string, Row[]> = {
  // The bounded ROOT set. Both recommendations sit inside it.
  recommended_actions: [
    scoped({
      id: "rec-old",
      recommendation: "Raise a formal Change Request",
      status: "proposed",
      governance_event_id: "gov-old",
      risk_issue_id: "risk-old",
      created_at: OLD,
    }),
    scoped({
      id: "rec-broken",
      recommendation: "Assign an owner to the integration dependency",
      status: "proposed",
      governance_event_id: "gov-broken",
      risk_issue_id: "risk-missing",
      created_at: OLD,
    }),
  ],
  // Every upstream collection is flooded with newer unrelated rows, so the linked ones fall
  // outside their windows. `risk_issue_records` deliberately does NOT contain `risk-missing`.
  evidence_items: [oldEvidence, ...noise("ev", () => ({ fixture_state: "LIVE", freshness_state: "CURRENT", lifecycle: "RECORDED" }), "created_at")],
  operational_signals: [oldSignal, ...noise("sig", (i) => ({ signal_type: "schedule_risk", severity: "low", summary: `Unrelated ${i}` }), "created_at")],
  risk_issue_records: [oldRisk, ...noise("risk", () => ({ type: "risk", status: "open" }), "created_at")],
  governance_events: [oldGovernance, brokenGovernance, ...noise("gov", () => ({ governance_status: "compliant" }), "created_at")],
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
  // An owner: the real authority mapping grants every terminal status against
  // "sponsor or PMO", so authority can never be the reason an item is not decidable here.
  workspace_memberships: [{ workspace_id: WORKSPACE, user_id: ACTOR, role: "owner" }],
};

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
      rpc: async (name: string) => (name === "get_operational_assurance_summary" ? { data: {}, error: null } : { data: null, error: null }),
    },
    queries,
  };
}
const noopDecide = async () => {};
const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function main() {
  const { client } = makeClient();
  // The REAL service, against the REAL windowing.
  const summary = await getOperationalSummary(client as never, WORKSPACE, PROJECT, ACTOR);

  const attention = buildCanonicalAttention(summary);
  const pending = selectPendingAttention(attention);
  const items = deriveNeedsYou(summary, noopDecide);
  const byId = (id: string) => items.find((item) => item.id === `governed-rec-${id}`)!;

  const complete = attention.find((item) => item.recommendationId === "rec-old")!;
  const broken = attention.find((item) => item.recommendationId === "rec-broken")!;

  const drawerFor = (id: string) => renderToStaticMarkup(<DetailDrawer content={byId(id).drawer} onClose={() => {}} />);
  const primary = (markup: string) => {
    const at = markup.indexOf("Evidence &amp; governance");
    return text(at < 0 ? markup : markup.slice(0, at));
  };

  const completeDrawer = drawerFor("rec-old");
  const brokenDrawer = drawerFor("rec-broken");

  process.stdout.write(
    JSON.stringify(
      {
        requiredAuthority: REQUIRED_AUTHORITY,
        // Proof the collision is real: the linked rows are genuinely outside their windows.
        windows: {
          evidenceCount: summary.evidence.length,
          evidenceContainsLinked: summary.evidence.some((row) => String(row.id) === "ev-old"),
          signalsContainsLinked: summary.signals.some((row) => String(row.id) === "sig-old"),
          risksContainsLinked: summary.risksIssues.some((row) => String(row.id) === "risk-old"),
          governanceContainsLinked: summary.governanceEvents.some((row) => String(row.id) === "gov-old"),
          recommendationsContainsRoot: summary.recommendations.some((row) => String(row.id) === "rec-old"),
        },
        contexts: (summary.governedAttentionContexts ?? []).map((context) => ({
          recommendationId: context.recommendationId,
          lineageComplete: context.lineageComplete,
          authorityRequired: context.authorityRequired,
          hasGovernance: context.governanceEvent !== null,
          hasRisk: context.riskIssue !== null,
          hasSignal: context.signal !== null,
          hasEvidence: context.evidence !== null,
        })),
        // The authority the server projected onto each Recommendation.
        actorAuthority: summary.recommendations.map((row) => ({
          id: String(row.id),
          accepted: (row.actor_authority as Record<string, { allowed: boolean; authorityRequired: string }>)?.accepted,
        })),
        pendingIds: pending.map((item) => item.recommendationId),
        outOfWindowButComplete: {
          lineageComplete: complete.governedLineageComplete,
          evidenceMissing: complete.evidenceQuality.evidenceMissing,
          authorityRequired: complete.governance.authorityRequired,
          severity: complete.severity,
          signalSummary: complete.signalSummary,
          why: complete.why,
          evidenceTitle: complete.provenance.evidenceTitle,
          humanJob: humanJobFor(byId("rec-old")),
          blockedReason: byId("rec-old").drawer.decisionPanel?.blockedReason ?? null,
          terminalAllowed: (byId("rec-old").drawer.decisionPanel?.controls ?? []).some((c) => c.terminal && c.allowed),
          drawerPrimary: primary(completeDrawer),
          drawerMarkup: completeDrawer,
        },
        genuinelyIncomplete: {
          lineageComplete: broken.governedLineageComplete,
          evidenceMissing: broken.evidenceQuality.evidenceMissing,
          authorityRequired: broken.governance.authorityRequired,
          humanJob: humanJobFor(byId("rec-broken")),
          blockedReason: byId("rec-broken").drawer.decisionPanel?.blockedReason ?? null,
          terminalAllowed: (byId("rec-broken").drawer.decisionPanel?.controls ?? []).some((c) => c.terminal && c.allowed),
          drawerPrimary: primary(brokenDrawer),
          drawerMarkup: brokenDrawer,
        },
        grouping: groupAttentionItems(items).map((group) => ({ job: group.job, ids: group.items.map((i) => i.id) })),
      },
      null,
      2,
    ),
  );
}

void main();
