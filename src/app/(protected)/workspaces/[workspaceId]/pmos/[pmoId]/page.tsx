import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { getPmoById } from "@/lib/pmos/pmo-service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveRoutedPmo } from "@/lib/pmos/routed-pmo";
import { PMOS_NAV_HREF } from "@/lib/pmos/pmo-paths";
import { PmoArchivedNotice, PmoNotAvailable } from "@/components/pmfreak/pmos/pmo-route-states";
import { PmoTabNav } from "./pmo-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ workspaceId: string; pmoId: string }> };

/**
 * PMO Home — the canonical, entity-qualified route.
 *
 * Portfolio summary for one PMO: its projects, their states, and entry points
 * into the PMO's own Command Center, chat, reports and settings. The screen is
 * the one that shipped at `/pmos/[pmoId]`; what changed is WHO DECIDES which PMO
 * it is about.
 *
 * WHY THE PMO ID IS AUTHORIZED AND THE WORKSPACE ID IS ONLY A CLAIM
 * ----------------------------------------------------------------
 * Both segments are untrusted input and they are not equal in authority. The
 * routed `pmoId` says WHICH PMO is requested; `pmos.workspace_id` — read from the
 * PMO row itself — says which workspace owns it. The routed `workspaceId` is
 * neither: it is an assertion about that ancestry, and `resolveRoutedPmo` refuses
 * when it disagrees rather than correcting the URL. Correcting would render a PMO
 * under a workspace id that does not own it, and would let a caller learn a PMO's
 * real workspace by watching the address change.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The legacy `/pmos/[pmoId]` resolved its scope from the preferred-workspace
 * COOKIE and then looked the PMO up inside it, which had two consequences worth
 * naming because they are the reason for this slice:
 *
 *   1. the same PMO id resolved differently for the same user depending on which
 *      workspace they were last in — a link was not a link to one thing; and
 *   2. a PMO the caller was fully entitled to see 404'd whenever it lived
 *      outside their preferred workspace.
 *
 * `resolveRoutedPmo` has no fallback of any kind — no preferred PMO, no first PMO
 * in the workspace, no preferred-workspace cookie, and it never calls
 * `ensureDefaultPmo` to conjure one. Its three outcomes are load-bearing:
 *
 *   granted  — authorized, PMO and workspace both active.
 *   archived — authorized, but the PMO and/or its workspace is archived. NOT an
 *              access failure: `07-route…` §7 requires last-known data to stay
 *              visible with the state explained.
 *   denied   — absent, deleted, unauthorized, or an ancestry mismatch. One
 *              indistinguishable reply, so the route cannot be used to probe
 *              which PMO ids exist (§7).
 */
export default async function PmoHomePage({ params }: Props) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId, pmoId: requestedPmoId } = await params;

  const access = await resolveRoutedPmo(user.id, requestedWorkspaceId, requestedPmoId);
  if (access.access === "denied") {
    console.error(
      JSON.stringify({
        event: "pmo_home.pmo_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
        requestedPmoId,
      }),
    );
    return <PmoNotAvailable />;
  }

  // From here the workspace is the AUTHORITATIVE one derived from
  // `pmos.workspace_id`, never the routed segment — which by now has been proven
  // equal to it anyway. Every read below is scoped by it AND by the exact PMO id.
  const { workspaceId, pmoId } = access;

  const pmo = await getPmoById(workspaceId, pmoId);
  // Authorized a moment ago but unreadable now: deleted in between, or hidden by
  // RLS. Same refusal, same wording — there is nothing safe to say beyond it.
  if (!pmo) return <PmoNotAvailable />;

  const supabase = await createSupabaseServerClient();
  const { data: projectRows } = await supabase
    .from("projects")
    .select("id, name, description, status, icon, color, created_at")
    .eq("workspace_id", workspaceId)
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
              <Link href={PMOS_NAV_HREF} className="hover:text-cyan-900">PMOs</Link> / {pmo.name}
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
              {pmo.name}
            </h1>
            {pmo.description ? <p className="mt-2 max-w-3xl text-sm text-slate-700">{pmo.description}</p> : null}
          </div>
          <Link
            href={`/projects/new?pmoId=${encodeURIComponent(pmo.id)}`}
            className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.1] px-4 py-2.5 text-sm font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.16]"
          >
            New Project
          </Link>
        </div>
        <div className="mt-4">
          <PmoTabNav workspaceId={workspaceId} pmoId={pmo.id} active="home" />
        </div>
      </header>

      {access.access === "archived" ? <PmoArchivedNotice archived={access.archived} /> : null}

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
                href={`/projects/${encodeURIComponent(project.id)}`}
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
