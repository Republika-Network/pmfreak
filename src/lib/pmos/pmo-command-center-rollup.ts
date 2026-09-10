import type { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ProjectStatus } from "@/lib/db/database-contract";

/**
 * PMO Command Center rollups — the two projections of Slice 1.
 *
 * SCOPE RULE THIS MODULE ENFORCES
 * -------------------------------
 * ADR-PMF-020: "No Command Center widget may compose data outside its own
 * entity's descendant scope." For a PMO the descendant set is defined by
 * `projects.pmo_id`, the only structural PMO→child edge in the schema
 * (`programs` has no `pmo_id` and no Program↔Project FK; `portfolios` does not
 * exist). So a PMO's descendants are exactly its projects, and anything else on
 * this screen must be reached THROUGH those project ids.
 *
 * The scope is therefore enforced twice, on purpose:
 *
 *   1. In the query, by filters this module builds as data (below), so the
 *      filters are inspectable and testable rather than buried in a page.
 *   2. Again in memory, by `selectPmoProjects`/`selectPmoRaid`, which discard
 *      any row that does not belong to this PMO even if it somehow arrived.
 *
 * Belt and braces is warranted here because RLS cannot help: every policy on
 * `projects` and `raid_items` keys on workspace membership, so RLS structurally
 * cannot distinguish PMO A from PMO B inside one workspace. Workspace isolation
 * is RLS's job; PMO isolation is this module's.
 */

export type PmoProjectRow = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  icon: string | null;
  color: string | null;
  pmo_id: string | null;
};

export type PmoRaidRow = {
  project_id: string | null;
  category: string;
  status: string;
};

/**
 * A scope-carrying query description.
 *
 * Built as data so a test can assert the exact filters that will be applied,
 * without a database and without reading the page's source for the string
 * `.eq("pmo_id"`. The claim "sibling PMOs cannot enter this rollup" is then a
 * property of a pure function rather than of a grep.
 */
export type PmoScopedQuery = {
  table: "projects" | "raid_items";
  columns: string;
  /** Always present. The tenant boundary, matching what RLS will enforce anyway. */
  workspaceId: string;
  /** Exact PMO match. Present only on the projects query. */
  pmoId?: string;
  /** Restriction to this PMO's own project ids. Present only on the RAID query. */
  projectIds?: readonly string[];
};

export const PMO_PROJECT_COLUMNS = "id, name, description, status, icon, color, pmo_id";
export const PMO_RAID_COLUMNS = "project_id, category, status";

/**
 * The PMO's own projects.
 *
 * Scoped by workspace AND by exact `pmo_id`. `.eq("pmo_id", …)` never matches
 * NULL in SQL, so projects with no PMO are excluded structurally rather than by
 * a filter someone could later "simplify" away. That exclusion is deliberate:
 * ADR-PMF-003 rule 4 makes `pmo_id IS NULL` a legitimate first-class Workspace
 * state, but an unassigned project is not a descendant of ANY PMO, so it has no
 * place in a PMO's projection. It belongs to Workspace-level experiences.
 */
export function pmoProjectsQuery(workspaceId: string, pmoId: string): PmoScopedQuery {
  return { table: "projects", columns: PMO_PROJECT_COLUMNS, workspaceId, pmoId };
}

/**
 * Open RAID across the PMO's projects.
 *
 * Returns `null` when the PMO has no projects — there is nothing to ask about,
 * and an unrestricted read is exactly the workspace-wide broadening this screen
 * must not do. A caller that gets `null` reports zero without querying.
 */
export function pmoRaidQuery(workspaceId: string, projectIds: readonly string[]): PmoScopedQuery | null {
  if (projectIds.length === 0) return null;
  return { table: "raid_items", columns: PMO_RAID_COLUMNS, workspaceId, projectIds };
}

/**
 * In-memory scope guard for projects: keep only rows owned by this exact PMO.
 *
 * Drops sibling-PMO rows and unassigned (`pmo_id === null`) rows alike.
 */
export function selectPmoProjects(rows: readonly PmoProjectRow[], pmoId: string): PmoProjectRow[] {
  return rows.filter((row) => row.pmo_id !== null && row.pmo_id === pmoId);
}

/**
 * In-memory scope guard for RAID: keep only items belonging to the PMO's own
 * projects. A workspace-scoped item with no project (`project_id === null`) is
 * not a PMO descendant and is dropped.
 */
export function selectPmoRaid(rows: readonly PmoRaidRow[], projectIds: readonly string[]): PmoRaidRow[] {
  const allowed = new Set(projectIds);
  return rows.filter((row) => row.project_id !== null && allowed.has(row.project_id));
}

export type PmoProjectRollup = {
  total: number;
  active: number;
  completed: number;
  archived: number;
};

/**
 * Buckets are exactly `ProjectStatus` — `active | archived | completed` — and
 * nothing else. No health score, no derived "at risk" band: this slice reports
 * status the schema already stores, rather than inventing health semantics.
 */
export function summarizePmoProjects(projects: readonly PmoProjectRow[]): PmoProjectRollup {
  let active = 0;
  let completed = 0;
  let archived = 0;
  for (const project of projects) {
    if (project.status === "active") active += 1;
    else if (project.status === "completed") completed += 1;
    else if (project.status === "archived") archived += 1;
  }
  return { total: projects.length, active, completed, archived };
}

/**
 * Open-state semantics copied verbatim from the shipped PMO surface
 * (`/pmos/[pmoId]/reports`): an item counts as open unless it is closed or
 * resolved. `raid_items.status` is CHECK-constrained to
 * `open | monitoring | mitigated | closed`, so "resolved" cannot currently
 * occur — it is retained because the shipped precedent excludes it, and
 * quietly narrowing the rule here would make two PMO surfaces disagree about
 * the same number.
 */
export const CLOSED_RAID_STATUSES: readonly string[] = ["closed", "resolved"];

export type PmoRaidRollup = { openRisks: number; openIssues: number };

export function summarizeOpenRaid(items: readonly PmoRaidRow[]): PmoRaidRollup {
  let openRisks = 0;
  let openIssues = 0;
  for (const item of items) {
    if (CLOSED_RAID_STATUSES.includes(item.status)) continue;
    if (item.category === "risk") openRisks += 1;
    if (item.category === "issue") openIssues += 1;
  }
  return { openRisks, openIssues };
}

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Applies a `PmoScopedQuery` with the CALLER'S OWN client, so RLS applies to
 * every row read here. The privileged client used to authorize the route never
 * touches page data.
 *
 * Mechanical on purpose: it adds no scope of its own and drops none, so the
 * filters asserted against the query descriptors above are the filters that
 * actually reach the database.
 */
export async function runPmoScopedQuery<T>(
  client: ServerClient,
  query: PmoScopedQuery,
): Promise<{ data: T[] | null; error: { message: string } | null }> {
  let builder = client.from(query.table).select(query.columns).eq("workspace_id", query.workspaceId);
  if (query.pmoId !== undefined) builder = builder.eq("pmo_id", query.pmoId);
  if (query.projectIds !== undefined) builder = builder.in("project_id", [...query.projectIds]);
  const { data, error } = await builder;
  return { data: (data as T[] | null) ?? null, error: error ? { message: error.message } : null };
}
