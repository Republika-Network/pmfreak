/**
 * The canonical Project route family — ONE definition of every Project
 * surface's path.
 *
 * THE FAMILY, AND WHY IT IS ROOTED AT THE WORKSPACE
 * ------------------------------------------------
 * `07-route-layout-and-navigation-architecture.md` §2 roots every Project
 * surface under its WORKSPACE:
 *
 *   /workspaces/[workspaceId]/projects/[projectId]   Project Home
 *
 * — not under its PMO. That is not a stylistic choice. §1's rule is that a route
 * names its entity's *mandatory* structural parent, and for a project the two
 * candidate parents are not equally mandatory:
 *
 *   `projects.workspace_id`  uuid NOT NULL  (20260512160000)
 *   `projects.pmo_id`        uuid NULL      (20260828000001)
 *
 * So `/workspaces/W/pmos/M/projects/P` is not a route this app can have: it
 * would be unbuildable for every project whose `pmo_id IS NULL`, and those are
 * first-class — `03-canonical-information-architecture.md` §5.7 states it
 * outright ("Canonical structural parent is always Workspace (obligatory FK);
 * PMO/Portfolio/Program are optional primary links") and ADR-PMF-006 Rule 11
 * forbids gating a Project behind PMO creation. A PMO is ANCESTRY, which the
 * breadcrumb tells the truth about; the Workspace is PARENTAGE, which the route
 * is built from. A project that later joins or leaves a PMO does not change its
 * URL, because its `workspace_id` did not change.
 *
 * WHY `workspaceId` IS IN THE PATH BUT IS NOT AUTHORITY
 * ----------------------------------------------------
 * Nothing here authorizes anything. A path produced by these helpers is a
 * *claim* about ancestry; `projects.workspace_id` is the only authority for a
 * project's parent workspace, and `resolveRoutedProject` refuses a mismatch
 * rather than correcting it. Every value returned by the parser below is
 * therefore an UNAUTHORIZED HINT.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * The Project Command Center and the Execution Layer children (`/tasks`,
 * `/milestones`, `/risks`, `/issues`, `/dependencies`, `/stakeholders`,
 * `/documents`, `/recommendations`, `/decisions`, `/actions`, `/outcomes`,
 * `/feed`, `/memory`) are all in the ratified map, and NONE of them is in
 * `PROJECT_SURFACES` — because none of them exists yet. A surface listed here
 * becomes a link somewhere, and a link to a route with no page is a 404 wearing
 * a product's clothes. They arrive one row at a time, each with its own screen,
 * which is exactly why this module is shaped as a table over an enum rather than
 * as a home-only string builder: the next slice adds `"command-center"` to
 * `PROJECT_SURFACES` and `SURFACE_SEGMENTS` and inherits this parser, rather
 * than introducing a second regex that can disagree with this one about which
 * paths are Project routes.
 *
 * `/projects` (plural, no id) is also not a member. It is the project CHOOSER
 * and addresses no single project, which is what a family member must do. It
 * keeps its own identity as the navigation entry below.
 */

/**
 * Every surface in the canonical Project route family that EXISTS.
 *
 * `home` is the family's root and has no trailing segment. Exhaustive on
 * purpose — the parser refuses any segment that is not in this list, so
 * `/workspaces/<w>/projects/<p>/command-center` is not read as a Project route
 * until the slice that actually ships that screen adds it here.
 */
export const PROJECT_SURFACES = ["home"] as const;

export type ProjectSurface = (typeof PROJECT_SURFACES)[number];

/** The path segment each surface adds after the project id. `home` adds none. */
const SURFACE_SEGMENTS: Record<ProjectSurface, string> = {
  home: "",
};

const SEGMENT_SURFACES = new Map<string, ProjectSurface>(
  PROJECT_SURFACES.filter((surface) => surface !== "home").map((surface) => [SURFACE_SEGMENTS[surface], surface]),
);

/**
 * The `/projects` navigation entry's stable identity in `NAVIGATION_HIERARCHY`.
 *
 * Declared next to the routes it belongs to so the shell's active-state rule and
 * this family cannot drift apart. It is the entry a PM is "in" while viewing any
 * Project surface — not "Workspaces", which would otherwise win by prefix
 * because every canonical Project path nests under `/workspaces/<id>/`.
 */
export const PROJECTS_NAV_HREF = "/projects";

