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
 * WHERE THE LITERALS LIVE NOW
 * ---------------------------
 * `pmo-paths.ts` owns the canonical PMO route family — all five surfaces, their
 * parser, and the `/pmos` nav identity. This module consumes it and keeps only
 * what is genuinely Command-Center-specific: the one-surface predicate, and this
 * screen's breadcrumb. That split is why the family's migration did not turn a
 * module named for one surface into the home of five (ADR-PMF-068 rule 5 wants
 * one literal in one place; it does not want that place to be misnamed).
 */

import { pmoHomePath, parseCanonicalPmoRoute } from "@/lib/pmos/pmo-paths";
import { workspaceHomePath } from "@/lib/workspaces/workspace-paths";

/**
 * Re-exported so PR #606's callers and tests keep one import site while the
 * definitions live in the family module. Both are family-level facts, not
 * Command-Center-level ones: the nav identity covers every PMO surface, and the
 * Command Center path is one row of `pmoSurfacePath`'s table.
 */
export { PMOS_NAV_HREF, pmoCommandCenterPath } from "@/lib/pmos/pmo-paths";

/**
 * THE WORKSPACE ANCESTOR SEAM IS CLOSED.
 *
 * PR #606 had to point this node at the singular `/workspace` alternative's only
 * safe substitute, and PR #607 left it at the plural `/workspaces` — the workspace
 * CHOOSER — because no per-workspace Home existed yet. Both were placeholders for
 * a node that `03-navigation-contracts.md` §2.3 rule 1 says must navigate to the
 * ancestor's own Home:
 *
 *   - `/workspace` is quarantined by `src/proxy.ts` straight to `/command-center`,
 *     so an ancestor pointing there navigates to a Command Center — forbidden
 *     outright by rule 1 and structurally by §2.3 rule 4 / ADR-PMF-014 Rule 4,
 *     which keep a Command Center at the END of a trail and nowhere else. The
 *     mistake was invisible from the href, which is why the PMO tests pin the
 *     quarantine itself rather than only the link.
 *   - `/workspaces` was clickable and was not a Command Center, but it is the
 *     LIST rather than one workspace's Home: a real if minor imprecision, chosen
 *     because between "clickable but one level broad" and "clickable straight
 *     into a Command Center" only the first is compatible with the rules above.
 *
 * Workspace Home now exists at `/workspaces/[workspaceId]`, so the node points at
 * the actual parent entity, built from the AUTHORITATIVE workspace the caller
 * already holds. No constant is needed for it: `workspaceHomePath` is the one
 * definition, in the Workspace family's own module.
 */

/**
 * Is this pathname the PMO Command Center specifically?
 *
 * Narrower than `isCanonicalPmoRoutePath` on purpose. This predicate answers
 * "is the user looking at the PMO's Command Center", which is a question about
 * ONE surface — used to keep the two Command Centers' identities apart. The
 * shell's active-state rule asks the wider question (is this any PMO surface)
 * and uses the family predicate instead.
 */
export function isPmoCommandCenterPath(pathname: string): boolean {
  return parseCanonicalPmoRoute(pathname)?.surface === "command-center";
}

/**
 * Extract the workspace and PMO ids from a canonical PMO Command Center path.
 *
 * The Command Center's own narrowing of `parseCanonicalPmoRoute`, sharing its
 * single pattern so the two cannot drift. Callers that need to serve the whole
 * PMO family — the protected layout, the shell's active-state rule — use the
 * family parser directly and read its `surface`.
 *
 * Both values are UNAUTHORIZED HINTS. The workspace id in particular is only an
 * asserted ancestry claim: `pmos.workspace_id` is the authority for a PMO's
 * parent workspace, and `resolveRoutedPmo` refuses when the two disagree rather
 * than correcting the URL. Every caller must authorize before acting.
 */
export function parsePmoRouteFromPath(pathname: string): { workspaceId: string; pmoId: string } | null {
  const parsed = parseCanonicalPmoRoute(pathname);
  if (!parsed || parsed.surface !== "command-center") return null;
  return { workspaceId: parsed.workspaceId, pmoId: parsed.pmoId };
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
  /**
   * The AUTHORITATIVE parent workspace, from `pmos.workspace_id` — never the
   * routed segment. `resolveRoutedPmo` has already proven the two equal by the
   * time a caller can render a trail, so this is a statement of where the value
   * must come from rather than a second check.
   */
  workspaceId: string;
  pmoName: string;
  pmoId: string;
}): BreadcrumbNode[] {
  return [
    { label: input.workspaceLabel, href: workspaceHomePath(input.workspaceId) },
    // The PMO ancestor is its canonical Home. Before this slice it pointed at
    // the legacy `/pmos/[pmoId]`, which was a real seam: the trail's middle node
    // left the canonical family, and the legacy route could not even be told
    // which workspace it belonged to. Both ids travel together now.
    { label: input.pmoName, href: pmoHomePath(input.workspaceId, input.pmoId) },
    { label: "PMO Command Center", href: null },
  ];
}
