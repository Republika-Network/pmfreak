import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  resolveRoutedWorkspace,
  type RoutedWorkspaceAccess,
  type RoutedWorkspaceRole,
} from "@/lib/workspaces/routed-workspace";
import type { ProjectStatus } from "@/lib/db/database-contract";

/**
 * The outcome of authorizing a Project id that came from a URL.
 *
 *   granted  — the caller may act in this project's workspace, and neither the
 *              project nor that workspace is archived.
 *   archived — the caller is authorized, but the project and/or its parent
 *              workspace is archived. Per
 *              `07-route-layout-and-navigation-architecture.md` §7 this is a
 *              READ-ONLY STATE, NOT an access failure: the viewer must still see
 *              last-known data with the state explained, because archival is a
 *              state transition, not a deletion. `archived` reports which of the
 *              two it is so the screen can say something true rather than
 *              something generic.
 *   denied   — no such project, no membership in its workspace, a deleted or
 *              unreachable workspace, or a routed workspace id that disagrees
 *              with the project's real parent. These are deliberately ONE
 *              outcome so the route cannot be used to probe which project ids
 *              exist (§7's leakage rule).
 *
 * A project has no `deleted` status — `ProjectStatus` is
 * `active | archived | completed` and `DELETE /api/projects/[id]` issues a hard
 * delete — so a deleted project is genuinely absent and needs no special case:
 * it simply fails the lookup and lands in `denied`. `completed` is NOT archived:
 * it is a normal, mutable project state the product already renders, and
 * treating it as read-only here would invent a lifecycle rule the product does
 * not have.
 *
 * WHY `role` IS PART OF THE VERDICT
 * ---------------------------------
 * This is the one place it can be trusted. Project Home decides which task CTAs
 * to render from the caller's workspace role, and before this slice it read that
 * role from `resolvePreferredWorkspace(user.id)` — the COOKIE — while the page
 * itself was about a project in whatever workspace actually owns it. When those
 * two differed the page authorized one workspace and gated its controls against
 * another: a PM in the project's workspace could be shown a viewer's screen, and
 * a viewer there could be shown a PM's, purely because of where they had last
 * been. Returning the role from the same lookup that established the parent
 * makes the mismatch unrepresentable rather than merely fixed.
 *
 * Nothing here carries project row CONTENT. The verdict, the two ids the caller
 * already holds, and the caller's own role are the entire payload, so an
 * unauthorized request cannot learn a project's name, description or status from
 * this resolver.
 */
export type RoutedProjectAccess =
  | {
      access: "granted";
      projectId: string;
      workspaceId: string;
      role: RoutedWorkspaceRole;
      readOnly: false;
    }
  | {
      access: "archived";
      projectId: string;
      workspaceId: string;
      role: RoutedWorkspaceRole;
      readOnly: true;
      archived: { project: boolean; workspace: boolean };
    }
  | { access: "denied"; projectId: null; workspaceId: null; role: null; readOnly: true };

const DENIED: RoutedProjectAccess = {
  access: "denied",
  projectId: null,
  workspaceId: null,
  role: null,
  readOnly: true,
};

/**
 * What the ancestry lookup is allowed to learn about a project: its parent
 * workspace and its status, and nothing else. Deliberately not `ProjectRow` — a
 * wider shape here is how row content leaks into a refusal path.
 */
export type ProjectAncestry = { workspaceId: string; status: ProjectStatus };

/**
 * The access decision, as a pure function.
 *
 * Split out from the I/O below so every rule in the route contract is provable
 * without a database: ancestry mismatch, archived-vs-denied, and the absence of
 * any fallback are all decided here.
 *
 * `project` is `null` when no project resolved for the requested id (absent,
 * invisible to the caller, or the read failed — all fail closed).
 * `workspaceAccess` is `null` when we never got far enough to ask, which is the
 * same refusal.
 */
