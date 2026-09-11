import type { createSupabaseServerClient } from "@/lib/supabase/server";
import type { RaidItemRow, RecommendedActionRow } from "@/lib/db/database-contract";
import { CLOSED_RAID_STATUSES } from "@/lib/pmos/pmo-command-center-rollup";

/**
 * Project Command Center — the zone grammar and the three reads of Slice 1.
 *
 * SCOPE RULE THIS MODULE ENFORCES
 * -------------------------------
 * ADR-PMF-020: "No Command Center widget may compose data outside its own
 * entity's descendant scope." A Project is a LEAF of the ratified hierarchy — it
 * has no descendant entities — so a Project Command Center composes the
 * project's OWN records and nothing else. There is no rollup here, and there is
 * deliberately no workspace-wide read of any kind: no PMO portfolio, no sibling
 * project, no cross-project aggregate. That is the exact defect PR1 §11 found on
 * the old `/command-center` and the reason `03-screen-catalog.md` §13 states the
 * rule as a checkable property of every widget's query.
 *
 * The scope is enforced TWICE, on purpose:
 *
 *   1. In the query, by filters this module builds as DATA (the descriptors
 *      below), so the filters are inspectable and testable rather than buried in
 *      a page.
 *   2. Again in memory, by `selectProjectRaid` / `selectProjectRecommendations`,
 *      which discard any row that does not belong to this exact workspace AND
 *      this exact project even if it somehow arrived.
 *
 * Belt and braces is not decoration here, it is the only available defence.
 * There is NO `project_members` table anywhere in the schema and every relevant
 * RLS policy keys on `workspace_memberships` — so RLS structurally cannot tell
 * project A from project B inside one workspace. Workspace isolation is RLS's
 * job; PROJECT isolation is this module's. (The same reasoning
 * `pmo-command-center-rollup.ts` records for PMO scope.)
 *
 * WHAT IS DELIBERATELY NOT IMPORTED
 * ---------------------------------
 * `@/modules/workspace`, `@/features/command-center`, `@/lib/command-center` and
 * `@/lib/operational-command-center` are all absent, and must stay absent:
 *
 *   - the first two are the WORKSPACE Command Center screen, whose whole shape is
 *     a project PICKER over a workspace's project list;
 *   - `@/lib/command-center` holds the `command_center_type` TENANT taxonomy — a
 *     property of a `workspaces` row, not a screen concept (ADR-PMF-007 rule 4);
 *   - `@/lib/operational-command-center` is a backend engine that no UI may
 *     import (`command-center-frontend-module-boundary.md` §6 rule 3), and its
 *     `operational_command_centers` table is dormant, not FK-constrained to
 *     `projects`, and never a Project identity.
 *
 * WHY `CLOSED_RAID_STATUSES` IS IMPORTED RATHER THAN RESTATED
 * ----------------------------------------------------------
 * "Open" must mean one thing across the product. `pmo-command-center-rollup.ts`
 * already owns that definition, copied there verbatim from the shipped PMO
 * Reports surface. A second definition here would let two Command Centers
 * disagree about the same number for the same project, which is exactly the
 * failure a shared constant prevents. It is RAID status VOCABULARY, not PMO
 * data — no PMO scope, no PMO row and no PMO query travels with it.
 */

// ─── Zone grammar ──────────────────────────────────────────────────────────

/**
 * The four zones, in the one order ADR-PMF-070 fixes, with the names
 * `08-command-center-experience.md` §1 gives them.
 *
 * This is a STRUCTURAL contract, not a list of things to render when there is
 * data for them. ADR-PMF-070 Frontend Rule 2: "zone *presence* is structural,
 * zone *population* is data-dependent" — a zone whose source returns nothing
 * renders its Empty state and a zone whose source fails renders its Degraded
 * state, but neither is ever omitted. Execution Health is last, "never the first
 * or largest zone" (§1).
 *
 * Declared as data, and exported, so the order is assertable without rendering
 * and so the screen cannot quietly grow a fifth zone: the four-zone order is
 * identical across all six Command Centers precisely so a user relearns nothing
 * at an entity boundary.
 */
