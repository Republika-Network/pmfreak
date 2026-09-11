import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveRoutedPmo } from "@/lib/pmos/routed-pmo";
import { pmoCommandCenterBreadcrumb, pmoCommandCenterPath } from "@/lib/pmos/pmo-command-center-paths";
import { pmoHomePath } from "@/lib/pmos/pmo-paths";
import { PmoNotAvailable } from "@/components/pmfreak/pmos/pmo-route-states";
import {
  pmoProjectsQuery,
  pmoRaidQuery,
  runPmoScopedQuery,
  selectPmoProjects,
  selectPmoRaid,
  summarizeOpenRaid,
  summarizePmoProjects,
  type PmoProjectRow,
  type PmoRaidRow,
} from "@/lib/pmos/pmo-command-center-rollup";
import type { PmoStatus, PmoType } from "@/lib/db/database-contract";

export const dynamic = "force-dynamic";

/**
 * PMO Command Center — the canonical, entity-qualified route.
 *
 * `07-route-layout-and-navigation-architecture.md` §2 names this path. It is a
 * genuine PMO projection: a read-only rollup over the PMO's own descendants,
 * per `03-canonical-information-architecture.md` §11 ("Portfolio/Program/Project
 * health rollup for the PMO").
 *
 * WHAT THIS SCREEN IS NOT
 * -----------------------
 * It is not `/pm-operations`, the internal PM-operations dashboard, which
 * aggregates a workspace's PROJECT MANAGERS, takes no `pmoId`, and never reads
 * the `pmos` table. It is not `/pmo-command-center`, which is that dashboard's
 * compatibility redirect. And it is not the Workspace Command Center with a new
 * label — none of that screen's cross-PMO aggregates appear here, because
 * ADR-PMF-020 forbids a Command Center widget from reading outside its own
 * entity's descendant scope.
 *
 * WHY THE PMO ID IS AUTHORIZED AND THE WORKSPACE ID IS ONLY A CLAIM
 * ----------------------------------------------------------------
 * Both segments are untrusted input, but they are not equal in authority. The
 * routed `pmoId` says WHICH PMO is requested; `pmos.workspace_id` — read from
 * the PMO row itself — says which workspace owns it. The routed `workspaceId`
 * is neither: it is an assertion about that ancestry, and `resolveRoutedPmo`
 * refuses when it disagrees rather than correcting the URL. Correcting would
 * render a PMO under a workspace id that does not own it, and would let a
 * caller learn a PMO's real workspace by watching the address change.
 *
 * The resolver has no fallback of any kind — no preferred PMO, no first PMO in
 * the workspace, and no preferred-workspace cookie. Its three outcomes are
 * load-bearing:
 *
 *   granted  — authorized, PMO and workspace both active. Full screen.
 *   archived — authorized, but the PMO and/or its workspace is archived. NOT an
 *              access failure: `07-route…` §7 requires last-known data to stay
 *              visible with mutations withheld and explained.
 *   denied   — absent, deleted, unauthorized, or an ancestry mismatch. One
 *              indistinguishable reply, so the route cannot be used to probe
 *              which PMO ids exist (§7).
 *
 * Slice 1 is READ-ONLY. There is no mutation on this screen and no server
 * action behind it, so "withhold mutations when archived" is satisfied by
 * construction rather than by disabling controls in name only.
 */

type PmoIdentityRow = {
  id: string;
  name: string;
  description: string | null;
  pmo_type: PmoType;
  icon: string | null;
  color: string | null;
  status: PmoStatus;
};

const PMO_IDENTITY_COLUMNS = "id, name, description, pmo_type, icon, color, status";

const PMO_TYPE_LABELS: Record<PmoType, string> = {
  company_pmo: "Company PMO",
  team_portfolio: "Team portfolio",
  independent: "Independent",
  client_portfolio: "Client portfolio",
  improvement_program: "Improvement program",
  personal: "Personal",
};

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="space-y-5">{children}</main>;
}

/**
 * The refusal lives in `@/components/pmfreak/pmos/pmo-route-states` now, shared
 * with the four PMO surfaces this slice added and the four legacy resolvers that
 * strangle their old routes. Nine copies of "this PMO isn't available to you" is
 * nine chances for one of them to differ, and a refusal that differs between
 * surfaces is itself a signal about the PMO. One component, one wording.
 */