export function decideRoutedProjectAccess(input: {
  routedWorkspaceId: string;
  projectId: string;
  project: ProjectAncestry | null;
  workspaceAccess: RoutedWorkspaceAccess | null;
}): RoutedProjectAccess {
  const { routedWorkspaceId, projectId, project, workspaceAccess } = input;

  if (!routedWorkspaceId || !projectId) return DENIED;
  if (!project) return DENIED;
  if (!workspaceAccess || workspaceAccess.access === "denied") return DENIED;

  // Defensive: the workspace that was authorized must be the project's own. This
  // can only fail if a caller passes a workspaceAccess resolved for some other
  // id, which is precisely the substitution this whole module exists to stop.
  if (workspaceAccess.workspaceId !== project.workspaceId) return DENIED;

  // The ancestry claim in the URL must match reality. `projects.workspace_id` is
  // the authority for a project's parent; the routed segment is only an
  // assertion about it. Refusing — rather than "helpfully" correcting to the
  // real workspace — is the point: a corrected render would serve project P
  // under a workspace id that does not own it, which is the exact confusion an
  // entity-qualified route exists to prevent, and it would let a caller discover
  // a project's true workspace by watching the URL change.
  if (routedWorkspaceId !== project.workspaceId) return DENIED;

  const workspaceArchived = workspaceAccess.access === "archived";
  // `completed` is deliberately excluded: see the type's doc comment.
  const projectArchived = project.status === "archived";

  if (workspaceArchived || projectArchived) {
    return {
      access: "archived",
      projectId,
      workspaceId: project.workspaceId,
      role: workspaceAccess.role,
      readOnly: true,
      archived: { project: projectArchived, workspace: workspaceArchived },
    };
  }

  return {
    access: "granted",
    projectId,
    workspaceId: project.workspaceId,
    role: workspaceAccess.role,
    readOnly: false,
  };
}

/**
 * The ONE ancestry read in this module: a project's parent workspace and its
 * status, by id, and nothing else.
 *
 * Both resolvers below share it so there is exactly one lookup site for project
 * ancestry in the route layer — the alternative was each route file writing its
 * own query, which is how a narrow rule turns into four slightly different ones.
 * `null` means "not a project you can see", whether the row is absent, hidden by
 * RLS, or the read failed: all three fail closed, and all three are the same
 * answer on purpose.
 *
 * WHY THIS IS THE CALLER'S OWN CLIENT, NOT A SERVICE-ROLE ONE
 * ----------------------------------------------------------
 * `resolveRoutedPmo` needs a privileged read because `pmos` RLS filters by
 * `workspace_memberships` and a caller-scoped read there cannot distinguish
 * "not yours" from "yours, but unchecked" — it collapses the ancestry question
 * into the access question. For `projects` that collapse is not a problem, it is
 * the ANSWER. The `projects` SELECT policy is exactly
 *
 *     exists (select 1 from workspace_memberships wm
 *             where wm.workspace_id = projects.workspace_id
 *               and wm.user_id = auth.uid())
 *
 * (20260512160000) — membership in the project's own workspace, which is the
 * very thing that must hold for access to be granted. So a caller-scoped read
 * returns the row precisely when the caller is entitled to be told the project's
 * parent, and returns nothing in every case that must end in `denied`. A
 * service-role read here would widen the privileged boundary to learn something
 * RLS is already willing to say, and the "extra" answer it bought would have to
 * be thrown away to preserve the indistinguishable refusal. Fewer privileged
 * call sites is the whole point (there are none added by this slice).
 *
 * `resolveRoutedWorkspace` below still runs privileged, because workspace STATUS
 * and membership ROLE are not derivable from this row — but that is one existing,
 * already-registered boundary, reused rather than duplicated.
 */
async function readProjectAncestry(projectId: string): Promise<ProjectAncestry | null> {
  const supabase = await createSupabaseServerClient();

  const { data: project, error } = await supabase
    .from("projects")
    .select("workspace_id, status")
    .eq("id", projectId)
    .maybeSingle<{ workspace_id: string; status: ProjectStatus }>();

  if (error || !project) return null;
  return { workspaceId: project.workspace_id, status: project.status };
}

