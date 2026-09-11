import { redirect } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { resolveLegacyProjectRoute } from "@/lib/projects/routed-project";
import { projectHomePath } from "@/lib/projects/project-paths";
import { ProjectNotAvailable } from "@/components/pmfreak/projects/project-route-states";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/**
 * Legacy Project Home entry point — a resolver, not a screen.
 *
 * Project Home moved to `/workspaces/[workspaceId]/projects/[projectId]`. This
 * path stays because a great deal already points at it: bookmarks, pasted links,
 * the "Add first task" button after a create, the `router.push` after a
 * duplicate, and the breadcrumbs on Project Chat and Project Settings. Per
 * ADR-PMF-068 a legacy route keeps serving until its replacement is verified.
 * What it does NOT keep is a copy of the screen: one implementation, one
 * destination, so the two cannot drift (ADR-PMF-068 rule 2). That is the whole
 * point of a strangler seam — if this file still rendered a task list, an
 * analysis form and a PM assignment panel, there would be two Project Homes to
 * fix every time one of them changed.
 *
 * Only HOME redirects. `/projects/[id]/chat`, `/projects/[id]/settings` and
 * `/projects/[id]/follow-up` are untouched and keep rendering their own screens:
 * `07-route-layout-and-navigation-architecture.md` §2's ratified Project family
 * contains no `chat`, `settings` or `follow-up` member, so there is no canonical
 * destination to send them to, and inventing one would be inventing
 * architecture.
 *
 * WHERE `W` COMES FROM, AND WHERE IT MUST NOT
 * -------------------------------------------
 * A legacy URL names only a project, so the redirect has to discover its
 * workspace. `resolveLegacyProjectRoute` reads it from `projects.workspace_id` —
 * the authority, and a NOT NULL column — and from nowhere else. Not from the
 * preferred-workspace cookie, not from the caller's first membership, not from
 * the shell's current context, not from the previous page. The consequence is the
 * property the old route did not have: `/projects/P` resolves to ONE canonical
 * URL, the same one for every caller and every session. A client-controlled
 * cookie cannot steer where this redirect goes.
 *
 * And it never substitutes a different project. The screen this file used to hold
 * called `resolveCanonicalProject(project.workspace_id, id)`, which listed the
 * workspace's fifty most recent projects and redirected to the FIRST one when the
 * requested id was not among them — so on any workspace with more than fifty
 * projects, a valid link to project A landed the user on project B, announced
 * only by a `?recoveredFrom=invalidProject` query nothing read. There is no
 * fallback on this path at all.
 *
 * MISSING AND UNAUTHORIZED ARE THE SAME ANSWER
 * --------------------------------------------
 * A project that does not exist, one that was deleted, and one whose workspace
 * the caller has no membership in all arrive here as `denied` and render the
 * identical refusal. This route must not become an existence oracle: "redirect"
 * versus "refusal" is the only signal it emits, and it is the same signal the
 * canonical route emits, so nothing is learned by trying the legacy path instead.
 * In particular the refusal never names the project's real workspace or PMO.
 *
 * An ARCHIVED project redirects normally. Archival is a read-only state, not a
 * deletion (`07-route…` §7), so its identity stays routable and the canonical
 * screen is what explains the state.
 */
export default async function LegacyProjectHomeRedirectPage({ params }: Props) {
  const user = await requireAuthUser();
  const { id } = await params;

  const access = await resolveLegacyProjectRoute(user.id, id);
  if (access.access === "denied") {
    console.error(
      JSON.stringify({ event: "legacy_project_home.project_not_accessible", userId: user.id, requestedProjectId: id }),
    );
    return <ProjectNotAvailable />;
  }

  // A temporary redirect, which is what `redirect()` issues for a Server
  // Component render (307). Appropriate for a strangler migration: the legacy URL
  // is not permanently gone, it is being drained, and a cached 308 in a user's
  // browser would outlive any decision to revert this slice.
  redirect(projectHomePath(access.workspaceId, access.projectId));
}
