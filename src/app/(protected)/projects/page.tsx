import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { EmptyProjects } from "@/components/pmfreak/empty-states";
import { getUserWorkspaces } from "@/lib/workspaces";
import { resolveCanonicalWorkspace } from "@/lib/workspaces/canonical-workspace-resolver";
import { readPreferredWorkspaceId } from "@/lib/workspaces/preferred-workspace";
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

/**
 * Projects of the SELECTED workspace — the one the preferred-workspace cookie
 * names, validated against real membership, or the canonical default when
 * nothing is selected (the same resolution as /team and the protected shell).
 *
 * PD-15: this used to list `projects.user_id = me` across every workspace, so
 * members saw only projects they had created themselves (a viewer saw none)
 * and the list ignored the selected workspace. Every member of a workspace may
 * read its projects (the projects select policy), so the list is the
 * workspace's projects, read with the user-scoped client: RLS stays the
 * enforcing boundary and a workspace the caller does not belong to yields no
 * rows. A selection that no longer resolves to an active membership is refused
 * rather than silently replaced by another workspace.
 */
export default async function ProjectsPage() {
  const user = await requireAuthUser();
  const supabase = await createSupabaseServerClient();

  const selectedWorkspaceId = await readPreferredWorkspaceId();
  const workspaceResolution = await resolveCanonicalWorkspace(user.id, selectedWorkspaceId);
  if ((selectedWorkspaceId && workspaceResolution.workspaceId !== selectedWorkspaceId) || !workspaceResolution.workspaceId) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-sm text-slate-800">{workspaceResolution.workspaceId ? "Your selected workspace is no longer available." : "No workspace found."}</p>
        <Link href="/workspaces" className="mt-3 inline-block rounded-xl border border-slate-200 px-3.5 py-2 text-sm text-slate-800 hover:border-cyan-300/40">Choose a workspace</Link>
      </section>
    );
  }
  const workspaceId = workspaceResolution.workspaceId;

  const [{ data }, workspaces] = await Promise.all([
    supabase
      .from("projects")
      .select("id, workspace_id, name, description, status, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false }),
    getUserWorkspaces(user.id),
  ]);

  const projects = (data ?? []) as ProjectRow[];
  const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name ?? "This workspace";

  // Real membership role drives which CTAs render — a viewer is shown who
  // can create instead of a button they cannot use. Server actions and RLS
  // remain the authoritative enforcement.
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
            <h2 className="mt-1 text-2xl font-semibold text-slate-900">Projects in <span data-testid="projects-workspace-name">{workspaceName}</span></h2>
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
