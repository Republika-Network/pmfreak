import type { createSupabaseServerClient } from "@/lib/supabase/server";
import type { RaidItemRow, RecommendedActionRow } from "@/lib/db/database-contract";
import { CLOSED_RAID_STATUSES } from "@/lib/pmos/pmo-command-center-rollup";

/**
 * Project Command Center — the zone grammar and the reads of Slice 1.
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
 *   2. Again in memory, by `selectProjectRaid` / `selectProjectRecommendations` /
 *      `selectSupportingRaidRecords`, which discard any row that does not belong
 *      to this exact workspace AND this exact project even if it somehow arrived
 *      — including a supporting RAID row whose id a Recommendation referenced.
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
 * Zone 2's supporting Evidence read is the one place where a row's id arrives
 * from ANOTHER table's column (`recommended_actions.raid_item_id`). It is
 * treated exactly like the routed workspace segment: a claim about ancestry, not
 * a permission. See `projectSupportingRaidQuery`.
 *
 * WHY `CLOSED_RAID_STATUSES` IS IMPORTED RATHER THAN RESTATED
 * ----------------------------------------------------------
 * "Open" must mean one thing across the product. `pmo-command-center-rollup.ts`
 * already owns that definition, copied there verbatim from the shipped PMO
 * Reports surface. A second definition here would let two Command Centers
 * disagree about the same number for the same project, which is exactly the
 * failure a shared constant prevents. It is RAID status VOCABULARY, not PMO
 * data — no PMO scope, no PMO row and no PMO query travels with it.
 *
 * It governs ZONE 1 ONLY. The supporting Evidence read deliberately does NOT
 * apply it: provenance is not attention, and a Recommendation may legitimately
 * retain lineage to a RAID item that was closed after it was written.
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
  // The LINEAGE column. Selected so Zone 2 can find the exact `raid_items` row a
  // Recommendation was derived from, and never rendered: it is an opaque uuid,
  // and `evidence_summary.raidItemId` — the producer's copy of the same value —
  // stays off screen for the same reason. See `projectSupportingRaidQuery`.
  | "raid_item_id"
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
  "id, workspace_id, project_id, raid_item_id, governance_event_id, title, description, recommended_action_type, status, confidence_score, impact_level, rationale, evidence_summary, recommended_owner, recommended_due_window, created_at";

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
   * `id IN (...)`. Present only on the SUPPORTING RAID read, which fetches a
   * known, already-scoped set of rows in ONE statement rather than one statement
   * per Recommendation. Never a user-supplied list — see
   * `projectSupportingRaidQuery`.
   */
  ids?: readonly string[];
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

/**
 * The SUPPORTING RAID read behind Zone 2's Evidence — one statement, not N.
 *
 * `08-ai-interaction-patterns.md` §2 requires each NAMED evidence input to be a
 * link into the Evidence Panel (§5), and §5 requires that panel to be reachable
 * "in exactly one interaction from wherever the claim is shown". A panel is only
 * worth reaching if it shows the RECORD — so this reads the actual `raid_items`
 * row each visible Recommendation cites through `recommended_actions.raid_item_id`,
 * rather than re-printing the `evidence_summary` snapshot the producer copied at
 * generation time and calling that the source.
 *
 * WHY THIS IS NOT `projectRaidQuery`
 * ----------------------------------
 * Zone 1 is ATTENTION REQUIRED and excludes `CLOSED_RAID_STATUSES`, because a
 * resolved risk is not something a PM must look at now. This read is PROVENANCE:
 * it answers "what record is this Recommendation based on", and a Recommendation
 * legitimately keeps its lineage to a RAID item that was closed or resolved
 * after the Recommendation was written. Excluding closed rows here would make an
 * still-proposed Recommendation's own basis silently unviewable — so
 * `excludeStatuses` is deliberately ABSENT and the panel labels the stored status
 * rather than implying the item is currently open.
 *
 * WHY THE SCOPE FILTERS ARE STILL BOTH PRESENT
 * -------------------------------------------
 * `raid_item_id` is a foreign key to `raid_items` and nothing more: the database
 * does not constrain it to a row of the SAME project, and RLS keys on
 * `workspace_memberships`, so it cannot tell project A from project B inside one
 * workspace. A referenced id is therefore a CLAIM, exactly like the routed
 * workspace segment is. The statement is constrained by all three of
 * `workspace_id`, `project_id` and `id IN (…)`, and
 * `selectSupportingRaidRecords` rejects a foreign-workspace or sibling-project
 * row a second time in memory. A row is never accepted merely because its id was
 * referenced.
 *
 * `ids` is the DEDUPLICATED set derived from rows that already passed Zone 2's
 * own scope guard (`collectSupportingRaidIds`), so nothing user-supplied reaches
 * it. `limit` is that set's size: this read must not truncate the evidence of a
 * Recommendation the zone is already showing.
 */