export const PROJECT_COMMAND_CENTER_ZONES = [
  { key: "attention-required", title: "Attention Required" },
  { key: "ai-recommendations", title: "AI Recommendations" },
  { key: "pending-decisions", title: "Pending Decisions" },
  { key: "execution-health", title: "Execution Health" },
] as const;

export type ProjectCommandCenterZoneKey = (typeof PROJECT_COMMAND_CENTER_ZONES)[number]["key"];

// ─── Row shapes ────────────────────────────────────────────────────────────
//
// Narrowed from the database contract with `Pick`, never re-declared. A column
// renamed in the schema then fails the build here instead of silently selecting
// nothing at runtime, and the SELECT lists below are derived from the same keys.

export type ProjectRaidRow = Pick<
  RaidItemRow,
  | "id"
  | "workspace_id"
  | "project_id"
  | "category"
  | "title"
  | "description"
  | "status"
  | "confidence_score"
  | "occurrence_count"
  | "auto_generated"
  | "last_detected_at"
>;

export type ProjectRecommendationRow = Pick<
  RecommendedActionRow,
  | "id"
  | "workspace_id"
  | "project_id"
  | "governance_event_id"
  | "title"
  | "description"
  | "recommended_action_type"
  | "status"
  | "confidence_score"
  | "impact_level"
  | "rationale"
  | "evidence_summary"
  | "recommended_owner"
  | "recommended_due_window"
  | "created_at"
>;

export const PROJECT_RAID_COLUMNS =
  "id, workspace_id, project_id, category, title, description, status, confidence_score, occurrence_count, auto_generated, last_detected_at";

export const PROJECT_RECOMMENDATION_COLUMNS =
  "id, workspace_id, project_id, governance_event_id, title, description, recommended_action_type, status, confidence_score, impact_level, rationale, evidence_summary, recommended_owner, recommended_due_window, created_at";

/**
 * The one status a Recommendation must be in to appear in Zone 2 or Zone 3.
 *
 * `recommended_actions.status` is CHECK-constrained to
 * `proposed | accepted | rejected | deferred | converted_to_task`. Only
 * `proposed` is undecided; every other value is a recorded outcome and belongs
 * to history, not to a queue that says something still needs a human.
 */
export const PROPOSED_RECOMMENDATION_STATUS = "proposed";

/** How many rows of any one zone are rendered before "+N more". */
export const ZONE_ROW_LIMIT = 8;

// ─── Scope-carrying query descriptors ──────────────────────────────────────

/**
 * A scope-carrying query description.
 *
 * Built as data so a test can assert the exact filters that will be applied,
 * without a database and without reading the page's source for the string
 * `.eq("project_id"`. The claim "a sibling project cannot enter this zone" is
 * then a property of a pure function rather than of a grep.
 */
export type ProjectScopedQuery = {
  table: "raid_items" | "recommended_actions";
  columns: string;
  /** Always present. The tenant boundary, matching what RLS will enforce anyway. */
  workspaceId: string;
  /** Always present. The boundary RLS CANNOT enforce. */
  projectId: string;
  /** `status NOT IN (...)`. Present only on the RAID query. */
  excludeStatuses?: readonly string[];
  /** `status = ...`. Present only on the Recommendation queries. */
  status?: string;
  /**
   * `governance_event_id IS NOT NULL` (true) or `IS NULL` (false). Present only
   * on the Recommendation queries, and it is the WHOLE distinction between
   * Zone 2 and Zone 3 — see `projectPendingDecisionsQuery`.
   */
  governed?: boolean;
  /** Ordering column. Recency only — see the note on each builder. */
  orderBy: string;
  limit: number;
};

/**
 * Zone 1 — open RAID belonging to this exact project.
 *
 * WHAT THE ORDER IS, AND WHAT IT IS NOT
 * -------------------------------------
 * `last_detected_at` descending, with `id` ascending as a deterministic
 * tiebreak. That is PRESENTATION ORDER — most recently detected first — and it
 * is not, and must not be read as, governed priority.
 *
 * `08-command-center-experience.md` §1 describes Attention Required as items
 * "whose severity crosses the entity's governed threshold, ranked by severity
 * then recency". Slice 1 cannot implement that half of the sentence honestly:
 * `raid_items` HAS NO SEVERITY COLUMN (its columns are category, status,
 * confidence_score, occurrence_count, due_date, owner), and no ratified Project
 * severity threshold exists anywhere in the architecture. Deriving a severity
 * from `category`, `confidence_score` or `occurrence_count` would be inventing
 * a governed semantic under cover of a sort order, so none of them is used for
 * ranking and no copy on this screen claims a threshold was applied. Recorded as
 * a known conformance gap rather than papered over.
 *
 * `.eq("project_id", P)` never matches NULL in SQL, so workspace-scoped RAID
 * (`raid_items.project_id` is NULL-able and rows with no project genuinely
 * exist) is excluded structurally rather than by a filter someone could later
 * "simplify" away. The in-memory guard rejects it a second time.
 */
