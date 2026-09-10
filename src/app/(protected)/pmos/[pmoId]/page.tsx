import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { getPmoById } from "@/lib/pmos/pmo-service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PmoTabNav } from "./pmo-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pmoId: string }> };

/**
 * PMO Overview — portfolio summary for one PMO: its projects, their states,
 * and entry points into the PMO's own chat, reports, and settings.
 */
export default async function PmoOverviewPage({ params }: Props) {
  const user = await requireAuthUser();
  const { pmoId } = await params;

  const resolution = await resolvePreferredWorkspace(user.id);
  if (!resolution.workspaceId) notFound();

  const pmo = await getPmoById(resolution.workspaceId, pmoId);
  if (!pmo) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: projectRows } = await supabase
    .from("projects")
    .select("id, name, description, status, icon, color, created_at")
    .eq("workspace_id", resolution.workspaceId)
    .eq("pmo_id", pmo.id)
    .order("created_at", { ascending: false });

  const projects = projectRows ?? [];
  const active = projects.filter((p) => p.status === "active").length;
  const completed = projects.filter((p) => p.status === "completed").length;
  const archived = projects.filter((p) => p.status === "archived").length;

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6" style={{ borderTopColor: pmo.color ?? undefined, borderTopWidth: pmo.color ? 3 : undefined }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
              <Link href="/pmos" className="hover:text-cyan-900">PMOs</Link> / {pmo.name}
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
              {pmo.name}
            </h1>
            {pmo.description ? <p className="mt-2 max-w-3xl text-sm text-slate-700">{pmo.description}</p> : null}
          </div>
          <Link
            href={`/projects/new?pmoId=${pmo.id}`}
            className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.1] px-4 py-2.5 text-sm font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.16]"
          >
            New Project
          </Link>
        </div>
        <div className="mt-4">
          <PmoTabNav workspaceId={resolution.workspaceId} pmoId={pmo.id} active="" />
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Active projects", value: active, tone: "text-emerald-800" },
          { label: "Completed", value: completed, tone: "text-cyan-800" },
          { label: "Archived", value: archived, tone: "text-zinc-700" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{stat.label}</p>
            <p className={`mt-1 text-lg font-semibold ${stat.tone}`}>{stat.value}</p>
          </div>
        ))}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">Portfolio</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {projects.length === 0 ? (
            <p className="text-sm text-slate-600 md:col-span-2">
              No projects in this PMO yet. Create the first one to activate its portfolio.
            </p>
          ) : (
            projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="group rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-cyan-200/35"
                style={{ borderLeftColor: project.color ?? undefined, borderLeftWidth: project.color ? 3 : undefined }}
              >
                <h3 className="text-base font-semibold text-cyan-900 group-hover:text-cyan-950">
                  {project.icon ? <span className="mr-2">{project.icon}</span> : null}
                  {project.name}
                </h3>
                <p className="mt-1 line-clamp-2 text-sm text-zinc-700">{project.description ?? "No description."}</p>
                <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">{project.status}</p>
              </Link>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
