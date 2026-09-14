/**
 * Canonical Project Command Center route construction and breadcrumb — ONE
 * definition.
 *
 * THE ROUTE
 * ---------
 * `07-route-layout-and-navigation-architecture.md` §2 names
 * `/workspaces/[workspaceId]/projects/[projectId]/command-center` as the Project
 * Command Center, with the layout chain "Authenticated Shell → Workspace →
 * Project". It is Workspace-rooted for the same reason Project Home is:
 * `projects.workspace_id` is NOT NULL and `projects.pmo_id` is NULL-able, so §1's
 * rule ("a route names its entity's *mandatory* structural parent") admits only
 * one answer. A project that later joins or leaves a PMO does not change this URL.
 *
 * §4 rule 3 fixes `command-center` as the TERMINAL segment, mirroring the
 * breadcrumb rule that an entity-qualified Command Center is only ever a trail's
 * last node (`03-navigation-contracts.md` §2.3 rule 4, ADR-PMF-014 Rule 4).
 *
 * The path literal is NOT written here. `project-paths.ts` owns the canonical
 * Project route family — its surface table, its single regex, and the `/projects`
 * nav identity — and this module consumes it, keeping only what is genuinely
 * Command-Center-specific: the one-surface predicate and this screen's
 * breadcrumb. That split is the same one `pmo-command-center-paths.ts` made, and
 * it is why adding a Project surface is one table row rather than a second
 * pattern that could disagree about which paths are Project routes.
 *
 * WHY THERE IS NO LEGACY ENTRY POINT TO STRANGLE
 * ---------------------------------------------
 * This screen is NEW. No prior surface addressed a single Project's Command
 * Center, and the three paths that look like candidates are all spoken for:
 *
 *   /command-center            The WORKSPACE Command Center's compatibility
 *                              resolver (PR #604). It resolves the caller's
 *                              workspace and redirects to
 *                              `/workspaces/<id>/command-center`. Repointing it
 *                              here would give one path two meanings and break
 *                              every pre-auth link and session redirect that
 *                              targets it precisely because they cannot know a
 *                              workspace id yet.
 *   /pmo-command-center        Redirects to `/pm-operations`, the internal
 *                              PM-operations dashboard, per ADR-PMF-014 Rule 6.
 *   /projects/[id]             The legacy Project HOME resolver. It redirects to
 *                              canonical Project Home and holds no screen.
 *
 * `/projects/[projectId]/command-center` is deliberately NOT created: there is no
 * prior surface behind it, so it would not be a compatibility seam — it would be
 * a second canonical Project Command Center identity, which is the entity
 * confusion ADR-PMF-007 ruled against.
 *
 * WHY THE `operational_command_centers` TABLE IS NOT THIS SCREEN'S IDENTITY
 * -----------------------------------------------------------------------
 * ADR-PMF-014 Rule 5 warns that a backend name carrying "Command Center" is not
 * user-facing vocabulary and implies no entity semantics. `operational_command_centers`
 * is a per-(project, Project-OS-snapshot) focus snapshot whose `project_id` is not
 * even FK-constrained to `projects`, and nothing in the product reads or writes
 * it. It is not a Project identity, it is not view configuration, and no id of
 * its ever appears in this route. The routed `projectId` is the only identity
 * this screen has.
 */

import { parseCanonicalProjectRoute, projectHomePath, projectSurfacePath } from "@/lib/projects/project-paths";
import { pmoHomePath } from "@/lib/pmos/pmo-paths";
import { workspaceHomePath } from "@/lib/workspaces/workspace-paths";

/**
 * Build the canonical Project Command Center path.
 *
 * One row of `projectSurfacePath`'s table, named. Both ids are percent-encoded
 * by the builder, so an id containing `/` cannot silently add segments and
 * address a different project or a surface that does not exist.
 *
 * Nothing here authorizes anything. A path produced by this function is a CLAIM
 * about ancestry; `projects.workspace_id` is the only authority for a project's
 * parent workspace, and `resolveRoutedProject` refuses a mismatch rather than
 * correcting it.
 */
export function projectCommandCenterPath(workspaceId: string, projectId: string): string {
  return projectSurfacePath(workspaceId, projectId, "command-center");
}

/**
 * Is this pathname the Project Command Center specifically?
 *
 * Narrower than `isCanonicalProjectRoutePath` on purpose. This predicate answers
 * "is the user looking at the PROJECT's Command Center", which is a question
 * about ONE surface — it is what keeps the three Command Centers' identities
 * apart. It shares the family's single pattern, so it cannot drift from the
 * builder above, and it is deliberately NOT widened to claim the Workspace or
 * PMO Command Center, which are different entity scopes (ADR-PMF-014 Rule 1).
 */
export function isProjectCommandCenterPath(pathname: string): boolean {
  return parseCanonicalProjectRoute(pathname)?.surface === "command-center";
}

export type BreadcrumbNode = {
  label: string;
  /** `null` marks the terminal node — rendered as text, never as a link. */
  href: string | null;
};

/**
 * Optional PMO ancestry, as the screen resolved it.
 *
 * `null` means NO PMO NODE IS EMITTED. It is deliberately not a statement about
 * why: a breadcrumb is not the place to discover cross-tenant data, and a middle
 * crumb invented for an unassigned project would assert a governance structure
 * the project is not in (`03-navigation-contracts.md` §2.3 rule 3). The trail
 * carries RESOLVED ancestry only. Which of the several ways ancestry can fail to
 * resolve actually occurred is `ProjectPmoAncestry` below — a separate value,
 * because the screen has to tell those apart even though the breadcrumb must not.
 */
