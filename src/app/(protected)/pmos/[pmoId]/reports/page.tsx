import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { getPmoById } from "@/lib/pmos/pmo-service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PmoTabNav } from "../pmo-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pmoId: string }> };

/**
 * PMO Reports — portfolio state for this PMO's projects, with links into the
 * workspace-level executive reporting surfaces.
 */
export default async function PmoReportsPage({ params }: Props) {
  const user = await requireAuthUser();
  const { pmoId } = await params;

  const resolution = await resolvePreferredWorkspace(user.id);
  if (!resolution.workspaceId) notFound();

  const pmo = await getPmoById(resolution.workspaceId, pmoId);
  if (!pmo) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: projectRows } = await supabase
    .from("projects")
    .select("id, name, status")
    .eq("workspace_id", resolution.workspaceId)
    .eq("pmo_id", pmo.id);
  const projects = projectRows ?? [];
  const projectIds = projects.map((p) => p.id);

  let openRisks = 0;
  let openIssues = 0;
  if (projectIds.length > 0) {
    const { data: raidRows } = await supabase
      .from("raid_items")
      .select("project_id, category, status")
      .eq("workspace_id", resolution.workspaceId)
      .in("project_id", projectIds)
      .limit(500);
    for (const item of raidRows ?? []) {
      if (item.status === "closed" || item.status === "resolved") continue;
      if (item.category === "risk") openRisks += 1;
      if (item.category === "issue") openIssues += 1;
    }
  }

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          <Link href="/pmos" className="hover:text-cyan-900">PMOs</Link> / <Link href={`/pmos/${pmo.id}`} className="hover:text-cyan-900">{pmo.name}</Link> / Reports
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
          {pmo.name} — Reports
        </h1>
        <div className="mt-4">
          <PmoTabNav workspaceId={resolution.workspaceId} pmoId={pmo.id} active="reports" />
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Projects", value: projects.length, tone: "text-cyan-800" },
          { label: "Active", value: projects.filter((p) => p.status === "active").length, tone: "text-emerald-800" },
          { label: "Open risks", value: openRisks, tone: "text-amber-800" },
          { label: "Open issues", value: openIssues, tone: "text-rose-800" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{stat.label}</p>
            <p className={`mt-1 text-lg font-semibold ${stat.tone}`}>{stat.value}</p>
          </div>
        ))}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">Executive reporting</h2>
        <p className="mt-1 text-sm text-slate-600">
          Full executive report generation lives in the workspace reporting suite; ask this PMO&apos;s chat for a scoped summary at any time.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <Link href={`/pmos/${pmo.id}/chat`} className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.1] px-3.5 py-2 font-semibold text-cyan-900 hover:bg-cyan-400/[0.16]">Generate scoped report in PMO chat</Link>
          <Link href="/pmo-executive-reporting" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">Workspace executive reporting</Link>
        </div>
      </section>
    </main>
  );
}