function Breadcrumb({ workspaceId, pmoName, pmoId }: { workspaceId: string; pmoName: string; pmoId: string }) {
  const nodes = pmoCommandCenterBreadcrumb({ workspaceLabel: "Workspace", workspaceId, pmoName, pmoId });
  return (
    <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.24em] text-cyan-800">
      {nodes.map((node, index) => (
        <span key={node.label}>
          {index > 0 ? <span className="text-slate-400"> / </span> : null}
          {node.href === null ? (
            // Terminal node. `03-navigation-contracts.md` §2.3 rule 4: an
            // entity-qualified Command Center is where a trail ends, so it is
            // never a link to somewhere else.
            <span aria-current="page" className="text-slate-700">
              {node.label}
            </span>
          ) : (
            <Link href={node.href} className="hover:text-cyan-900">
              {node.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}

function PmoHeader({ workspaceId, pmo }: { workspaceId: string; pmo: PmoIdentityRow }) {
  return (
    <header
      className="rounded-3xl border border-slate-200 bg-white p-6"
      style={{ borderTopColor: pmo.color ?? undefined, borderTopWidth: pmo.color ? 3 : undefined }}
    >
      <Breadcrumb workspaceId={workspaceId} pmoName={pmo.name} pmoId={pmo.id} />
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
        <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
        {pmo.name} — PMO Command Center
      </h1>
      {pmo.description ? <p className="mt-2 max-w-3xl text-sm text-slate-700">{pmo.description}</p> : null}
      <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
        {PMO_TYPE_LABELS[pmo.pmo_type]} · {pmo.status === "archived" ? "Archived" : "Active"}
      </p>
    </header>
  );
}

export default async function PmoCommandCenterPage({
  params: routeParams,
}: {
  params: Promise<{ workspaceId: string; pmoId: string }>;
}) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId, pmoId: requestedPmoId } = await routeParams;

  const access = await resolveRoutedPmo(user.id, requestedWorkspaceId, requestedPmoId);

  if (access.access === "denied") {
    console.error(
      JSON.stringify({
        event: "pmo_command_center.pmo_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
        requestedPmoId,
      }),
    );
    return <PmoNotAvailable />;
  }

  // From here the workspace is the AUTHORITATIVE one derived from
  // `pmos.workspace_id`, never the routed segment — which by now has been
  // proven equal to it anyway.
  const { workspaceId, pmoId } = access;
  const isArchived = access.access === "archived";
  const supabase = await createSupabaseServerClient();

  // Identity is read with the caller's own client, so RLS applies, and scoped by
  // BOTH ids so it can never return another workspace's row. Deliberately not
  // `getPmoById`, which collapses a query error into `null`: this screen has to
  // tell "we could not load it" apart from "it is not yours", and a service that
  // returns null for both cannot support that distinction.
  const { data: pmo, error: pmoError } = await supabase
    .from("pmos")
    .select(PMO_IDENTITY_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", pmoId)
    .maybeSingle<PmoIdentityRow>();

  if (pmoError) {
    console.error(
      JSON.stringify({
        event: "pmo_command_center.pmo_unavailable",
        workspaceId,
        pmoId,
        reason: pmoError.message,
      }),
    );
    return (
      <Shell>
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
          <p className="text-sm font-semibold text-amber-900">We couldn&apos;t load this PMO</p>
          <p className="mt-1 text-xs text-amber-700/80">
            This is a temporary problem reading your workspace, not a permissions issue. Nothing has been
            changed or lost. Please try again in a moment.
          </p>
          <a
            href={pmoCommandCenterPath(workspaceId, pmoId)}
            className="mt-3 inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Try again
          </a>
        </div>
      </Shell>
    );
  }

  // Authorized a moment ago but unreadable now: deleted in between, or hidden by
  // RLS. Same refusal, same wording — there is nothing safe to say beyond it.
  if (!pmo) return <PmoNotAvailable />;

  // ── Panel 1: the PMO's own projects ────────────────────────────────────────
  const projectsResult = await runPmoScopedQuery<PmoProjectRow>(
    supabase,
    pmoProjectsQuery(workspaceId, pmoId),
  );

  // A failed projects read is "we could not load them", not "there are none".
  // Falling through to the empty state would tell an established PMO it has no
  // portfolio — a false claim about their data, and the primary projection of
  // this screen, so it is fatal rather than degraded.
  if (projectsResult.error) {
    console.error(
      JSON.stringify({
        event: "pmo_command_center.projects_unavailable",
        workspaceId,
        pmoId,
        reason: projectsResult.error.message,
      }),
    );
    return (
      <Shell>
        <PmoHeader workspaceId={workspaceId} pmo={pmo} />
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
          <p className="text-sm font-semibold text-amber-900">We couldn&apos;t load this PMO&apos;s projects</p>
          <p className="mt-1 text-xs text-amber-700/80">
            This is a temporary problem reading your workspace, not a permissions issue. Nothing has been
            changed or lost. Please try again in a moment.
          </p>
          <a
            href={pmoCommandCenterPath(workspaceId, pmoId)}
            className="mt-3 inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Try again
          </a>
        </div>
      </Shell>
    );
  }

  const projects = selectPmoProjects(projectsResult.data ?? [], pmoId);
  const rollup = summarizePmoProjects(projects);
  const projectIds = projects.map((project) => project.id);

  // ── Panel 2: open RAID across those projects ───────────────────────────────
  // Secondary and non-fatal: the portfolio above stands on its own, so a RAID
  // failure degrades this one strip and says so, rather than taking down the
  // screen. It must never silently render "0 open risks", which would assert a
  // count we do not have.
  const raidQuery = pmoRaidQuery(workspaceId, projectIds);
  let raid: { openRisks: number; openIssues: number } | null = { openRisks: 0, openIssues: 0 };
  if (raidQuery) {
    const raidResult = await runPmoScopedQuery<PmoRaidRow>(supabase, raidQuery);
    if (raidResult.error) {
      console.error(
        JSON.stringify({
          event: "pmo_command_center.raid_unavailable",
          workspaceId,
          pmoId,
          reason: raidResult.error.message,
        }),
      );
      raid = null;
    } else {
      raid = summarizeOpenRaid(selectPmoRaid(raidResult.data ?? [], projectIds));
    }
  }

  return (
    <Shell>
      <PmoHeader workspaceId={workspaceId} pmo={pmo} />

      {isArchived ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
          <p className="text-sm font-semibold text-amber-900">
            {access.archived.pmo && access.archived.workspace
              ? "This PMO and its workspace are archived"
              : access.archived.pmo
                ? "This PMO is archived"
                : "This PMO's workspace is archived"}
          </p>
          <p className="mt-1 text-xs text-amber-700/80">
            You still have access to it, and everything below is its last-known state. Changes are turned
            off while it stays archived — nothing here has been deleted, and restoring it restores the full
            PMO Command Center.
          </p>
        </div>
      ) : null}

      {projects.length === 0 ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900">No projects in this PMO yet</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-700">
            {isArchived
              ? "This PMO had no projects when it was archived."
              : "This PMO Command Center reports on the projects this PMO governs. Once projects are assigned to it, their status and open risks and issues appear here."}
          </p>
          {isArchived ? null : (
            <Link
              href={pmoHomePath(workspaceId, pmoId)}
              className="mt-4 inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Open PMO home
            </Link>
          )}
        </section>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-4">
            {[
              { label: "Projects in this PMO", value: rollup.total, tone: "text-slate-900" },
              { label: "Active", value: rollup.active, tone: "text-emerald-800" },
              { label: "Completed", value: rollup.completed, tone: "text-cyan-800" },
              { label: "Archived", value: rollup.archived, tone: "text-zinc-700" },
            ].map((stat) => (
              <div key={stat.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{stat.label}</p>
                <p className={`mt-1 text-lg font-semibold ${stat.tone}`}>{stat.value}</p>
              </div>
            ))}
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-slate-900">Open risks and issues</h2>
            {raid === null ? (
              <p className="mt-2 text-sm text-slate-600">
                Open risks and issues are temporarily unavailable. The projects below are unaffected.
              </p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Open risks</p>
                  <p className="mt-1 text-lg font-semibold text-amber-800">{raid.openRisks}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Open issues</p>
                  <p className="mt-1 text-lg font-semibold text-red-800">{raid.openIssues}</p>
                </div>
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Across the {rollup.total} project{rollup.total === 1 ? "" : "s"} this PMO governs.
            </p>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-slate-900">Portfolio</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {projects.map((project) => (
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
              ))}
            </div>
          </section>
        </>
      )}
    </Shell>
  );
}