export function projectRaidQuery(workspaceId: string, projectId: string): ProjectScopedQuery {
  return {
    table: "raid_items",
    columns: PROJECT_RAID_COLUMNS,
    workspaceId,
    projectId,
    excludeStatuses: CLOSED_RAID_STATUSES,
    orderBy: "last_detected_at",
    limit: ZONE_ROW_LIMIT,
  };
}

/**
 * Zone 2 — AI Recommendations: UNGOVERNED proposed Recommendations.
 *
 * `governance_event_id IS NULL` is the repository's own marker for a
 * RAID-derived suggestion that carries no governance event behind it. These are
 * decided through `PATCH /api/recommended-actions/decision`, and the `20260611000000`
 * RLS policies let a project writer update them directly
 * (`with check (governance_event_id is null and can_write_operational_project(...))`).
 *
 * That is what makes them CONTENT TO EVALUATE in ADR-PMF-070's sense, as opposed
 * to the governed rows in Zone 3.
 *
 * Ordered by `created_at` descending. Recency, again, not priority: the shipped
 * `/api/recommended-actions` route orders by `confidence_score` first, and
 * borrowing that here would present a confidence number as a ranking on a screen
 * whose whole job is to say what needs attention. Slice 1 renders the confidence
 * as disclosure and sorts by nothing but time.
 */
export function projectRecommendationsQuery(workspaceId: string, projectId: string): ProjectScopedQuery {
  return {
    table: "recommended_actions",
    columns: PROJECT_RECOMMENDATION_COLUMNS,
    workspaceId,
    projectId,
    status: PROPOSED_RECOMMENDATION_STATUS,
    governed: false,
    orderBy: "created_at",
    limit: ZONE_ROW_LIMIT,
  };
}

/**
 * Zone 3 — Pending Decisions: GOVERNED proposed Recommendations.
 *
 * `governance_event_id IS NOT NULL` means the row was materialized by the
 * governed chain (`materialize_operational_chain`) and is bound to a
 * `governance_events` row for the SAME workspace and project — enforced by a
 * database trigger, not by convention (`20260611000000`, the
 * `recommended_actions INSERT` guard). A client cannot write these rows at all:
 * the RLS INSERT/UPDATE policies require `governance_event_id is null`. The only
 * way one leaves `proposed` is `record_operational_decision`, which writes an
 * `operational_decision_records` row.
 *
 * So "awaiting the human approval the architecture requires" is a STRUCTURAL
 * property of this set, not a presentational label — which is the repository
 * evidence for ADR-PMF-070's insistence that Pending Decisions and AI
 * Recommendations are different zones rather than one merged list.
 *
 * The two sets are disjoint by construction: `governed` inverts the same
 * predicate on the same column, and every `recommended_actions` row has
 * `governance_event_id` either NULL or NOT NULL. `selectProjectRecommendations`
 * re-checks it in memory so the disjointness is provable without a database.
 */
export function projectPendingDecisionsQuery(workspaceId: string, projectId: string): ProjectScopedQuery {
  return {
    table: "recommended_actions",
    columns: PROJECT_RECOMMENDATION_COLUMNS,
    workspaceId,
    projectId,
    status: PROPOSED_RECOMMENDATION_STATUS,
    governed: true,
    orderBy: "created_at",
    limit: ZONE_ROW_LIMIT,
  };
}

// ─── In-memory scope guards ────────────────────────────────────────────────

function belongsToProject(row: { workspace_id: string; project_id: string | null }, workspaceId: string, projectId: string): boolean {
  return row.project_id !== null && row.project_id === projectId && row.workspace_id === workspaceId;
}

