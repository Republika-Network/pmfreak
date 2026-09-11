/**
 * The canonical PMO route family — ONE definition of every PMO surface's path.
 *
 * THE FAMILY
 * ----------
 * `07-route-layout-and-navigation-architecture.md` §2 roots every PMO surface
 * under its workspace, because `pmos.workspace_id` is NOT NULL and §1's rule is
 * that a route names its entity's *mandatory* structural parent:
 *
 *   /workspaces/[workspaceId]/pmos/[pmoId]                  PMO Home
 *   /workspaces/[workspaceId]/pmos/[pmoId]/chat             PMO Chat
 *   /workspaces/[workspaceId]/pmos/[pmoId]/reports          PMO Reports
 *   /workspaces/[workspaceId]/pmos/[pmoId]/settings         PMO Settings
 *   /workspaces/[workspaceId]/pmos/[pmoId]/command-center   PMO Command Center
 *
 * The Command Center shipped first (PR #606) and the other four arrive with this
 * slice, which is why this module exists at all: `pmo-command-center-paths.ts`
 * was named for one surface, and growing the whole family inside it would make
 * the module's name a lie. That module now consumes this one and keeps only what
 * is genuinely Command-Center-specific (its own predicate and its breadcrumb).
 * ADR-PMF-068 rule 5: reverting a route flip must mean reverting this module's
 * callers, not hunting string literals across the tree.
 *
 * WHY `workspaceId` IS IN THE PATH BUT IS NOT AUTHORITY
 * ----------------------------------------------------
 * Nothing here authorizes anything. A path produced by these helpers is a
 * *claim* about ancestry; `pmos.workspace_id` is the only authority for a PMO's
 * parent workspace, and `resolveRoutedPmo` refuses a mismatch rather than
 * correcting it. Every value returned by the parser below is therefore an
 * UNAUTHORIZED HINT.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * `/pmo-command-center` is not a member of this family and never becomes one. It
 * is the compatibility redirect for `/pm-operations`, the internal PM-operations
 * dashboard, which takes no `pmoId` and never reads the `pmos` table. Pointing
 * it at a PMO surface would re-open the ADR-PMF-014 Rule 6 collision that the
 * rename closed. See `pmo-command-center-paths.ts` for the full argument.
 */

/**
 * Every surface in the canonical PMO route family.
 *
 * `home` is the family's root and has no trailing segment; the other four are
 * named by their own segment. Exhaustive on purpose — the parser refuses any
 * segment that is not in this list, so an unknown fifth path cannot be read as
 * a PMO surface just because it sits under `/pmos/<id>/`.
 */
export const PMO_SURFACES = ["home", "chat", "reports", "settings", "command-center"] as const;

export type PmoSurface = (typeof PMO_SURFACES)[number];

/** The path segment each surface adds after the PMO id. `home` adds none. */
const SURFACE_SEGMENTS: Record<PmoSurface, string> = {
  home: "",
  chat: "chat",
  reports: "reports",
  settings: "settings",
  "command-center": "command-center",
};

const SEGMENT_SURFACES = new Map<string, PmoSurface>(
  PMO_SURFACES.filter((surface) => surface !== "home").map((surface) => [SURFACE_SEGMENTS[surface], surface]),
);

/**
 * The `/pmos` navigation entry's stable identity in `NAVIGATION_HIERARCHY`.
 *
 * Declared next to the routes it belongs to so the shell's active-state rule and
 * this family cannot drift apart. It is the entry a PM is "in" while viewing ANY
 * PMO surface — not "Workspaces", which would otherwise win by prefix because
 * every canonical PMO path nests under `/workspaces/<id>/`.
 */
export const PMOS_NAV_HREF = "/pmos";

/**
 * Build a canonical PMO surface path.
 *
 * Both ids are percent-encoded. A path segment is not a safe place for arbitrary
 * text: an unencoded id containing `/` would silently add segments and address a
 * different route entirely — a different PMO, a different surface, or a route
 * outside this family altogether.
 */
