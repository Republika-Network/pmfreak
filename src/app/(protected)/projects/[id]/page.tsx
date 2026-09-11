import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateCapabilityAccess } from "@/lib/security/capability-flow";
import { resolveCanonicalProject } from "@/lib/projects/canonical-project-resolver";
import { redirect } from "next/navigation";
import { ProjectPMAssignment } from "@/components/pmfreak/ProjectPMAssignment";
import { ProjectTaskList } from "@/components/pmfreak/tasks/project-task-list";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { ProjectTabNav } from "./project-tab-nav";
import { PMOS_NAV_HREF, pmoHomePath } from "@/lib/pmos/pmo-paths";

type Props = { params: Promise<{ id: string }> };

export default async function ProjectDetailPage({ params }: Props) {
  const user = await requireAuthUser();
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, workspace_id, pmo_id, name, description, status, methodology, icon, color")
    .eq("id", id)
    .maybeSingle();

  if (!project) notFound();

  // `workspace_id` is selected because the breadcrumb links to the PMO's
  // canonical Home, which is workspace-rooted. It comes from the PMO's own row —
  // the authority for its parent — not from the project's workspace and not from
  // the preferred-workspace cookie.
  const { data: pmo } = project.pmo_id
    ? await supabase.from("pmos").select("id, workspace_id, name, icon").eq("id", project.pmo_id).maybeSingle()
    : { data: null };

  const canonicalProject = await resolveCanonicalProject(project.workspace_id, id);
  if (canonicalProject.status === "invalid" && canonicalProject.projectId) {
    redirect(`/projects/${canonicalProject.projectId}?recoveredFrom=invalidProject`);
  }

  await evaluateCapabilityAccess({ workspaceId: project.workspace_id, projectId: project.id, permission: "read" });

  // Real membership role drives whether the task CTAs render — a viewer sees
  // who can add work instead of a dead-end button (same pattern as
  // src/app/(protected)/projects/page.tsx's canCreateProjects).
  const workspaceResolution = await resolvePreferredWorkspace(user.id);
  const canCreateTask = workspaceResolution.role !== null && workspaceResolution.role !== "viewer";

  const { data: analyses } = await supabase
    .from("onboarding_analyses")
    .select("id, analysis, created_at")
    .eq("project_id", id)
    .order("created_at", { ascending: false })
    .limit(10);

  return (
    <main className="rounded-3xl border border-slate-200 bg-white p-8 shadow-2xl backdrop-blur-xl md:p-10 space-y-6">
      <div>
        {pmo ? (
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-800">
            <Link href={PMOS_NAV_HREF} className="hover:text-cyan-900">PMOs</Link>
            {" / "}
            <Link href={pmoHomePath(pmo.workspace_id, pmo.id)} className="hover:text-cyan-900">{pmo.icon ? `${pmo.icon} ` : ""}{pmo.name}</Link>
            {" / "}
            {project.name}
          </p>
        ) : null}
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
          <ProjectTabNav projectId={project.id} active="overview" />
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Execution</h2>
        <ProjectTaskList projectId={project.id} canCreateTask={canCreateTask} />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Run PMFreak AI</h2>
          <Link
            href={`/upload?projectId=${project.id}`}
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
