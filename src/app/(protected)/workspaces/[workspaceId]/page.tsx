import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveRoutedWorkspace } from "@/lib/workspaces/routed-workspace";
import {
  WORKSPACES_NAV_HREF,
  workspaceCommandCenterPath,
  workspaceSettingsPath,
} from "@/lib/workspaces/workspace-paths";
import { listPmos } from "@/lib/pmos/pmo-service";
import { pmoHomePath } from "@/lib/pmos/pmo-paths";
import { projectHomePath } from "@/lib/projects/project-paths";
import { WorkspaceArchivedNotice, WorkspaceNotAvailable } from "@/components/pmfreak/workspace/workspace-route-states";
import { WorkspaceTabNav } from "./workspace-tab-nav";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ workspaceId: string }> };

/**
 * Workspace Home — the canonical, entity-qualified route, and the last member of
 * the Workspace family to exist.
 *
 * WHAT THIS SCREEN IS
 * -------------------
 * `03-canonical-information-architecture.md` §5.3 defines it precisely, and the
 * definition is the whole design: "the Workspace's landing screen — contains an
 * Overview, NOT a full Dashboard", whose children are "PMO Home(s), Direct
 * Projects list, Workspace Settings, Workspace Command Center" and whose exit
 * points are those same four. `03-screen-catalog.md` §4 adds the panels
 * (project-list, PMO-list), the count widgets, and names the empty state as "the
 * product's single most important" one.
 *
 * So this is a WAYFINDING screen: who is in this workspace, what is in it, and
 * where to go next. It is deliberately NOT a second operational dashboard. None
 * of the Command Center's widgets appear here — no health grid, no
 * recommendations, no activity feed, no `CommandCenterClient`. IA Principle 5
 * (One Entity One Home) is only worth anything if Home and Command Center stay
 * different screens; a Home that re-renders the Command Center's projections is
 * how an entity ends up with two homes and a PM ends up unsure which one is
 * current.
 *
 * Everything rendered below is data the product already stores and already reads
 * elsewhere: `pmos` rows for this workspace, and `projects` rows for this
 * workspace. Nothing is inferred, projected or scored.
 *
 * WHY THE WORKSPACE ID IS AUTHORIZED HERE AND NOT TRUSTED
 * ------------------------------------------------------
 * The routed segment is untrusted input (§5 rule 1). `resolveRoutedWorkspace` is
 * the authorization boundary: it authorizes the EXACT id it is given, or refuses,
 * and has no fallback of any kind — no preferred-workspace cookie, no "first
 * membership", no `ensureUserWorkspace`. A resolver that substituted another
 * workspace when the requested one was unusable would render workspace B's data
 * at workspace A's address, which is the one thing an entity-qualified route
 * exists to prevent.
 *
 * Its three outcomes are load-bearing, exactly as on the Command Center:
 *
 *   granted  — member, active workspace. Full screen.
 *   archived — member, archived workspace. NOT an access failure: §7 requires the
 *              viewer to keep seeing last-known data with mutations disabled and
 *              explained. Archived is never collapsed into missing.
 *   denied   — not a member, no such workspace, or deleted. One indistinguishable
 *              reply, so the route cannot be used to probe which ids exist (§7).
 */
