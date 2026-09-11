import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateCapabilityAccess } from "@/lib/security/capability-flow";
import { resolveRoutedProject } from "@/lib/projects/routed-project";
import { ProjectArchivedNotice, ProjectNotAvailable } from "@/components/pmfreak/projects/project-route-states";
import { ProjectPMAssignment } from "@/components/pmfreak/ProjectPMAssignment";
import { ProjectTaskList } from "@/components/pmfreak/tasks/project-task-list";
import { ProjectTabNav } from "@/components/pmfreak/projects/project-tab-nav";
import { workspaceHomePath } from "@/lib/workspaces/workspace-paths";
import { pmoHomePath } from "@/lib/pmos/pmo-paths";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ workspaceId: string; projectId: string }> };

/**
 * Project Home — the canonical, entity-qualified route.
 *
 * The screen is the one that shipped at `/projects/[id]`: project identity, its
 * execution/task list, the AI analysis entry point, PM assignment, and prior
 * analyses. What changed is WHO DECIDES which project it is about, and WHICH
 * WORKSPACE its role checks read. The screen itself is not redesigned, and it is
 * deliberately not the Project Command Center — that screen now exists at
 * `/workspaces/[workspaceId]/projects/[projectId]/command-center`, reachable from
 * the tab strip below. IA Principle 5 (One Entity One Home) is only worth
 * anything if Home and Command Center stay different screens, and IA §15 rule 6
 * makes them siblings reachable from each other directly, never nested: Home owns
 * the project's identity and its execution CRUD, the Command Center composes a
 * read-only projection over the same project. Nothing moved off this page.
 *
 * WHY THE PROJECT ID IS AUTHORIZED AND THE WORKSPACE ID IS ONLY A CLAIM
 * --------------------------------------------------------------------
 * Both segments are untrusted input and they are not equal in authority. The
 * routed `projectId` says WHICH project is requested; `projects.workspace_id` —
 * read from the project row itself — says which workspace owns it. The routed
 * `workspaceId` is neither: it is an assertion about that ancestry, and
 * `resolveRoutedProject` refuses when it disagrees rather than correcting the
 * URL. Correcting would render a project under a workspace id that does not own
 * it, and would let a caller learn a project's real workspace by watching the
 * address change.
 *
 * WHAT THIS REPLACES — TWO DEFECTS, NOT ONE
 * ----------------------------------------
 * 1. `resolveCanonicalProject(project.workspace_id, id)`. It listed the
 *    workspace's fifty most recent projects and, when the requested id was not
 *    among them, redirected to the FIRST one. On an explicit entity route that is
 *    not recovery, it is substitution — project A becoming project B — and it
 *    fired for real on any workspace holding more than fifty projects, where a
 *    perfectly valid id simply fell off the end of the list. There is no fallback
 *    on this path at all.
 *
 * 2. `resolvePreferredWorkspace(user.id)` decided `canCreateTask`. That is the
 *    COOKIE, and this page is about a project in whatever workspace actually owns
 *    it. When the two differed the page authorized one workspace and gated its
 *    controls against another: a PM in the project's workspace could be shown a
 *    viewer's screen, and a viewer there a PM's, purely because of where they had
 *    last been. The role now comes from the same verdict that established the
 *    parent, so the two cannot disagree.
 *
 * `resolveRoutedProject`'s three outcomes are load-bearing:
 *
 *   granted  — authorized, project and workspace both active (or `completed`,
 *              which is a normal mutable state, not archival).
 *   archived — authorized, but the project and/or its workspace is archived. NOT
 *              an access failure: §7 requires last-known data to stay visible
 *              with the state explained. No control changes — the archived-project
 *              task refusal already lives in `POST /api/execution-tasks`.
 *   denied   — absent, deleted, unauthorized, or an ancestry mismatch. One
 *              indistinguishable reply, so the route cannot be used to probe
 *              which project ids exist (§7).
 */