/**
 * Build a canonical Project surface path.
 *
 * BOTH ids are percent-encoded. A path segment is not a safe place for arbitrary
 * text: an unencoded id containing `/` would silently add segments and address a
 * different route entirely — a different project, a surface that does not exist,
 * or a route outside this family altogether.
 */
export function projectSurfacePath(workspaceId: string, projectId: string, surface: ProjectSurface): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`;
  const segment = SURFACE_SEGMENTS[surface];
  return segment ? `${base}/${segment}` : base;
}

export function projectHomePath(workspaceId: string, projectId: string): string {
  return projectSurfacePath(workspaceId, projectId, "home");
}

/**
 * The legacy Project Home entry point that this slice strangles.
 *
 * It remains routable — an old bookmark, a pasted link, a client-side
 * `router.push` after a create or a duplicate that holds only a project id — but
 * it holds no copy of the screen: it resolves the project's real workspace and
 * redirects into the canonical family (ADR-PMF-068 rule 2).
 *
 * Its children `/projects/[id]/chat`, `/projects/[id]/settings` and
 * `/projects/[id]/follow-up` are deliberately NOT listed. §2's ratified Project
 * family does not contain `chat`, `settings` or `follow-up` at all, so there is
 * no canonical destination to redirect them to; inventing one would be inventing
 * architecture. They stay exactly where they are until a slice decides what they
 * become.
 */
export function legacyProjectHomePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export type CanonicalProjectRoute = {
  /** An asserted ancestry claim, NOT authority. Authorize before acting on it. */
  workspaceId: string;
  projectId: string;
  surface: ProjectSurface;
};

/**
 * Exactly the family, and nothing adjacent to it.
 *
 * The optional third segment is what will distinguish Home from its future
 * siblings. Today every one of them is refused, because none of them is built —
 * and refusing is what stops a nav entry lighting up for a page that 404s.
 * Anything deeper is refused rather than truncated to its prefix, for the same
 * reason the Workspace and PMO parsers refuse it: a path with an extra segment
 * is not a route this app serves, and reading it as its own parent makes the
 * shell claim the user is somewhere they are not.
 */
const CANONICAL_PROJECT_ROUTE_PATTERN = /^\/workspaces\/([^/]+)\/projects\/([^/]+)(?:\/([^/]+))?\/?$/;

/**
 * Recognize a canonical Project path and recover the two ids and the surface.
 *
 * The protected layout needs this because it resolves workspace context for the
 * shell and the onboarding gate BEFORE the page component runs. Without it the
 * layout answers from the preferred-workspace cookie, so a canonical link to a
 * project in workspace B renders workspace A's navigation and evaluates A's
 * onboarding state — and an incomplete A can redirect the user away from a B
 * they are perfectly entitled to see.
 *
 * Fails closed on every ambiguity: an unknown surface segment, a blank id, an
 * extra segment, or a malformed percent-escape all return `null`. Refusing to
 * guess is the point — a decoded id is used to address a tenant's data, and
 * "probably meant this" is not a property an id can have.
 */
export function parseCanonicalProjectRoute(pathname: string): CanonicalProjectRoute | null {
  const match = CANONICAL_PROJECT_ROUTE_PATTERN.exec(pathname);
  if (!match) return null;

  const segment = match[3];
  const surface = segment === undefined ? "home" : SEGMENT_SURFACES.get(segment);
  if (!surface) return null;

  try {
    const workspaceId = decodeURIComponent(match[1]);
    const projectId = decodeURIComponent(match[2]);
    // Blank is not an id. The ids are returned UNTRIMMED — trimming would change
    // the id, and an id is either the one that was asked for or nothing — but a
    // segment that is only whitespace names no entity and is refused here rather
    // than sent on to be compared against real rows.
    if (!workspaceId.trim() || !projectId.trim()) return null;
    return { workspaceId, projectId, surface };
  } catch {
    // A malformed percent-escape is not an id.
    return null;
  }
}

/**
 * Does `pathname` belong to the canonical Project route family?
 *
 * This is the predicate the shell's active-state rule uses. Every Project
 * surface is "in Projects", not "in Workspaces", even though all of them nest
 * under `/workspaces/<id>/` — and not "in PMOs" either, however the project is
 * organised, because a project's route parent is its workspace (see the header).
 */
export function isCanonicalProjectRoutePath(pathname: string): boolean {
  return parseCanonicalProjectRoute(pathname) !== null;
}