export default async function WorkspaceHomePage({ params }: Props) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId } = await params;

  const access = await resolveRoutedWorkspace(user.id, requestedWorkspaceId);
  if (access.access === "denied") {
    console.error(
      JSON.stringify({
        event: "workspace_home.workspace_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
      }),
    );
    return <WorkspaceNotAvailable />;
  }

  // From here on, the AUTHORIZED id — never the raw segment it was proven equal
  // to, so a later edit cannot quietly start reading the untrusted one.
  const { workspaceId } = access;
  const isArchived = access.access === "archived";

  const supabase = await createSupabaseServerClient();

  // The workspace's own identity row. Read through the caller's client, so RLS
  // is the backstop on the read that `resolveRoutedWorkspace` already authorized.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .maybeSingle<{ id: string; name: string }>();

  // Authorized a moment ago but unreadable now: deleted in between, or hidden by
  // RLS. Same refusal, same wording — there is nothing safe to say beyond it.
  if (!workspace) return <WorkspaceNotAvailable />;

  // Deliberately non-fatal, and deliberately distinguishable from "none". The
  // PMO list throws on any Supabase error; a Home that swallowed that would tell
  // an established workspace it has no PMOs, which is a false claim about their
  // own data. A failure degrades one panel and says so.
  let pmos: Awaited<ReturnType<typeof listPmos>> | null = null;
  try {
    pmos = await listPmos(workspaceId);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "workspace_home.pmos_unavailable",
        workspaceId,
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  // Every project in this workspace, scoped by workspace_id. `pmo_id` is selected
  // because §5.3's children include a DIRECT Projects list — the projects this
  // workspace owns without a PMO between — and that distinction is exactly the
  // `pmo_id IS NULL` one. The counts below cover all of them; the panel shows the
  // direct ones, because the rest are already listed under their own PMO.
  const { data: projectRows, error: projectsError } = await supabase
    .from("projects")
    .select("id, name, status, pmo_id, icon, color")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (projectsError) {
    console.error(
      JSON.stringify({
        event: "workspace_home.projects_unavailable",
        workspaceId,
        reason: projectsError.message,
      }),
    );
  }

  const projects = projectRows ?? [];
  const directProjects = projects.filter((project) => !project.pmo_id);
  const projectsUnavailable = Boolean(projectsError);
  // A workspace is only "empty" when we actually READ that it is. A failed read
  // must never render §9's "No Projects yet" invitation at an established
  // workspace — that is the difference between "you have none" and "we could not
  // load yours".
  // `pmos !== null` is part of the test, not an afterthought: with the PMO read
  // failed we do not KNOW the workspace is empty, and inviting someone to create
  // their first PMO in a workspace that may already have several is the same
  // false claim in a friendlier voice.
  const isEmpty = !projectsUnavailable && projects.length === 0 && pmos !== null && pmos.length === 0;

  return (
    <main className="space-y-5">
      <header className="rounded-3xl border border-slate-200 bg-white p-6">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          <Link href={WORKSPACES_NAV_HREF} className="hover:text-cyan-900">Workspaces</Link> / {workspace.name}
        </p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{workspace.name}</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-700">
              This workspace holds your PMOs, and each PMO holds projects. Projects can also sit directly
              in the workspace.
            </p>
          </div>
          {/* §5.3 names "Open Workspace Command Center" as a primary action, and
              §2.3 rule 4 makes the Command Center a destination rather than an
              ancestor — so it is offered here as a forward action, and Home never
              appears beneath it in a trail. Withheld while archived: the Command
              Center's archived view is read-only, and offering it as the primary
              action of an archived workspace advertises an operations console
              that cannot be operated. */}
          {!isArchived ? (
            <Link
              href={workspaceCommandCenterPath(workspaceId)}
              className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.1] px-4 py-2.5 text-sm font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.16]"
            >
              Open Workspace Command Center
            </Link>
          ) : null}
        </div>
        <div className="mt-4">
          <WorkspaceTabNav workspaceId={workspaceId} active="home" />
        </div>
      </header>

      {isArchived ? <WorkspaceArchivedNotice /> : null}

      {/* The count widgets §4 of the screen catalog names. They say "we could not
          read this" rather than "0" when a read failed: a count is an assertion
          about the tenant's data, and asserting zero from an error is a lie the
          user has no way to detect. */}
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">PMOs</p>
          <p className="mt-1 text-lg font-semibold text-cyan-800">
            {pmos ? pmos.length : <span className="text-sm font-medium text-zinc-600">Temporarily unavailable</span>}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Projects</p>
          <p className="mt-1 text-lg font-semibold text-emerald-800">
            {projectsUnavailable ? (
              <span className="text-sm font-medium text-zinc-600">Temporarily unavailable</span>
            ) : (
              projects.length
            )}
          </p>
        </div>
      </section>

      {isEmpty ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900">No projects yet</h2>
          <p className="mt-1 text-sm text-slate-700">
            Create a project to get started. You can also create a PMO first if you want to group
            projects under a governance structure.
          </p>
          {/* Withheld while archived — see the Command Center's §7 treatment:
              an archived workspace cannot accept a new project, and offering the
              action anyway is an instruction that fails on arrival. */}
          {!isArchived ? (
            <div className="mt-3 flex flex-wrap gap-2 text-sm">
              <Link href="/projects/new" className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.1] px-3.5 py-2 font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.16]">
                Create Project
              </Link>
              <Link href="/create-command-center" className="rounded-xl border border-slate-200 px-3.5 py-2 text-slate-800 hover:border-cyan-300/40">
                Create PMO
              </Link>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">PMOs</h2>
        {pmos === null ? (
          <p className="mt-2 text-sm text-slate-600">
            We couldn&apos;t load this workspace&apos;s PMOs. This is a temporary problem reading your
            workspace, not a permissions issue, and nothing has been changed.
          </p>
        ) : pmos.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No PMOs in this workspace yet.</p>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {pmos.map((pmo) => (
              <li key={pmo.id}>
                {/* Drill-down into the canonical PMO family (PR #607), carrying the
                    authorized workspace so the child route never has to guess its
                    own ancestry. */}
                <Link
                  href={pmoHomePath(workspaceId, pmo.id)}
                  className="group block rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-cyan-200/35"
                  style={{ borderLeftColor: pmo.color ?? undefined, borderLeftWidth: pmo.color ? 3 : undefined }}
                >
                  <h3 className="text-base font-semibold text-cyan-900 group-hover:text-cyan-950">
                    <span className="mr-2">{pmo.icon ?? "🏛️"}</span>
                    {pmo.name}
                  </h3>
                  {pmo.description ? <p className="mt-1 line-clamp-2 text-sm text-zinc-700">{pmo.description}</p> : null}
                  <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">{pmo.status}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">Projects in this workspace</h2>
        <p className="mt-1 text-sm text-slate-600">
          Projects that sit directly in the workspace, without a PMO. Projects inside a PMO are listed
          on that PMO&apos;s own page.
        </p>
        {projectsUnavailable ? (
          <p className="mt-2 text-sm text-slate-600">
            We couldn&apos;t load this workspace&apos;s projects. This is a temporary problem, not a
            permissions issue, and nothing has been changed or lost.
          </p>
        ) : directProjects.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No projects sit directly in this workspace.</p>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {directProjects.map((project) => (
              <li key={project.id}>
                {/* Drill-down into the canonical Project family, carrying the
                    AUTHORIZED workspace — `access.workspaceId`, not the routed
                    segment and not a cookie — so the child route never has to
                    guess its own ancestry. These rows were read with
                    `.eq("workspace_id", workspaceId)`, so this workspace IS each
                    project's `projects.workspace_id`: the link states an ancestry
                    that is true by construction, which is why it needs no extra
                    lookup. (The note that used to sit here said this family was
                    not migrated yet. It is now.) */}
                <Link
                  href={projectHomePath(workspaceId, project.id)}
                  className="group block rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-cyan-200/35"
                  style={{ borderLeftColor: project.color ?? undefined, borderLeftWidth: project.color ? 3 : undefined }}
                >
                  <h3 className="text-base font-semibold text-cyan-900 group-hover:text-cyan-950">
                    {project.icon ? <span className="mr-2">{project.icon}</span> : null}
                    {project.name}
                  </h3>
                  <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">{project.status}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">Workspace settings</h2>
        <p className="mt-1 text-sm text-slate-600">
          Who is in this workspace, and where its administration lives.
        </p>
        <Link
          href={workspaceSettingsPath(workspaceId)}
          className="mt-3 inline-block rounded-xl border border-slate-200 px-3.5 py-2 text-sm text-slate-800 hover:border-cyan-300/40"
        >
          Open Workspace Settings
        </Link>
      </section>
    </main>
  );
}
