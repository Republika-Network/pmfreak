/**
 * Canonical Command Center route construction — ONE definition.
 *
 * `07-route-layout-and-navigation-architecture.md` §1 names
 * `/workspaces/[workspaceId]/command-center` as the Workspace Command Center.
 * The historical bare `/command-center` is classified there (§9, "Near match,
 * needs remapping") as exactly the anti-pattern ADR-PMF-014 Rule 6 warns
 * about: an unqualified Command Center that cannot say which entity it is the
 * Command Center *of*.
 *
 * Both paths are exported because both are still real:
 *
 *   - `WORKSPACE_COMMAND_CENTER_LEGACY_PATH` is the compatibility entry point.
 *     It resolves the caller's workspace and redirects here. Every pre-auth
 *     surface (marketing nav, landing hero) and every auth/session redirect
 *     target must keep pointing at it, because none of them can know a
 *     workspace id at the time they are constructed.
 *   - `workspaceCommandCenterPath()` is the canonical destination, used
 *     wherever a workspace id is already in hand.
 *
 * Keeping the literal in one module is what makes the route flip reversible:
 * reverting this slice is reverting the callers of this function, not hunting
 * string literals across 35 files (ADR-PMF-068 rule 5).
 */

import { isCanonicalPmoRoutePath, PMOS_NAV_HREF } from "@/lib/pmos/pmo-paths";

export const WORKSPACE_COMMAND_CENTER_LEGACY_PATH = "/command-center";

/**
 * Query keys the Command Center screen reads. The legacy entry point forwards
 * these verbatim so an onboarding hand-off survives the redirect — dropping
 * `projectId` or `from=onboarding` would silently downgrade the guided first
 * experience to the generic one, which is the kind of regression a redirect is
 * least likely to be blamed for.
 */
export const COMMAND_CENTER_FORWARDED_QUERY_KEYS = [
  "projectId",
  "from",
  "briefGeneration",
  "error",
  "brainActivated",
  "invited",
] as const;

export function workspaceCommandCenterPath(
  workspaceId: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/command-center`;
  if (!query) return base;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

const WORKSPACE_COMMAND_CENTER_PATTERN = /^\/workspaces\/[^/]+\/command-center(?:\/|$)/;

export function isWorkspaceCommandCenterPath(pathname: string): boolean {
  return WORKSPACE_COMMAND_CENTER_PATTERN.test(pathname);
}

/**
 * Does `pathname` belong to the navigation entry declared as `navHref`?
 *
 * `NAVIGATION_HIERARCHY` keeps `/command-center` as the Command Center entry's
 * stable IDENTITY — it is the key `capability-reveal-selectors` and the shell's
 * own tier map look nav items up by, so it is deliberately not rewritten to the
 * canonical path. Only the rendered destination is canonical.
 *
 * That creates one ambiguity this function exists to resolve: the canonical
 * Command Center path lives UNDERNEATH `/workspaces/<id>/`, and `/workspaces`
 * is itself a real navigation entry ("Workspaces", utility tier). A plain
 * prefix test therefore lights up BOTH entries at once on the canonical route,
 * which would tell the PM they are in two places simultaneously. The deeper,
 * more specific entry wins.
 *
 * Every other entry keeps the shell's original `startsWith` semantics exactly,
 * so this slice changes active-state behaviour for the Command Center route
 * only and for nothing else.
 *
 * The canonical PMO route FAMILY (`/workspaces/<id>/pmos/<id>` and its `chat`,
 * `reports`, `settings` and `command-center` children) has the same collision one
 * level deeper, and is tested FIRST because all of it nests under `/workspaces/`
 * too. Its winner is the "PMOs" entry: a PM inside any PMO surface is in PMOs,
 * not in the workspace list they happened to travel through and not in the
 * Workspace Command Center. That last one matters most — `/command-center` is the
 * Workspace Command Center's nav identity, and lighting it up on a PMO route
 * would say the PM is in the workspace's Command Center while they are looking at
 * a PMO's. The two are different entity scopes (ADR-PMF-014 Rule 1), which is
 * also why `isWorkspaceCommandCenterPath` is NOT widened to match both — it stays
 * the Workspace screen's own predicate, and `/workspaces/<id>/command-center`
 * still resolves to it unchanged because the family predicate requires a `/pmos/`
 * segment.
 */
export function navEntryMatchesPathname(navHref: string, pathname: string): boolean {
  if (isCanonicalPmoRoutePath(pathname)) {
    return navHref === PMOS_NAV_HREF;
  }
  if (isWorkspaceCommandCenterPath(pathname)) {
    return navHref === WORKSPACE_COMMAND_CENTER_LEGACY_PATH;
  }
  return pathname.startsWith(navHref);
}

/**
 * Collapse one Next.js search-param value to a single string.
 *
 * A repeated key (`?projectId=p1&projectId=p1`) arrives as `string[]`, not
 * `string`. Declaring the params as scalars does not make them scalars — it only
 * hides the array from the type checker, and the array then flows into
 * `resolveActiveProject`, which compares it against real project ids, fails, and
 * tells the user a project they can see is "not found in this workspace".
 *
 * Both the canonical route and the legacy resolver normalize through this one
 * function so a link cannot behave differently depending on which entry point it
 * went through.
 */
export function firstQueryValue(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single !== "" ? single : undefined;
}

/**
 * Extract the workspace id from a canonical Command Center pathname.
 *
 * The protected layout needs this because it resolves workspace context for the
 * shell and the onboarding gate BEFORE the page component runs. Without it the
 * layout answers from the preferred-workspace cookie, so a canonical link to
 * workspace B renders workspace A's navigation and evaluates A's onboarding
 * state — and an incomplete A can redirect the user away from a B they are
 * perfectly entitled to see.
 *
 * Returns the raw segment only. It is an UNAUTHORIZED hint: every caller must
 * still put it through `resolveRoutedWorkspace` before acting on it.
 */
export function parseWorkspaceIdFromPath(pathname: string): string | null {
  const match = /^\/workspaces\/([^/]+)\/command-center(?:\/|$)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]) || null;
  } catch {
    return null;
  }
}