export function pmoSurfacePath(workspaceId: string, pmoId: string, surface: PmoSurface): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/pmos/${encodeURIComponent(pmoId)}`;
  const segment = SURFACE_SEGMENTS[surface];
  return segment ? `${base}/${segment}` : base;
}

export function pmoHomePath(workspaceId: string, pmoId: string): string {
  return pmoSurfacePath(workspaceId, pmoId, "home");
}

export function pmoChatPath(workspaceId: string, pmoId: string): string {
  return pmoSurfacePath(workspaceId, pmoId, "chat");
}

export function pmoReportsPath(workspaceId: string, pmoId: string): string {
  return pmoSurfacePath(workspaceId, pmoId, "reports");
}

export function pmoSettingsPath(workspaceId: string, pmoId: string): string {
  return pmoSurfacePath(workspaceId, pmoId, "settings");
}

export function pmoCommandCenterPath(workspaceId: string, pmoId: string): string {
  return pmoSurfacePath(workspaceId, pmoId, "command-center");
}

/**
 * The four legacy PMO entry points that this slice strangles.
 *
 * They remain routable — an old bookmark or a link in someone's notes must keep
 * working — but they hold no copy of any screen. Each resolves its `pmoId`,
 * derives the authoritative parent from `pmos.workspace_id`, authorizes the
 * caller, and redirects into the canonical family. Kept here, beside the
 * canonical builders, so the legacy→canonical mapping is one table rather than
 * four hand-written redirects that can disagree.
 *
 * There is no legacy `/pmos/<id>/command-center`: that surface was born
 * canonical in PR #606 and has no prior entry point to strangle.
 */
export const LEGACY_PMO_SURFACES = ["home", "chat", "reports", "settings"] as const;

export type LegacyPmoSurface = (typeof LEGACY_PMO_SURFACES)[number];

export function legacyPmoSurfacePath(pmoId: string, surface: LegacyPmoSurface): string {
  const base = `/pmos/${encodeURIComponent(pmoId)}`;
  const segment = SURFACE_SEGMENTS[surface];
  return segment ? `${base}/${segment}` : base;
}

export type CanonicalPmoRoute = {
  /** An asserted ancestry claim, NOT authority. Authorize before acting on it. */
  workspaceId: string;
  pmoId: string;
  surface: PmoSurface;
};

/**
 * Exactly the family, and nothing adjacent to it.
 *
 * The optional third segment is what distinguishes Home from the four named
 * surfaces. Anything deeper is refused rather than truncated to its prefix: a
 * path with an extra segment is not a route this app serves, and reading it as
 * its own parent is how a nav entry lights up for a page that 404s.
 */
const CANONICAL_PMO_ROUTE_PATTERN = /^\/workspaces\/([^/]+)\/pmos\/([^/]+)(?:\/([^/]+))?\/?$/;

/**
 * Recognize a canonical PMO path and recover the two ids and the surface.
 *
 * The protected layout needs this because it resolves workspace context for the
 * shell and the onboarding gate BEFORE the page component runs. Without it the
 * layout answers from the preferred-workspace cookie, so a canonical link to a
 * PMO in workspace B renders workspace A's navigation and evaluates A's
 * onboarding state — and an incomplete A can redirect the user away from a B
 * they are perfectly entitled to see.
 *
 * Fails closed on every ambiguity: an unknown surface segment, an empty id, an
 * extra segment, or a malformed percent-escape all return `null`. Refusing to
 * guess is the point — a decoded id is used to address a tenant's data, and
 * "probably meant this" is not a property an id can have.
 */
export function parseCanonicalPmoRoute(pathname: string): CanonicalPmoRoute | null {
  const match = CANONICAL_PMO_ROUTE_PATTERN.exec(pathname);
  if (!match) return null;

  const segment = match[3];
  const surface = segment === undefined ? "home" : SEGMENT_SURFACES.get(segment);
  if (!surface) return null;

  try {
    const workspaceId = decodeURIComponent(match[1]);
    const pmoId = decodeURIComponent(match[2]);
    // Blank is not an id. The ids are returned UNTRIMMED — trimming would change
    // the id, and an id is either the one that was asked for or nothing — but a
    // segment that is only whitespace names no entity and is refused here rather
    // than sent on to be compared against real rows.
    if (!workspaceId.trim() || !pmoId.trim()) return null;
    return { workspaceId, pmoId, surface };
  } catch {
    // A malformed percent-escape is not an id.
    return null;
  }
}

/**
 * Does `pathname` belong to the canonical PMO route family?
 *
 * This is the predicate the shell's active-state rule uses, so it must cover the
 * whole family: every PMO surface is "in PMOs", not "in Workspaces", even though
 * all of them nest under `/workspaces/<id>/`. It is deliberately NOT the same
 * predicate as `isPmoCommandCenterPath`, which stays narrow to one surface, and
 * NOT related to `isWorkspaceCommandCenterPath`, which must never be widened to
 * claim a PMO route (they are different entity scopes — ADR-PMF-014 Rule 1).
 */
export function isCanonicalPmoRoutePath(pathname: string): boolean {
  return parseCanonicalPmoRoute(pathname) !== null;
}
