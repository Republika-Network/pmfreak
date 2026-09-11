/**
 * The canonical Workspace route family — ONE definition of every Workspace
 * surface's path.
 *
 * THE FAMILY
 * ----------
 * `07-route-layout-and-navigation-architecture.md` §2 names exactly three
 * Workspace-level routes, with the layout chain "Authenticated Shell →
 * Workspace":
 *
 *   /workspaces/[workspaceId]                  Workspace Home
 *   /workspaces/[workspaceId]/command-center   Workspace Command Center
 *   /workspaces/[workspaceId]/settings         Workspace Settings
 *
 * The Command Center shipped first (PR #604) and owned the only copy of the
 * `/workspaces/<id>/command-center` literal; Home and Settings arrive with this
 * slice. That is why this module exists: `command-center-paths.ts` is named for
 * one surface, and growing the whole family inside it would make the module's
 * name a lie — the same split PR #607 made between `pmo-paths.ts` and
 * `pmo-command-center-paths.ts`. `command-center-paths.ts` now CONSUMES this
 * module and keeps only what is genuinely Command-Center-specific: its legacy
 * entry point, its forwarded query keys, its own one-surface narrowing of the
 * parser, and the shell's active-state rule. ADR-PMF-068 rule 5: reverting a
 * route flip must mean reverting this module's callers, not hunting string
 * literals across the tree.
 *
 * WHY `workspaceId` IS IN THE PATH BUT IS NOT AUTHORITY
 * ----------------------------------------------------
 * Nothing here authorizes anything. A path produced by these helpers is a
 * *request* for a scope (§5 rule 1); `workspace_memberships` is the only
 * authority for whether the caller may have it, and `resolveRoutedWorkspace` is
 * the boundary that decides — it authorizes the EXACT id it is given or refuses,
 * with no fallback, because a resolver that substitutes another workspace when
 * the requested one is unusable renders workspace B's data at workspace A's
 * address. Every value returned by the parser below is therefore an
 * UNAUTHORIZED HINT.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * The singular `/workspace` is NOT a member of this family and does not become
 * one. `src/proxy.ts` quarantines it: every authenticated request to it is
 * bounced to `/command-center`, which resolves on to the Workspace Command
 * Center. It is legacy-shell compatibility, not Workspace Home, and repurposing
 * it would turn a path that currently lands on a Command Center into an entity
 * Home without moving the redirect that makes that false.
 *
 * `/workspaces` (plural, no id) is also not a member. It is the workspace
 * CHOOSER — the list of every workspace the caller belongs to — and it addresses
 * no single workspace, which is exactly what a family member must do.
 */

/**
 * Every surface in the canonical Workspace route family.
 *
 * `home` is the family's root and has no trailing segment; the other two are
 * named by their own segment. Exhaustive on purpose — the parser refuses any
 * segment that is not in this list, so `/workspaces/<id>/pmos` cannot be read as
 * a Workspace surface just because it sits one segment under a workspace id.
 */
export const WORKSPACE_SURFACES = ["home", "command-center", "settings"] as const;

export type WorkspaceSurface = (typeof WORKSPACE_SURFACES)[number];

/** The path segment each surface adds after the workspace id. `home` adds none. */
const SURFACE_SEGMENTS: Record<WorkspaceSurface, string> = {
  home: "",
  "command-center": "command-center",
  settings: "settings",
};

const SEGMENT_SURFACES = new Map<string, WorkspaceSurface>(
  WORKSPACE_SURFACES.filter((surface) => surface !== "home").map((surface) => [SURFACE_SEGMENTS[surface], surface]),
);

/**
 * The `/workspaces` navigation entry's stable identity in `NAVIGATION_HIERARCHY`.
 *
 * Declared next to the routes it belongs to so the shell's active-state rule and
 * this family cannot drift apart. It is the entry a PM is "in" while viewing
 * Workspace Home or Workspace Settings. The Workspace Command Center keeps its
 * own nav identity (`/command-center`) — that is PR #604's behaviour and is not
 * re-opened here.
 */
export const WORKSPACES_NAV_HREF = "/workspaces";