export default async function ProjectHomePage({ params }: Props) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId, projectId: requestedProjectId } = await params;

  const access = await resolveRoutedProject(user.id, requestedWorkspaceId, requestedProjectId);
  if (access.access === "denied") {
    console.error(
      JSON.stringify({
        event: "project_home.project_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
        requestedProjectId,
      }),
    );
    return <ProjectNotAvailable />;
  }

  // From here the workspace is the AUTHORITATIVE one derived from
  // `projects.workspace_id`, never the routed segment — which by now has been
  // proven equal to it anyway. Every read below is scoped by it AND by the exact
  // project id.
  const { workspaceId, projectId } = access;

  // The capability layer still runs, unchanged, on the authorized workspace. The
  // routed resolver decides ROUTE IDENTITY; this decides policy, and both must
  // hold. Passing `access.workspaceId` rather than the segment is what keeps the
  // two asking about the same tenant.
  await evaluateCapabilityAccess({ workspaceId, projectId, permission: "read" });

  const supabase = await createSupabaseServerClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, workspace_id, pmo_id, name, description, status, methodology, icon, color")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  // Authorized a moment ago but unreadable now: deleted in between, or hidden by
  // RLS. Same refusal, same wording — there is nothing safe to say beyond it.
  if (!project) return <ProjectNotAvailable />;

  // The breadcrumb's Workspace label. `07-route…` §2's layout chain for this
  // route is "Authenticated Shell → Workspace → Project", so the trail leads
  // with the workspace — not with the generic `/pmos` chooser the legacy screen
  // led with, which was only ever there because no Workspace Home existed to
  // point at before PR #608.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .maybeSingle<{ id: string; name: string }>();

  // PMO ancestry, when there is any. `projects.pmo_id` is NULLABLE, so a direct
  // project has no PMO node and none is fabricated for it — a middle crumb
  // invented for an unassigned project would assert a governance structure the
  // project is not in.
  //
  // Scoped by the AUTHORIZED workspace as well as the id: the FK on `pmo_id`
  // constrains it to a real PMO but not to a PMO in this project's workspace, and
  // a breadcrumb is not the place to discover cross-tenant data. A PMO that does
  // not answer inside this workspace simply yields no ancestry node, rather than a
  // link into a workspace this route never authorized.
  const { data: pmo } = project.pmo_id
    ? await supabase
        .from("pmos")
        .select("id, name, icon")
        .eq("id", project.pmo_id)
        .eq("workspace_id", workspaceId)
        .maybeSingle<{ id: string; name: string; icon: string | null }>()
    : { data: null };

  // Real membership role in the PROJECT'S workspace drives whether the task CTAs
  // render — a viewer sees who can add work instead of a dead-end button. Server
  // actions, `requireProjectAccess` and RLS remain the authoritative enforcement;
  // this only decides what is worth offering.
  const canCreateTask = access.role !== null && access.role !== "viewer";

  const { data: analyses } = await supabase
    .from("onboarding_analyses")
    .select("id, analysis, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(10);

  return (
    <main className="rounded-3xl border border-slate-200 bg-white p-8 shadow-2xl backdrop-blur-xl md:p-10 space-y-6">
      <div>
        {/* Workspace → [PMO when assigned] → Project. The trail tells the truth
            about ANCESTRY, which can include a PMO; the ROUTE is still
            Workspace → Project, because `workspace_id` is the mandatory FK and
            `pmo_id` is not (`03-canonical-information-architecture.md` §5.7). */}
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-800">
          <Link href={workspaceHomePath(workspaceId)} className="hover:text-cyan-900">
            {workspace?.name ?? "Workspace"}
          </Link>
          {pmo ? (
            <>
              {" / "}
              <Link href={pmoHomePath(workspaceId, pmo.id)} className="hover:text-cyan-900">
                {pmo.icon ? `${pmo.icon} ` : ""}
                {pmo.name}
              </Link>
            </>
          ) : null}
          {" / "}
          {project.name}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {project.icon ? <span className="mr-2">{project.icon}</span> : null}
          {project.name}
        </h1>
        <p className="mt-2 text-sm text-slate-700">{project.description ?? "No description provided."}</p>
        <p className="mt-2 text-xs uppercase tracking-wide text-slate-600">
          Status: {project.status}
          {project.methodology ? ` · Methodology: ${project.methodology}` : ""}
        </p>
        <div className="mt-4">
          <ProjectTabNav workspaceId={workspaceId} projectId={project.id} active="overview" />
        </div>
      </div>

      {access.access === "archived" ? <ProjectArchivedNotice archived={access.archived} /> : null}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Execution</h2>
        <ProjectTaskList projectId={project.id} canCreateTask={canCreateTask} />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Run PMFreak AI</h2>
          <Link
            href={`/upload?projectId=${encodeURIComponent(project.id)}`}
            className="rounded-xl border border-cyan-300/50 px-4 py-2 text-sm font-semibold text-cyan-900 hover:bg-cyan-500/10"
          >
            Upload documents for this project
          </Link>
        </div>
        <form action="/api/analyze-ai" method="post" className="mt-3 space-y-3">
          <input type="hidden" name="projectId" value={project.id} />
          <input name="projectName" defaultValue={project.name} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
          <textarea name="extractedScopeText" required placeholder="Paste scope text to analyze" rows={6} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
          <button type="submit" className="rounded-xl border border-cyan-300/50 px-4 py-2 text-sm font-semibold">Analyze</button>
        </form>
      </section>

      <ProjectPMAssignment projectId={project.id} />

      <section>
        <h2 className="text-lg font-semibold">Previous analyses</h2>
        <ul className="mt-3 space-y-3">
          {(analyses ?? []).length === 0 ? <li className="text-sm text-slate-700">No analyses yet for this project.</li> : null}
          {(analyses ?? []).map((row) => (
            <li key={row.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-600">{new Date(row.created_at).toLocaleString()}</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{row.analysis}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
