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
 *
 * WHERE THE LITERALS LIVE NOW
 * ---------------------------
 * `workspace-paths.ts` owns the canonical Workspace route FAMILY — Home, this
 * screen, Settings, their one parser and the `/workspaces` nav identity. This
 * module consumes it and keeps only what is genuinely Command-Center-specific:
 * the legacy entry point, the forwarded query keys, this screen's own
 * one-surface narrowing of the family parser, and the shell's active-state rule.
 * The canonical builder is re-exported rather than re-implemented so PR #604's
 * callers and tests keep one import site while there is exactly one definition
 * of the path and exactly one regex that recognizes it.
 */

import { isCanonicalPmoRoutePath, PMOS_NAV_HREF } from "@/lib/pmos/pmo-paths";
import { parseCanonicalWorkspaceRoute } from "@/lib/workspaces/workspace-paths";

/**
 * One row of `workspaceSurfacePath`'s table, re-exported for PR #604's callers.
 * The definition — including the query handling the onboarding hand-off depends
 * on — lives in the family module.
 */
export { workspaceCommandCenterPath } from "@/lib/workspaces/workspace-paths";

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

/**
 * Is this pathname the Workspace Command Center specifically?
 *
 * Narrower than `isCanonicalWorkspaceRoutePath` on purpose: this predicate
 * answers "is the user looking at the WORKSPACE's Command Center", which is a
 * question about ONE surface — it is what keeps the two Command Centers' and the
 * three Workspace surfaces' identities apart. It shares the family's single
 * pattern, so it cannot drift from the builder above, and it is deliberately NOT
 * widened to claim a PMO route (a different entity scope — ADR-PMF-014 Rule 1).
 */
export function isWorkspaceCommandCenterPath(pathname: string): boolean {
  return parseCanonicalWorkspaceRoute(pathname)?.surface === "command-center";
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
 *
 * Workspace Home (`/workspaces/<id>`) and Workspace Settings
 * (`/workspaces/<id>/settings`) need NO branch of their own: they fall through to
 * the `startsWith` default and light up "Workspaces", which is the truthful
 * answer — they are that entry's own entity surfaces, not a second place the PM
 * is simultaneously in. The Workspace Command Center keeps its separate nav
 * identity because `/command-center` is a real, separately-labelled entry; that
 * is PR #604's behaviour and this slice does not re-open it.
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
  const parsed = parseCanonicalWorkspaceRoute(pathname);
  return parsed?.surface === "command-center" ? parsed.workspaceId : null;
}