/**
 * Keep only open RAID owned by this exact workspace AND project.
 *
 * Drops, in one pass: a foreign workspace's row, a sibling project's row, a
 * workspace-scoped row with no project (`project_id === null`), and anything
 * whose status is closed per the SHARED `CLOSED_RAID_STATUSES`.
 */
export function selectProjectRaid(
  rows: readonly ProjectRaidRow[],
  workspaceId: string,
  projectId: string,
): ProjectRaidRow[] {
  return rows.filter(
    (row) => belongsToProject(row, workspaceId, projectId) && !CLOSED_RAID_STATUSES.includes(row.status),
  );
}

/**
 * Keep only proposed Recommendations owned by this exact workspace AND project,
 * on the requested side of the governed/ungoverned split.
 *
 * The `governed` check is what makes Zone 2 and Zone 3 provably disjoint over
 * any input, including one where the database returned rows the query should
 * have excluded.
 */
export function selectProjectRecommendations(
  rows: readonly ProjectRecommendationRow[],
  workspaceId: string,
  projectId: string,
  governed: boolean,
): ProjectRecommendationRow[] {
  return rows.filter(
    (row) =>
      belongsToProject(row, workspaceId, projectId) &&
      row.status === PROPOSED_RECOMMENDATION_STATUS &&
      (row.governance_event_id !== null) === governed,
  );
}

/**
 * The stored "Why" and "Evidence" behind one Recommendation, read out verbatim.
 *
 * `08-ai-interaction-patterns.md` §2 fixes the disclosure shape every rendered
 * Recommendation carries — Why → Evidence → Confidence — and states plainly that
 * "a Recommendation rendered as a bare directive ('AI says: do X') is a defect,
 * not a simplification: an unexplained directive cannot be evaluated". Zone 2
 * selected the directive and the confidence and dropped the two stored columns
 * that answer WHY, which left a PM with a suggestion and no basis on which to
 * agree or disagree with it.
 *
 * `recommended_actions.rationale` and `recommended_actions.evidence_summary` are
 * both `jsonb`, written by the two producers that create these rows:
 * `generate-recommended-actions.ts` for the ungoverned, RAID-derived rows Zone 2
 * lists, and `materialize_operational_chain` for the governed ones. Neither
 * stores prose — they store named, machine-written keys — so this function
 * READS THEM OUT and does nothing else:
 *
 *   - only own keys whose stored value is a string, a finite number or a boolean
 *     become entries. A nested object or array is dropped rather than flattened,
 *     summarized or serialized into a sentence, because a summary of stored
 *     evidence is a new claim and this zone is not allowed to make one.
 *   - values are passed through untouched (a string only trimmed), so nothing a
 *     PM reads here was composed by this screen.
 *   - a key's LABEL is the stored key with its word boundaries spaced. That is
 *     formatting of a stored name, not a description of it.
 *   - a null column, a non-object, or an object with no readable value yields an
 *     EMPTY list, and the caller omits the line entirely. Nothing is substituted
 *     for absent disclosure and nothing is derived from the recommendation's own
 *     title or description — synthesizing a rationale out of the directive it is
 *     supposed to justify would be the exact fabrication §2 forbids.
 */
export type RecommendationDisclosureEntry = { label: string; value: string };

/** A stored key, spaced at its word boundaries. Formatting only — no renaming. */
function labelForStoredKey(key: string): string {
  const spaced = key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function selectRecommendationDisclosure(stored: unknown): RecommendationDisclosureEntry[] {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return [];
  const entries: RecommendationDisclosureEntry[] = [];
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) entries.push({ label: labelForStoredKey(key), value: trimmed });
    } else if (typeof value === "number" && Number.isFinite(value)) {
      entries.push({ label: labelForStoredKey(key), value: String(value) });
    } else if (typeof value === "boolean") {
      entries.push({ label: labelForStoredKey(key), value: String(value) });
    }
  }
  return entries;
}

/**
 * Counts per RAID category, for the visible-scope summary line.
 *
 * `raid_items.category` is CHECK-constrained to
 * `risk | assumption | issue | dependency`, so these are four stored facts
 * counted, never a derived band. Deliberately NOT a severity, a score, or a
 * priority — see `projectRaidQuery`.
 */
