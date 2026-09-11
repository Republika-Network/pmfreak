import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { EmptyProjects } from "@/components/pmfreak/empty-states";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { projectHomePath } from "@/lib/projects/project-paths";
import { createProjectAction } from "./actions";

type ProjectRow = {
  id: string;
  /**
   * The project's own parent workspace. Selected so each row can link straight
   * into canonical Project Home without a redirect hop and WITHOUT consulting
   * the preferred-workspace cookie: `projects.workspace_id` is NOT NULL and is
   * the authority for the project's parent, so the row already carries the one
   * value the canonical path needs. Resolving a workspace separately here would
   * be asking a cookie a question this row already answers, and would answer it
   * wrongly for any project outside the caller's preferred workspace.
   */
  workspace_id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
};

export default async function ProjectsPage() {
  const user = await requireAuthUser();
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase
    .from("projects")
    .select("id, workspace_id, name, description, status, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  const projects = (data ?? []) as ProjectRow[];

  // Real membership role drives which CTAs render — a viewer is shown who
  // can create instead of a button they cannot use. Server actions and RLS
  // remain the authoritative enforcement.
  const workspaceResolution = await resolvePreferredWorkspace(user.id);
  const canCreateProjects = workspaceResolution.role !== null && workspaceResolution.role !== "viewer";

  return (
    <section className="space-y-6 rounded-3xl border border-slate-200 bg-[#FCFBF9] p-6 md:p-10">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 md:p-8">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">Projects</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 md:text-4xl">Projects</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-600">
          Every project you connect becomes an operational context: PMFreak tracks its execution
          signals, memory, risks, and follow-ups from the data your team generates.
        </p>
        <Link
          href="/command-center"
          className="mt-4 inline-block text-xs font-semibold uppercase tracking-[0.18em] text-cyan-800 transition hover:text-cyan-900"
        >
          View command center →
        </Link>
      </header>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 md:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Operational Contexts</p>
            <h2 className="mt-1 text-2xl font-semibold text-slate-900">Your Projects</h2>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="mt-6">
            <EmptyProjects canCreate={canCreateProjects} />
          </div>
        ) : (
          <>
        {canCreateProjects && (
        <form action={createProjectAction} className="mt-6 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-[1.2fr_1.8fr_auto] md:items-end">
          <label className="space-y-1.5 text-xs uppercase tracking-[0.14em] text-slate-500">
            Project Name
            <input name="name" required placeholder="ERP Phase 2 rollout" className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70" />
          </label>
          <label className="space-y-1.5 text-xs uppercase tracking-[0.14em] text-slate-500">
            Operational Scope
            <input name="description" placeholder="Sponsor expectations, major dependencies, timeline pressure" className="block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70" />
          </label>
          <button type="submit" className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800">Create Project</button>
        </form>
        )}

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {projects.map((project) => (
            <Link key={project.id} href={projectHomePath(project.workspace_id, project.id)} className="group rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-cyan-200/50">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">Project</p>
              <h3 className="mt-1 text-lg font-semibold text-cyan-900 group-hover:text-cyan-950">{project.name}</h3>
              {project.description && (
                <p className="mt-1 line-clamp-2 text-sm text-slate-600">{project.description}</p>
              )}
              <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-slate-500">{project.status} · Created {new Date(project.created_at).toLocaleDateString()}</p>
            </Link>
          ))}
        </div>
          </>
        )}
      </section>
    </section>
  );
}
