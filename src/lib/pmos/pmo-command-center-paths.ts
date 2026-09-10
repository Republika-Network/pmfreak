/**
 * Canonical PMO Command Center route construction — ONE definition.
 *
 * THE ROUTE
 * ---------
 * `07-route-layout-and-navigation-architecture.md` §2 names
 * `/workspaces/[workspaceId]/pmos/[pmoId]/command-center` as the PMO Command
 * Center, with the layout chain "Authenticated Shell → Workspace → PMO". PMO is
 * nested under Workspace because `pmos.workspace_id` is NOT NULL — §1's rule is
 * that a route names its entity's *mandatory* structural parent, which is why
 * Project routes are Workspace-rooted while PMO/Portfolio/Program routes are
 * not. §4 rule 3 fixes `command-center` as the terminal segment, mirroring the
 * breadcrumb rule that a Command Center is only ever a trail's last node
 * (`03-navigation-contracts.md` §2.3 rule 4, ADR-PMF-014 Rule 4).
 *
 * `src/lib/pm-operations/pm-operations-paths.ts` already committed this literal
 * to code, as the justification for renaming the internal dashboard.
 *
 * WHY `/pmo-command-center` IS NOT A LEGACY ALIAS FOR THIS SCREEN
 * --------------------------------------------------------------
 * It is tempting, and wrong. `/pmo-command-center` already has a compatibility
 * responsibility: it redirects to `/pm-operations`, the internal PM-operations
 * dashboard that was renamed out from under that path precisely because
 * ADR-PMF-014 Rule 6 forbids an internal ops surface from sharing an
 * unqualified label with a user-facing feature. Pointing it here instead would
 * give the same path a second meaning, break every operator bookmark it exists
 * to serve, and re-open the Rule 6 collision that rename closed.
 *
 * So this screen has NO legacy entry point, and needs none: it is new. There is
 * no prior surface to strangle. `/pm-operations` and this route are different
 * screens over different entities and must stay that way — the PM Operations
 * data layer takes a `workspaceId` and no `pmoId` at all, and never reads the
 * `pmos` table (pinned by `tests/pm-operations-internal-rename.test.ts`).
 *
 * WHY THE `pmo_*` TABLES ARE NOT THIS SCREEN'S DATA
 * ------------------------------------------------
 * ADR-PMF-014 Rule 5 warns that backend names carrying "Command Center" are not
 * user-facing vocabulary, and ADR-PMF-007/014 established that backend naming
 * does not imply entity semantics. Verified against the schema, every table
 * whose name suggests PMO scope is in fact WORKSPACE-scoped, with no `pmo_id`
 * column and no FK to `pmos`:
 *
 *   pmo_command_center_snapshots  workspace_id only  (the gap IA §5.3 flags)
 *   pmo_attention_items           workspace_id + snapshot_id
 *   pmo_recommendations           workspace_id + snapshot_id
 *   pmo_executive_reports         workspace_id only
 *   pmo_intervention_actions      workspace_id; project_id is `text`, not a FK
 *   operational_command_centers   workspace_id + project_id  (project-scoped)
 *   governance_compliance_gaps    workspace_id + snapshot_id, no project_id
 *
 * Those are the backing store of the internal dashboard. Composing this screen
 * from them would rebuild PM Operations under a PMO-qualified name, which is
 * exactly the confusion Rule 6 exists to prevent. A repo-wide search of
 * `supabase/migrations/` shows `pmo_id` exists as a real column in exactly two
 * places: `projects.pmo_id` and `context_conversations.pmo_id`. `projects.pmo_id`
 * is therefore the only structural PMO→descendant edge this screen can project
 * over, and everything else must be reached through the PMO's project ids.
 *
 * Keeping the literals in one module is what makes the slice reversible:
 * reverting is reverting this module's callers, not hunting strings across the
 * tree (ADR-PMF-068 rule 5).
 */

/**
 * The `/pmos` navigation entry's stable identity in `NAVIGATION_HIERARCHY`.
 *
 * Declared here, next to the route it belongs to, so the shell's active-state
 * rule and this route cannot drift apart. It is the entry a PM is "in" while
 * viewing a PMO Command Center — not "Workspaces", which would otherwise win by
 * prefix because the canonical path nests under `/workspaces/<id>/`.
 */
export const PMOS_NAV_HREF = "/pmos";

/**
 * PMO Home, as currently shipped.
 *
 * The canonical map puts PMO Home at `/workspaces/[workspaceId]/pmos/[pmoId]`,
 * but that route does not exist yet — the PMO family lives at `/pmos/[pmoId]`
 * and its migration is Phase 1 of `07-frontend-migration-strategy.md` §7, a
 * separate unit of work from this Command Center slice. Per ADR-PMF-068 the
 * legacy route keeps serving until its replacement is verified, so the
 * breadcrumb's PMO node points at where PMO Home actually is today rather than
 * at a path that would 404. One constant to change when that migration lands.
 */
export function legacyPmoHomePath(pmoId: string): string {
  return `/pmos/${encodeURIComponent(pmoId)}`;
}