/**
 * Authorizes a Project id supplied by a ROUTE.
 *
 * WHY THIS EXISTS ALONGSIDE resolveRoutedWorkspace
 * ------------------------------------------------
 * `resolveRoutedWorkspace` answers "may this user act in THIS workspace?" — but
 * a Project route does not name a workspace it can trust. It names a project, and
 * the workspace segment beside it is a claim, not an authority. This function
 * answers "may this user act in THIS project, and is the URL telling the truth
 * about where it lives?", by deriving the parent workspace from the project row
 * itself and then delegating the membership question to the existing resolver.
 *
 * It has no fallback at all. In particular it is NOT
 * `resolveCanonicalProject`, which this slice removes from the route layer:
 * that helper listed a workspace's fifty most recent projects and, when the
 * requested id was not among them, returned the FIRST one with
 * `recovered: true`. On an explicit entity route that is not recovery, it is
 * substitution — project A silently becoming project B — and it fired for real
 * on any workspace holding more than fifty projects, where a perfectly valid id
 * simply fell off the end of the list. There is no preferred project, no default
 * project, no first project in the workspace, and no preferred-workspace cookie
 * anywhere in this path: a requested project either resolves as authorized or is
 * refused.
 *
 * No project membership model is consulted, because none exists: there is no
 * `project_members` table anywhere in the schema, and the `projects` RLS
 * policies read `workspace_memberships`. Project access is inherited through
 * workspace membership, and inventing anything else here would be inventing
 * domain semantics. Capability checks (`evaluateCapabilityAccess`,
 * `requireProjectAccess`) still run on the screens and in the mutations, exactly
 * as before — this resolver decides ROUTE identity, not policy.
 */
export async function resolveRoutedProject(
  userId: string,
  routedWorkspaceId: string,
  projectId: string,
): Promise<RoutedProjectAccess> {
  if (!userId || !routedWorkspaceId || !projectId) return DENIED;

  const project = await readProjectAncestry(projectId);
  if (!project) return DENIED;

  // Authorize the project's REAL workspace, not the one the URL asserted.
  // Checking the claim afterwards (in the pure decision above) rather than
  // short-circuiting on it keeps this path from behaving observably differently
  // for a mismatched id than for an unauthorized one.
  const workspaceAccess = await resolveRoutedWorkspace(userId, project.workspaceId);

  return decideRoutedProjectAccess({ routedWorkspaceId, projectId, project, workspaceAccess });
}

/**
 * Authorizes a Project id that arrived on the LEGACY route — one that carries no
 * workspace segment at all.
 *
 * `/projects/[id]` is a compatibility entry point kept alive for old bookmarks,
 * pasted links, and the client-side `router.push`es after a create or a
 * duplicate that hold only a project id. It holds no screen: it resolves through
 * here and redirects into the canonical family, so there is never a second copy
 * of Project Home to drift out of sync (ADR-PMF-068 rule 2).
 *
 * WHY THIS IS NOT `resolveRoutedProject(userId, someWorkspaceId, projectId)`
 * ------------------------------------------------------------------------
 * Because there is no honest value for the middle argument. A legacy URL asserts
 * nothing about ancestry, so there is no claim to check — and the temptation is
 * to fill the gap from the preferred-workspace cookie, which would be the exact
 * defect this route family exists to remove: the SAME legacy project id would
 * then resolve differently depending on which workspace the caller happened to
 * be in last, and a redirect destination would be attacker-influenced by a
 * client-controlled cookie. The authoritative parent comes from
 * `projects.workspace_id` and from nowhere else.
 *
 * So the ancestry check is satisfied trivially and deliberately: the routed
 * workspace IS the authoritative one, because there was no routed workspace. The
 * decision function is still the one that decides — same archived semantics, same
 * single indistinguishable refusal, same absence of any fallback — so the legacy
 * seam cannot grant anything the canonical route would refuse.
 *
 * The returned `workspaceId` is what the redirect must be built from: it is the
 * project's real parent, so `/projects/P` lands on `/workspaces/W/projects/P`
 * for exactly one W, forever, for every caller.
 */
export async function resolveLegacyProjectRoute(userId: string, projectId: string): Promise<RoutedProjectAccess> {
  if (!userId || !projectId) return DENIED;

  const project = await readProjectAncestry(projectId);
  if (!project) return DENIED;

  const workspaceAccess = await resolveRoutedWorkspace(userId, project.workspaceId);

  return decideRoutedProjectAccess({
    routedWorkspaceId: project.workspaceId,
    projectId,
    project,
    workspaceAccess,
  });
}