export function projectSupportingRaidQuery(
  workspaceId: string,
  projectId: string,
  ids: readonly string[],
): ProjectScopedQuery {
  return {
    table: "raid_items",
    columns: PROJECT_RAID_COLUMNS,
    workspaceId,
    projectId,
    ids,
    orderBy: "last_detected_at",
    limit: ids.length,
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
 * The deduplicated set of `raid_items` ids the VISIBLE Recommendations cite.
 *
 * Taken from rows that have already passed `selectProjectRecommendations`, so
 * every id here was carried by a row this workspace and this project own. Nulls
 * are dropped — `recommended_actions.raid_item_id` is nullable and a
 * Recommendation with no RAID lineage simply has no supporting record to show.
 *
 * Deduplicated because two Recommendations routinely derive from ONE RAID item
 * (`generate-recommended-actions.ts` can emit several actions per item), and
 * first-reference order is preserved so the rendered panels follow the order the
 * zone already reads in. One id, one row read, one panel.
 */
export function collectSupportingRaidIds(rows: readonly ProjectRecommendationRow[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    const id = row.raid_item_id;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Keep only supporting RAID rows owned by this exact workspace AND project AND
 * actually referenced, keyed by id.
 *
 * Three guards, all of them load-bearing:
 *
 *   - `belongsToProject` — the same guard Zone 1 uses. A foreign workspace's row
 *     and a sibling project's row are dropped even though their ids were
 *     referenced, because a foreign `raid_item_id` is a claim, not a permission.
 *   - `referenced` — a row nobody asked for cannot become somebody's evidence.
 *   - and NO status filter, deliberately. See `projectSupportingRaidQuery`: this
 *     is provenance, so a closed or resolved record is still the exact record.
 *
 * Rows are returned as a Map so the caller resolves each Recommendation by its
 * OWN id. There is no positional fallback anywhere in this file — a
 * Recommendation whose id is absent from the map gets no record, never the first
 * one, never a neighbour's.
 */
export function selectSupportingRaidRecords(
  rows: readonly ProjectRaidRow[],
  workspaceId: string,
  projectId: string,
  referencedIds: readonly string[],
): Map<string, ProjectRaidRow> {
  const referenced = new Set(referencedIds);
  const records = new Map<string, ProjectRaidRow>();
  for (const row of rows) {
    if (!belongsToProject(row, workspaceId, projectId)) continue;
    if (!referenced.has(row.id)) continue;
    records.set(row.id, row);
  }
  return records;
}

/**
 * What Zone 2 can honestly say about one Recommendation's supporting record.
 *
 * The same four-outcome vocabulary `resolveProjectPmoAncestry` uses for PMO
 * ancestry, for the same reason: "there is none", "here it is", "the scoped read
 * succeeded and it is not ours to show" and "we could not find out" are four
 * different facts, and collapsing them would let the screen state something it
 * never established.
 *
 *   none         `raid_item_id` is NULL — this Recommendation cites no RAID
 *                record, so none is claimed and no link is offered.
 *   resolved     the exact row, read and guarded.
 *   not-visible  the scoped read SUCCEEDED and this id was not in it: deleted,
 *                or belonging to another workspace or project. Reported as
 *                unavailable copy that names nothing — no ancestry, no title, no
 *                existence oracle.
 *   unavailable  the read FAILED. Nothing is known about the record, and
 *                nothing about the Recommendation itself is withheld for it.
 */
export type SupportingRaidLookup =
  | { state: "none"; record: null }
  | { state: "resolved"; record: ProjectRaidRow }
  | { state: "not-visible"; record: null }
  | { state: "unavailable"; record: null };

export function resolveSupportingRaid(
  raidItemId: string | null,
  records: ReadonlyMap<string, ProjectRaidRow> | null,
): SupportingRaidLookup {
  if (raidItemId === null) return { state: "none", record: null };
  // `null` is the failed read, distinct from an empty map, which is a successful
  // read that returned nothing.
  if (records === null) return { state: "unavailable", record: null };
  const record = records.get(raidItemId);
  return record ? { state: "resolved", record } : { state: "not-visible", record: null };
}

// ─── Item-level Evidence Panel targets ─────────────────────────────────────

/**
 * The fragment prefix every supporting-record Evidence Panel is addressed by.
 *
 * `08-ai-interaction-patterns.md` §5 requires the panel to be reachable "in
 * exactly one interaction from wherever the claim is shown". It does NOT require
 * a separate route, and this repository has none to offer: `03-canonical-
 * information-architecture.md` §5.8's Risks / Issues / Dependencies screens are
 * ratified but unbuilt, which is why `project-paths.ts` still refuses to list
 * them in `PROJECT_SURFACES`. Inventing `/risks/[id]` here would be a 404 wearing
 * a product's clothes.
 *
 * So the panel lives on the Project Command Center that already holds the claim,
 * and the claim links to it by fragment — one click, deterministic, and it lands
 * on the exact record rather than on a collection to search by hand.
 */
export const SUPPORTING_RAID_PANEL_ID_PREFIX = "recommendation-evidence-";

/**
 * A fragment-safe rendering of an id.
 *
 * Every character outside `[A-Za-z0-9-]` becomes `_<hex>_`, and `_` is itself
 * outside that set, so the escape is INJECTIVE: two different ids cannot collide
 * on one anchor and send a user to the wrong record. A uuid — which is what
 * `raid_items.id` actually is — passes through untouched.
 */
function fragmentSafeId(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, (char) => `_${char.codePointAt(0)!.toString(16)}_`);
}

/** The DOM id of one supporting record's Evidence Panel. Never rendered as copy. */
export function supportingRaidPanelId(raidItemId: string): string {
  return `${SUPPORTING_RAID_PANEL_ID_PREFIX}${fragmentSafeId(raidItemId)}`;
}

/**
 * The href a named evidence input carries.
 *
 * A same-document fragment, so the uuid exists only in the address — it is never
 * shown to a user, and it addresses nothing outside this already-authorized page.
 */
export function supportingRaidPanelHref(raidItemId: string): string {
  return `#${supportingRaidPanelId(raidItemId)}`;
}

/**
 * A stored timestamp at day precision, or `null` if it is not a timestamp.
 *
 * `raid_items.last_detected_at` is a `timestamptz`. Rendered as its UTC calendar
 * date: a stored fact shown at lower precision, never a relative phrase like
 * "2 days ago" that would be computed against the reader's clock and stop being
 * true the moment the page is cached.
 */
export function storedDetectionDate(value: string | null): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  return parsed.toISOString().slice(0, 10);
}

// ─── Zone 2 disclosure: Why → Evidence, in governed vocabulary ─────────────

/**
 * The user-facing Why and Evidence behind one RAID-derived Recommendation.
 *
 * WHY THIS IS A NARROW MAPPER AND NOT A JSON RENDERER
 * ---------------------------------------------------
 * `08-ai-interaction-patterns.md` §2 fixes the disclosure shape every rendered
 * Recommendation carries — Why → Evidence → Confidence — and is specific about
 * what each part IS:
 *
 *   Why      "the detected condition, in the same governed vocabulary the
 *             Risk/Issue it responds to uses (`02-canonical-product-language.md`),
 *             never a raw model rationalization."
 *   Evidence "an enumerated, NAMED list of inputs … never a vague 'based on
 *             project data.'"
 *
 * The first attempt at this satisfied the shape structurally and failed it
 * semantically: it walked `Object.entries()` over the two `jsonb` columns and
 * printed every scalar under its own key, spaced. That is FORMATTING AN INTERNAL
 * KEY, which is not the same act as mapping it into product language, and it put
 * the producer's machine contract on screen — `trigger:
 * "approval_dependency_detected"`, `discoveryOrigin: "project_discovery"`, and
 * the raw `raidItemId` / `sourceSignalId` uuids. None of those is governed
 * vocabulary, a named evidence input, or a fact a PM can evaluate; the uuids are
 * not even readable. A generic mapper also fails FORWARD: the day a producer adds
 * a key, that key starts rendering to users with nobody having decided it should.
 *
 * So this is an ALLOWLIST over one known producer schema, not a presentation
 * framework. Zone 2 lists exactly the ungoverned, `proposed` rows, and in this
 * repository those have exactly one writer —
 * `recommended-actions/generate-recommended-actions.ts`, persisted by
 * `materialize-recommended-actions.ts` — whose stored shape is:
 *
 *   evidence_summary  raidItemId, raidCategory, raidTitle, raidConfidenceScore,
 *                     discoveryOrigin, sourceSignalId
 *   rationale         trigger, raidCategory, riskText?, riskType?
 *
 * Of those, exactly three are facts about the PROJECT rather than about the rule
 * engine, and those three are the only ones read below:
 *
 *   raidCategory          → the governed noun (Risk / Issue / Dependency /
 *                           Assumption), the vocabulary `02-…` §"RAID" ratifies.
 *   raidTitle             → the human sentence a person or an extraction wrote
 *                           for the detected condition. `rationale.riskText` is
 *                           the SAME stored value (`riskText: item.title`) and is
 *                           read only as a fallback, never as a second line.
 *   raidConfidenceScore   → the RAID item's OWN recorded confidence, which is a
 *                           different number from `recommended_actions.
 *                           confidence_score` and is labelled as such at the
 *                           point of use.
 *
 * DELIBERATELY NOT READ, and why each stays off screen:
 *   trigger          the rule-engine enum that fired. `approval_dependency_detected`
 *                    adds no fact the stored Risk and its title do not already
 *                    state; rendering it explains PMFreak's implementation to a
 *                    PM instead of describing their project.
 *   discoveryOrigin  a constant the producer hard-codes. It classifies the
 *                    pipeline, not the project.
 *   riskType         "vendor" / "schedule", a keyword match over the title —
 *                    a derived guess, not a stored governed fact.
 *   raidItemId       an opaque uuid. See the navigability note below.
 *   sourceSignalId   an opaque uuid, and null for every project-discovery RAID
 *                    item anyway (`project-discovery/raid-materialization.ts`
 *                    writes `sourceSignalId: null`).
 *
 * NAVIGABILITY — WHERE THE NAMED INPUT LEADS
 * ------------------------------------------
 * §2 wants each named evidence input to be a link into the Evidence Panel (§5),
 * and §5 wants that panel "reachable in exactly one interaction from wherever
 * the claim is shown". §5 does NOT require a separate route, and this repository
 * has none to offer for a RAID item — verified rather than assumed:
 *
 *   - No page or API route anywhere under `src/app` addresses a `raid_items` row
 *     by id. `03-…` §5.8 lists Risks / Issues / Dependencies as required
 *     Execution Layer screens; none of them is built, which is also why
 *     `project-paths.ts` refuses to list them in `PROJECT_SURFACES`.
 *   - The shipped `/evidence?projectId=…` screen reads `project_evidence` and
 *     `project_evidence_content`. Those are UPLOADED DOCUMENTS — a different
 *     table and a different population from `raid_items`. It has no item
 *     selector, so `/evidence?projectId=P` cannot identify one RAID item and
 *     pretending it does would be a lie in a link. It stays offered, on its own
 *     line and in its own words, as the COLLECTION and never as this item.
 *   - `raid_items.source_signal_id` references `vault_operational_signals`
 *     (`20260602020000`), which has no user-facing surface at all — so it is
 *     neither shown nor linked.
 *
 * So the Evidence Panel is hosted by the authorized Project Command Center that
 * already holds the claim, and the named input links to it by fragment:
 * `supportingRaidPanelHref` → `#recommendation-evidence-<id>`. One interaction,
 * landing on the EXACT supporting record, read from `raid_items` through
 * `recommended_actions.raid_item_id` (`projectSupportingRaidQuery`) rather than
 * re-printed from the `evidence_summary` snapshot below. The uuid lives in the
 * fragment and nowhere a user reads it.
 *
 * This mapper is unchanged by that: it still NAMES the input from stored text,
 * and it still carries no id of its own. The href is composed at the point of
 * render, from the lineage column, and only when the exact record actually
 * loaded — see `resolveSupportingRaid`.
 */

/**
 * The four RAID nouns `02-canonical-product-language.md` ratifies, in the exact
 * casing a user reads them in. `raid_items.category` is CHECK-constrained to
 * these four lowercase values (`20260602020000`), so this is a translation of a
 * closed stored enum into its governed label — not a prettifier that would
 * accept whatever string arrived.
 */
export const GOVERNED_RAID_CATEGORY_LABELS = {
  risk: "Risk",
  issue: "Issue",
  dependency: "Dependency",
  assumption: "Assumption",
} as const;

type GovernedRaidCategory = keyof typeof GOVERNED_RAID_CATEGORY_LABELS;

/**
 * A stored category, or `null` if it is not one of the four ratified nouns.
 *
 * Exported because the Evidence Panel reads `raid_items.category` straight off
 * the supporting row and must translate it through this same closed map — a
 * second prettifier there could accept a value the enum does not name.
 */
export function governedRaidCategoryLabel(stored: unknown): string | null {
  if (typeof stored !== "string") return null;
  const key = stored.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(GOVERNED_RAID_CATEGORY_LABELS, key)
    ? GOVERNED_RAID_CATEGORY_LABELS[key as GovernedRaidCategory]
    : null;
}

/** Internal alias, so the two disclosure mappers below read as they did. */
const governedCategoryLabel = governedRaidCategoryLabel;

function storedObject(column: unknown): Record<string, unknown> | null {
  if (typeof column !== "object" || column === null || Array.isArray(column)) return null;
  return column as Record<string, unknown>;
}

/**
 * One NAMED key, read as human text. The key is always a literal at the call
 * site — there is no iteration over the object, so a key this module does not
 * name cannot reach a user however a producer changes.
 */
function storedText(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** One NAMED key, read as a 0–100 percentage. Anything else is "not recorded". */
function storedPercentage(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return Math.round(value);
}

/**
 * The DETECTED CONDITION this Recommendation responds to.
 *
 * `condition` is stored human text, passed through untouched — this function
 * composes no sentence, and nothing here is derived from the Recommendation's
 * own title or description, which would be synthesizing a rationale out of the
 * directive it is supposed to justify.
 *
 * `null` when no stored human-readable condition exists. The caller then renders
 * NO Why line — an absent basis is stated by omission, never by a stand-in.
 */
export type RecommendationWhyDisclosure = {
  /** The governed RAID noun, or `null` if the stored category is unrecognized. */
  category: string | null;
  /** The stored, human-written detected condition. */
  condition: string;
};

export function selectRaidRecommendationWhy(
  rationale: unknown,
  evidenceSummary: unknown,
): RecommendationWhyDisclosure | null {
  const evidence = storedObject(evidenceSummary);
  const reason = storedObject(rationale);

  // `raidTitle` and `rationale.riskText` are the same stored string written
  // twice by the producer, so this is a fallback, never a second entry.
  const condition = storedText(evidence, "raidTitle") ?? storedText(reason, "riskText");
  if (condition === null) return null;

  return {
    category: governedCategoryLabel(evidence?.raidCategory) ?? governedCategoryLabel(reason?.raidCategory),
    condition,
  };
}

/**
 * The NAMED evidence inputs behind this Recommendation.
 *
 * One input today — the RAID item the producer derived the Recommendation from,
 * named by its stored title and qualified by its governed category. It carries
 * no href OF ITS OWN: the destination is the supporting record's Evidence Panel,
 * which exists only when that record actually loaded, so the caller composes the
 * fragment from `recommended_actions.raid_item_id` and this mapper stays free of
 * identifiers — see the navigability note above.
 *
 * `detectedConfidence` is `raid_items.confidence_score` as the producer copied
 * it — the confidence that this CONDITION was correctly detected. It is NOT
 * `recommended_actions.confidence_score`, and the caller labels the two
 * differently so they cannot be read as one number.
 *
 * `null` when nothing names an input. Evidence is then omitted entirely rather
 * than degraded to "based on project data", which §2 names as the failure.
 */
export type RecommendationEvidenceInput = {
  category: string | null;
  /** The stored NAME of the input. Never an identifier. */
  name: string;
  /** The RAID item's own recorded detection confidence, 0–100, or `null`. */
  detectedConfidence: number | null;
};

export type RecommendationEvidenceDisclosure = {
  inputs: RecommendationEvidenceInput[];
  /**
   * The project's evidence COLLECTION — offered as a separate, differently
   * labelled destination, never as this input's own link.
   */
  repositoryHref: string;
};

export function selectRaidRecommendationEvidence(
  rationale: unknown,
  evidenceSummary: unknown,
  projectId: string,
): RecommendationEvidenceDisclosure | null {
  const evidence = storedObject(evidenceSummary);
  const reason = storedObject(rationale);

  const name = storedText(evidence, "raidTitle");
  if (name === null) return null;

  return {
    inputs: [
      {
        category: governedCategoryLabel(evidence?.raidCategory) ?? governedCategoryLabel(reason?.raidCategory),
        name,
        detectedConfidence: storedPercentage(evidence, "raidConfidenceScore"),
      },
    ],
    repositoryHref: projectEvidenceRepositoryPath(projectId),
  };
}

/**
 * The project's evidence repository, on the shipped `/evidence` screen.
 *
 * NOT a member of the canonical Project route family and deliberately not added
 * to `project-paths.ts`: `PROJECT_SURFACES` describes the ratified
 * `/workspaces/[w]/projects/[p]/…` family, and `/evidence` is a flat surface
 * that takes the project as a query parameter. It is linked because it EXISTS
 * and is authorized — the page sits under `(protected)` and every read behind it
 * runs `requireProjectAccess(projectId, "read")`
 * (`src/app/api/project-evidence/route.ts`) — so the project scope a user
 * arrives with is the project scope the destination enforces.
 *
 * The id is percent-encoded: it lands in a query string, and an id carrying `&`
 * or `#` would otherwise silently become a different request.
 */
export function projectEvidenceRepositoryPath(projectId: string): string {
  return `/evidence?projectId=${encodeURIComponent(projectId)}`;
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

  if (query.ids !== undefined) {
    // PostgREST `in.(a,b,…)`. ONE statement for the whole referenced set — the
    // alternative, a read per Recommendation, is the N+1 this descriptor exists
    // to make impossible. An empty set is never queried; the caller skips the
    // read entirely rather than asking for `in.()`.
    builder = builder.in("id", [...query.ids]);
  }
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