/**
 * The Workspace-level ancestor node's destination.
 *
 * Same situation as above, one level up — but with a trap. The canonical map
 * names `/workspaces/[workspaceId]` for Workspace Home, and only
 * `/workspaces/[workspaceId]/command-center` exists beneath that segment today,
 * so there is no per-workspace Home to point at yet.
 *
 * The obvious substitute, the singular `/workspace`, is WRONG here and the
 * mistake is invisible from the href: `src/proxy.ts` quarantines that path and
 * bounces every authenticated request to `/command-center`, which resolves on
 * to the Workspace Command Center. A breadcrumb node pointing there would
 * navigate an ancestor to a Command Center, which
 * `03-navigation-contracts.md` §2.3 rule 1 forbids outright ("never its
 * Command Center") and §2.3 rule 4 / ADR-PMF-014 Rule 4 forbid structurally,
 * since it puts a Command Center mid-trail.
 *
 * `/workspaces` is the shipped workspace-level surface — it describes itself as
 * "Level 1 of the Workspace → PMO → Project hierarchy", is not quarantined, and
 * is not a Command Center. It is the workspace LIST rather than one workspace's
 * Home, which is a real if minor imprecision: rule 1 also wants every node
 * clickable, and between "clickable but one level broad" and "clickable
 * straight into a Command Center" only the first is compatible with the rule
 * that Command Center is never an intermediate node.
 *
 * Repoint this at `/workspaces/[workspaceId]` when Workspace Home lands in the
 * route family's own migration (`07-frontend-migration-strategy.md` §7 Phase 1).
 */
export const LEGACY_WORKSPACE_HOME_PATH = "/workspaces";

/**
 * The canonical PMO Command Center path.
 *
 * Both ids are percent-encoded. A path segment is not a safe place for
 * arbitrary text: an unencoded id containing `/` would silently add segments
 * and address a different route entirely.
 */
export function pmoCommandCenterPath(workspaceId: string, pmoId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/pmos/${encodeURIComponent(pmoId)}/command-center`;
}

const PMO_COMMAND_CENTER_PATTERN = /^\/workspaces\/([^/]+)\/pmos\/([^/]+)\/command-center(?:\/|$)/;

export function isPmoCommandCenterPath(pathname: string): boolean {
  return PMO_COMMAND_CENTER_PATTERN.test(pathname);
}

/**
 * Extract the workspace and PMO ids from a canonical PMO Command Center path.
 *
 * The protected layout needs this because it resolves workspace context for the
 * shell and the onboarding gate BEFORE the page component runs. Without it the
 * layout answers from the preferred-workspace cookie, so a canonical link to a
 * PMO in workspace B renders workspace A's navigation and evaluates A's
 * onboarding state — and an incomplete A can redirect the user away from a B
 * they are perfectly entitled to see. That defect is already documented on the
 * Workspace Command Center's own parser; this is the same hazard one level
 * deeper.
 *
 * Both values are UNAUTHORIZED HINTS. The workspace id in particular is only an
 * asserted ancestry claim: `pmos.workspace_id` is the authority for a PMO's
 * parent workspace, and `resolveRoutedPmo` refuses when the two disagree rather
 * than correcting the URL. Every caller must authorize before acting.
 */
export function parsePmoRouteFromPath(pathname: string): { workspaceId: string; pmoId: string } | null {
  const match = PMO_COMMAND_CENTER_PATTERN.exec(pathname);
  if (!match) return null;
  try {
    const workspaceId = decodeURIComponent(match[1]);
    const pmoId = decodeURIComponent(match[2]);
    if (!workspaceId || !pmoId) return null;
    return { workspaceId, pmoId };
  } catch {
    // A malformed percent-escape is not an id. Refusing to guess is the point.
    return null;
  }
}

export type BreadcrumbNode = {
  label: string;
  /** `null` marks the terminal node — rendered as text, never as a link. */
  href: string | null;
};

/**
 * The PMO Command Center breadcrumb: `Workspace ↓ PMO ↓ PMO Command Center`.
 *
 * Pure, so the contract is provable without rendering: every ancestor node
 * navigates to that ancestor's HOME and never to its Command Center
 * (`03-navigation-contracts.md` §2.3 rule 1), and the entity-qualified Command
 * Center is the terminal node (§2.3 rule 4) — which is what `href: null`
 * encodes. A trail is computed from the entity's resolved ancestry, not from
 * the URL's nesting (`07-route…` §6), so the caller passes the AUTHORITATIVE
 * workspace derived from `pmos.workspace_id`, never the routed segment.
 */
export function pmoCommandCenterBreadcrumb(input: {
  workspaceLabel: string;
  pmoName: string;
  pmoId: string;
}): BreadcrumbNode[] {
  return [
    { label: input.workspaceLabel, href: LEGACY_WORKSPACE_HOME_PATH },
    { label: input.pmoName, href: legacyPmoHomePath(input.pmoId) },
    { label: "PMO Command Center", href: null },
  ];
}