export type ProjectBreadcrumbPmo = { id: string; name: string } | null;

/**
 * How PMO ancestry resolved — one state per distinguishable outcome.
 *
 * The route previously read the optional PMO row, discarded the query error, and
 * treated a `null` row as one fact: "this project has no PMO". Three genuinely
 * different situations produce that `null`, and collapsing them made the screen
 * assert something it had not established:
 *
 *   none         `projects.pmo_id IS NULL`. A first-class state (ADR-PMF-003
 *                rule 4, ADR-PMF-006 Rule 11) and the ONE case in which "this
 *                project has no PMO ancestry" is a fact the screen holds. No
 *                query is issued at all.
 *   resolved     `pmo_id` answered with a PMO in the AUTHORIZED workspace. The
 *                only case that may put a node in the trail.
 *   not-visible  `pmo_id` is set and the workspace-scoped read succeeded with no
 *                row — the PMO is deleted, or it belongs to another workspace and
 *                RLS plus the `workspace_id` filter correctly withheld it. No
 *                node, and no message either: saying "there is a PMO you cannot
 *                see" would turn a breadcrumb into the cross-tenant existence
 *                oracle the rest of this route refuses to be. Modelled as its own
 *                state so it is never silently re-labelled `none`, which would
 *                claim the project is unaffiliated when it is not.
 *   unavailable  the read FAILED. The screen knows nothing about this project's
 *                ancestry, and must not report the absence of a PMO as though it
 *                had looked and found none. Degraded, non-fatally: no node, no
 *                invented name, no substituted workspace or PMO, and the rest of
 *                the Project Command Center renders exactly as it would have.
 *
 * `pmo` is the breadcrumb input, and it is non-null in `resolved` alone — so no
 * failure path can fabricate ancestry, by construction rather than by review.
 *
 * Pure, and separate from the route, so all four outcomes are assertable without
 * a database and without rendering.
 */
export type ProjectPmoAncestry =
  | { state: "none"; pmo: null }
  | { state: "resolved"; pmo: { id: string; name: string } }
  | { state: "not-visible"; pmo: null }
  | { state: "unavailable"; pmo: null };

export function resolveProjectPmoAncestry(input: {
  /** `projects.pmo_id`, read from the project row itself. */
  pmoId: string | null;
  /** The workspace-scoped `pmos` row, when the read returned one. */
  row: { id: string; name: string } | null;
  /** The read's error, if it failed. Checked BEFORE the row, never discarded. */
  error: { message: string } | null;
}): ProjectPmoAncestry {
  // No `pmo_id` means no read happened, so there is no failure to report and the
  // absence is a stored fact rather than an unanswered question.
  if (input.pmoId === null) return { state: "none", pmo: null };
  if (input.error !== null) return { state: "unavailable", pmo: null };
  if (input.row === null) return { state: "not-visible", pmo: null };
  return { state: "resolved", pmo: { id: input.row.id, name: input.row.name } };
}

/**
 * The Project Command Center breadcrumb:
 * `Workspace ↓ [PMO] ↓ Project ↓ Project Command Center`.
 *
 * Pure, so the contract is provable without rendering:
 *
 *   - every ancestor node navigates to that ancestor's HOME and never to its
 *     Command Center (`03-navigation-contracts.md` §2.3 rule 1) — including the
 *     Project node, because Home and Command Center are SIBLINGS reachable from
 *     each other directly, never nested (IA §15 rule 6);
 *   - the entity-qualified Command Center is the terminal node (§2.3 rule 4),
 *     which is what `href: null` encodes;
 *   - the trail is computed from RESOLVED ancestry, not from the URL's nesting
 *     (`07-route…` §6), so the caller passes the AUTHORITATIVE workspace derived
 *     from `projects.workspace_id`, never the routed segment.
 *
 * NO PORTFOLIO OR PROGRAM NODE IS EMITTED, and none can be. `03-navigation-contracts.md`
 * §2.2 describes deeper trails, but `projects` carries exactly `workspace_id` and
 * `pmo_id` — there is no `portfolio_id` and no `program_id` column anywhere in
 * `supabase/migrations/`, and `programs` has no Program↔Project FK. Emitting such
 * a node would be inventing ancestry the domain does not have (§2.3 rule 3).
 */
export function projectCommandCenterBreadcrumb(input: {
  workspaceLabel: string;
  /**
   * The AUTHORITATIVE parent workspace, from `projects.workspace_id` — never the
   * routed segment. `resolveRoutedProject` has already proven the two equal by
   * the time a caller can render a trail, so this is a statement of where the
   * value must come from rather than a second check.
   */
  workspaceId: string;
  pmo: ProjectBreadcrumbPmo;
  projectName: string;
  projectId: string;
}): BreadcrumbNode[] {
  return [
    { label: input.workspaceLabel, href: workspaceHomePath(input.workspaceId) },
    ...(input.pmo ? [{ label: input.pmo.name, href: pmoHomePath(input.workspaceId, input.pmo.id) }] : []),
    { label: input.projectName, href: projectHomePath(input.workspaceId, input.projectId) },
    { label: "Project Command Center", href: null },
  ];
}
