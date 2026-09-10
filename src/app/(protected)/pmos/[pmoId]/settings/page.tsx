import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { getPmoById, listPmosWithProjects } from "@/lib/pmos/pmo-service";
import { PmoAdminClient } from "@/components/pmfreak/pmos/pmo-admin-client";
import { PmoTabNav } from "../pmo-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ pmoId: string }> };

/**
 * PMO Settings — rename, retype, recolor, archive, duplicate or delete this
 * PMO, plus entry points for members, agents, and templates.
 */
export default async function PmoSettingsPage({ params }: Props) {
  const user = await requireAuthUser();
  const { pmoId } = await params;

  const resolution = await resolvePreferredWorkspace(user.id);
  if (!resolution.workspaceId) notFound();

  const pmo = await getPmoById(resolution.workspaceId, pmoId);
  if (!pmo) notFound();

  const allPmos = await listPmosWithProjects(resolution.workspaceId, { includeArchived: true });
  const thisPmo = allPmos.filter((p) => p.id === pmo.id);

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          <Link href="/pmos" className="hover:text-cyan-900">PMOs</Link> / <Link href={`/pmos/${pmo.id}`} className="hover:text-cyan-900">{pmo.name}</Link> / Settings
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
          {pmo.name} — Settings
        </h1>
        <div className="mt-4">
          <PmoTabNav workspaceId={resolution.workspaceId} pmoId={pmo.id} active="settings" />
        </div>
      </header>

      <PmoAdminClient initialPmos={thisPmo} />

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">Administration</h2>
        <p className="mt-1 text-sm text-slate-600">Members, agents, and templates are managed at workspace level and apply to this PMO.</p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <Link href="/team" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">Invite members</Link>
          <Link href="/trust/agents" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">Manage agents</Link>
          <Link href="/operational-memory" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">Manage templates & knowledge</Link>
        </div>
      </section>
    </main>
  );
}
