import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { getPmoById, listPmosWithProjects } from "@/lib/pmos/pmo-service";
import { resolveRoutedPmo } from "@/lib/pmos/routed-pmo";
import { PMOS_NAV_HREF, pmoHomePath } from "@/lib/pmos/pmo-paths";
import { PmoArchivedNotice, PmoNotAvailable } from "@/components/pmfreak/pmos/pmo-route-states";
import { PmoAdminClient } from "@/components/pmfreak/pmos/pmo-admin-client";
import { PmoTabNav } from "../pmo-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ workspaceId: string; pmoId: string }> };

/**
 * PMO Settings — the canonical, entity-qualified route.
 *
 * Rename, retype, recolor, archive, duplicate or delete this PMO, plus entry
 * points for members, agents and templates. Authority model is PMO Home's.
 *
 * WHY A CANONICAL ROUTE PARAM CANNOT MUTATE PMO P THROUGH WORKSPACE W2
 * -------------------------------------------------------------------
 * Two independent gates, and the route controls neither of them:
 *
 *   1. `resolveRoutedPmo` refuses before this page renders unless the routed
 *      `workspaceId` IS `pmos.workspace_id`. A mismatch is denied, not corrected,
 *      so there is no "PMO P under workspace W2" state to act from.
 *   2. The mutations themselves do not take a workspace from the URL at all.
 *      `PmoAdminClient` calls `/api/pmos/[id]`, which derives the workspace from
 *      the PMO's own row and then requires pm-or-above membership in THAT
 *      workspace (`requireWorkspaceMinimumRole`, matching the "workspace managers
 *      can manage pmos" RLS policy). A caller who edits this page's URL changes
 *      nothing about which workspace their role is checked against.
 *
 * Role semantics are untouched: owner/admin/pm may manage PMOs, viewers may not,
 * and there is no PMO-level role anywhere in the schema to invent one from
 * (ADR-PMF-003).
 *
 * ARCHIVED
 * --------
 * An archived PMO still renders here, with its state stated rather than implied,
 * and with the same controls as before — including Restore, which IS the archive
 * control. Removing the admin panel from an archived PMO would remove the only
 * path back out of archival, which is why "read-only" is not applied literally to
 * this one surface.
 */
export default async function PmoSettingsPage({ params }: Props) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId, pmoId: requestedPmoId } = await params;

  const access = await resolveRoutedPmo(user.id, requestedWorkspaceId, requestedPmoId);
  if (access.access === "denied") {
    console.error(
      JSON.stringify({
        event: "pmo_settings.pmo_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
        requestedPmoId,
      }),
    );
    return <PmoNotAvailable />;
  }

  const { workspaceId, pmoId } = access;

  const pmo = await getPmoById(workspaceId, pmoId);
  if (!pmo) return <PmoNotAvailable />;

  // Scoped to the authoritative workspace and then narrowed to this PMO, so the
  // admin panel is handed exactly one row: the PMO named by the URL, never a
  // sibling and never the workspace's whole list.
  const allPmos = await listPmosWithProjects(workspaceId, { includeArchived: true });
  const thisPmo = allPmos.filter((p) => p.id === pmo.id);

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          <Link href={PMOS_NAV_HREF} className="hover:text-cyan-900">PMOs</Link> /{" "}
          <Link href={pmoHomePath(workspaceId, pmo.id)} className="hover:text-cyan-900">{pmo.name}</Link> / Settings
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
          {pmo.name} — Settings
        </h1>
        <div className="mt-4">
          <PmoTabNav workspaceId={workspaceId} pmoId={pmo.id} active="settings" />
        </div>
      </header>

      {access.access === "archived" ? <PmoArchivedNotice archived={access.archived} /> : null}

      <PmoAdminClient initialPmos={thisPmo} />

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">Administration</h2>
        <p className="mt-1 text-sm text-slate-600">Members, agents, and templates are managed at workspace level and apply to this PMO.</p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <Link href="/team" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">Invite members</Link>
          <Link href="/trust/agents" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">Manage agents</Link>
          <Link href="/operational-memory" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">Manage templates &amp; knowledge</Link>
        </div>
      </section>
    </main>
  );
}