export type ProjectRaidCategoryCounts = { risk: number; issue: number; dependency: number; assumption: number };

export function countRaidByCategory(rows: readonly ProjectRaidRow[]): ProjectRaidCategoryCounts {
  const counts: ProjectRaidCategoryCounts = { risk: 0, issue: 0, dependency: 0, assumption: 0 };
  for (const row of rows) {
    if (row.category === "risk") counts.risk += 1;
    else if (row.category === "issue") counts.issue += 1;
    else if (row.category === "dependency") counts.dependency += 1;
    else if (row.category === "assumption") counts.assumption += 1;
  }
  return counts;
}

/**
 * The total this zone may CLAIM, given what the database returned and what the
 * guard kept.
 *
 * `total` comes from the same statement as the rows (`count: "exact"`), so it is
 * the true size of the scoped result rather than a second read taken at a
 * different instant — that is what makes "+N more" truthful instead of merely
 * plausible.
 *
 * But it is the size of the result the DATABASE produced. If the in-memory guard
 * rejected anything, the two no longer describe the same population, and the
 * honest answer is to state no total at all rather than a number that disagrees
 * with the list beneath it. With the filters above that can only happen if the
 * query stopped matching the guard — which is precisely the regression the guard
 * exists to catch, and it should surface as a missing count, never as a wrong one.
 */
export function resolveVisibleTotal(returnedCount: number, keptCount: number, total: number | null): number | null {
  if (total === null) return null;
  if (returnedCount !== keptCount) return null;
  return total;
}

// ─── Execution Health facts ────────────────────────────────────────────────

/**
 * The Execution Health facts Slice 1 is willing to state, read from
 * `get_operational_assurance_summary(workspace, project)`.
 *
 * WHY THESE THREE AND NOTHING ELSE
 * --------------------------------
 * The RPC computes eight numbers in one statement. Slice 1 renders the two
 * whose meaning can be stated exactly to a PM in one line, and omits the rest:
 *
 *   totalGovernanceEvents  → "Governance events recorded"      ✓ counted rows
 *   violationsCount        → "Governance violations recorded"  ✓ governance_status='violation'
 *
 *   decisionRequiredCount  OMITTED — and this is the correction PR #610's review
 *                          asked for. It counts `governance_events` rows whose
 *                          `governance_status = 'decision_required'`, which is the
 *                          CLASSIFICATION THE EVENT WAS RAISED UNDER and stays
 *                          that way forever: `record_operational_decision` writes
 *                          an `operational_decision_records` row and moves
 *                          `recommended_actions.status` off `proposed`, and it
 *                          never rewrites `governance_events.governance_status`.
 *                          So the number does not fall when the decision is made,
 *                          and any copy calling it awaiting, pending, needed or
 *                          required-now is false the moment a PM acts. Zone 3 is
 *                          the authoritative CURRENT population — proposed
 *                          recommendations with a governance event, for this
 *                          workspace and project — and it is counted there, from
 *                          its own statement. Restating a historical
 *                          classification beside it under a second label would
 *                          put two contradicting "decisions outstanding" numbers
 *                          on one screen, so Execution Health states the facts it
 *                          can state exactly and leaves the queue to Zone 3.
 *   openRecommendations    OMITTED — it is Zone 3's population exactly, and
 *                          Zone 3 already counts it from its own statement.
 *                          Printing the same number twice from two different
 *                          reads invites them to disagree on screen.
 *   unresolvedRisksIssues  OMITTED — it counts `risk_issue_records`, the GOVERNED
 *                          RAID lineage, which is a different table and a
 *                          different population from the `raid_items` Zone 1
 *                          lists. Both are true; shown side by side without a
 *                          provenance explanation this slice has no room for,
 *                          they read as one number contradicting another.
 *   evidenceLinkedDecisionsCount, evidenceWithoutSignalCount, incompleteChainCount
 *                          OMITTED — pipeline-internal completeness metrics. They
 *                          are real, but "evidence without a signal" is not a
 *                          sentence about a project's execution that a PM can act
 *                          on, and labelling it loosely would be the fabrication
 *                          this zone exists to avoid.
 *
 * NO COMPOSITE SCORE, NO BAND. There is no health percentage, no red/yellow/green,
 * no "on track", no "at risk" and no "monitoring" here. The only health-shaped
 * number the repository could offer is `detectedRaidOverview.healthScore`, which
 * is `100 − risks×8 − issues×10 − dependencies×5 − criticalRisks×7`
 * (`src/lib/raid/extraction.ts`) — an arithmetic invention with no ratified
 * domain meaning — and the shipped PMO Command Center refused exactly this
 * ("No health score, no derived 'at risk' band"). The zone keeps its ratified
 * NAME (ADR-PMF-070 fixes the four zone names) and reports facts under it.
 */