/**
 * Build a canonical Workspace surface path.
 *
 * The id is percent-encoded. A path segment is not a safe place for arbitrary
 * text: an unencoded id containing `/` would silently add segments and address a
 * different route entirely — a different workspace, a different surface, or a
 * route outside this family altogether.
 *
 * `query` exists because the Command Center carries an onboarding hand-off in
 * its search params (see `COMMAND_CENTER_FORWARDED_QUERY_KEYS`). Empty, `null`
 * and `undefined` values are DROPPED rather than serialised blank: `?error=` is
 * a screen reading a failure that never happened.
 */
export function workspaceSurfacePath(
  workspaceId: string,
  surface: WorkspaceSurface,
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  const segment = SURFACE_SEGMENTS[surface];
  const root = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const base = segment ? `${root}/${segment}` : root;
  if (!query) return base;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

export function workspaceHomePath(workspaceId: string): string {
  return workspaceSurfacePath(workspaceId, "home");
}

export function workspaceCommandCenterPath(
  workspaceId: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  return workspaceSurfacePath(workspaceId, "command-center", query);
}

export function workspaceSettingsPath(workspaceId: string): string {
  return workspaceSurfacePath(workspaceId, "settings");
}

export type CanonicalWorkspaceRoute = {
  /** A requested scope, NOT authority. Authorize before acting on it. */
  workspaceId: string;
  surface: WorkspaceSurface;
};

/**
 * Exactly the family, and nothing adjacent to it.
 *
 * The optional second segment is what distinguishes Home from the two named
 * surfaces. Anything deeper is refused rather than truncated to its prefix — so
 * `/workspaces/<id>/pmos/<id>/chat` is not a Workspace route at all, and cannot
 * be read as its own workspace-level ancestor. That matters beyond tidiness: the
 * PMO family (PR #607) nests under this one, and a parser that truncated would
 * light up Workspace navigation on every PMO surface.
 */
const CANONICAL_WORKSPACE_ROUTE_PATTERN = /^\/workspaces\/([^/]+)(?:\/([^/]+))?\/?$/;

/**
 * Recognize a canonical Workspace path and recover the id and the surface.
 *
 * The protected layout needs this because it resolves workspace context for the
 * shell and the onboarding gate BEFORE the page component runs. Without it the
 * layout answers from the preferred-workspace cookie, so a canonical link to
 * workspace B renders workspace A's navigation and evaluates A's onboarding
 * state — and an incomplete A can redirect the user away from a B they are
 * perfectly entitled to see.
 *
 * Fails closed on every ambiguity: an unknown surface segment, an empty or
 * whitespace-only id, an extra segment, or a malformed percent-escape all return
 * `null`. Refusing to guess is the point — a decoded id is used to address a
 * tenant's data, and "probably meant this" is not a property an id can have.
 */
export function parseCanonicalWorkspaceRoute(pathname: string): CanonicalWorkspaceRoute | null {
  const match = CANONICAL_WORKSPACE_ROUTE_PATTERN.exec(pathname);
  if (!match) return null;

  const segment = match[2];
  const surface = segment === undefined ? "home" : SEGMENT_SURFACES.get(segment);
  if (!surface) return null;

  try {
    const workspaceId = decodeURIComponent(match[1]);
    // Blank is not an id. The id is returned UNTRIMMED — trimming would change
    // the id, and an id is either the one that was asked for or nothing — but a
    // segment that is only whitespace names no entity and is refused here rather
    // than sent on to be compared against real rows.
    if (!workspaceId.trim()) return null;
    return { workspaceId, surface };
  } catch {
    // A malformed percent-escape is not an id.
    return null;
  }
}

/**
 * Does `pathname` belong to the canonical Workspace route family?
 *
 * Covers all three surfaces, and deliberately NOT the canonical PMO family that
 * nests beneath it — those are a different entity scope (ADR-PMF-014 Rule 1) and
 * are refused by the extra-segment rule above, not by a special case.
 */
export function isCanonicalWorkspaceRoutePath(pathname: string): boolean {
  return parseCanonicalWorkspaceRoute(pathname) !== null;
}