export type ProjectGovernanceFacts = {
  totalGovernanceEvents: number;
  violationsCount: number;
};

function readCount(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parse the assurance payload, AND verify it is about the project we asked
 * about.
 *
 * The RPC echoes `scope`, `workspaceId` and `projectId` back in its result. That
 * echo is a free third scope guard on the one read in this module that does not
 * go through a `ProjectScopedQuery` descriptor, so it is checked rather than
 * ignored: a payload describing another project is discarded exactly as a
 * sibling project's row would be.
 *
 * Returns `null` — "we do not have these facts" — rather than zeroes, for a
 * malformed payload, a mismatched scope, or a database that predates the RPC. A
 * failed read is NEVER rendered as a zero; a successful zero is a real zero.
 */
export function selectProjectGovernanceFacts(
  payload: unknown,
  workspaceId: string,
  projectId: string,
): ProjectGovernanceFacts | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;

  if (record.scope !== "project") return null;
  if (record.workspaceId !== workspaceId) return null;
  if (record.projectId !== projectId) return null;

  const totalGovernanceEvents = readCount(record, "totalGovernanceEvents");
  const violationsCount = readCount(record, "violationsCount");

  if (totalGovernanceEvents === null || violationsCount === null) return null;
  return { totalGovernanceEvents, violationsCount };
}

// ─── Execution ─────────────────────────────────────────────────────────────

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type ProjectScopedQueryResult<T> = {
  data: T[] | null;
  /** Size of the FULL scoped result, from the same statement as `data`. */
  total: number | null;
  error: { message: string } | null;
};

/**
 * Applies a `ProjectScopedQuery` with the CALLER'S OWN client, so RLS applies to
 * every row read here. The privileged client used to authorize the route never
 * touches page data.
 *
 * Mechanical on purpose: it adds no scope of its own and drops none, so the
 * filters asserted against the descriptors above are the filters that actually
 * reach the database.
 *
 * `count: "exact"` rides along on the SAME request as the rows, so the total and
 * the page of rows describe one snapshot. Two statements would be two snapshots,
 * and a row committed between them would make the headline count disagree with
 * the list under it — the precise failure "+N more" is otherwise prone to.
 *
 * Ordering is always `<orderBy> DESC, id ASC`. The `id` tiebreak is what makes a
 * capped list deterministic: without it, two rows sharing a timestamp can swap
 * places between reads and the "+N more" boundary moves for no reason.
 *
 * Never throws for a query error — a failed read is a value (`error`) so the
 * calling zone can degrade on its own while its three siblings render.
 */
export async function runProjectScopedQuery<T>(
  client: ServerClient,
  query: ProjectScopedQuery,
): Promise<ProjectScopedQueryResult<T>> {
  let builder = client
    .from(query.table)
    .select(query.columns, { count: "exact" })
    .eq("workspace_id", query.workspaceId)
    .eq("project_id", query.projectId);

  if (query.status !== undefined) builder = builder.eq("status", query.status);
  if (query.governed !== undefined) {
    builder = query.governed
      ? builder.not("governance_event_id", "is", null)
      : builder.is("governance_event_id", null);
  }
  if (query.excludeStatuses !== undefined) {
    // PostgREST `not.in.(a,b)`. The values come from a compile-time constant of
    // plain lowercase identifiers, never from a request, so there is nothing here
    // to quote or escape.
    builder = builder.not("status", "in", `(${query.excludeStatuses.join(",")})`);
  }

  const { data, count, error } = await builder
    .order(query.orderBy, { ascending: false })
    .order("id", { ascending: true })
    .limit(query.limit);

  return {
    data: (data as T[] | null) ?? null,
    total: typeof count === "number" ? count : null,
    error: error ? { message: error.message } : null,
  };
}
