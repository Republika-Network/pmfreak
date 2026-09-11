"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { parseCanonicalPmoRoute, pmoHomePath, PMOS_NAV_HREF } from "@/lib/pmos/pmo-paths";
import { parseCanonicalProjectRoute, projectHomePath } from "@/lib/projects/project-paths";

type TreeProject = {
  id: string;
  /**
   * The project's own parent workspace, from its `projects` row via
   * `GET /api/pmos`. Deliberately not the shell's current workspace and not the
   * PMO's: a project's link must be a property of the project, the same rule the
   * PMO links below already follow.
   */
  workspace_id: string;
  name: string;
  status: string;
};
type TreePmo = {
  id: string;
  /**
   * The PMO's own parent workspace, from its `pmos` row via `GET /api/pmos`.
   * Deliberately not the shell's current workspace: a PMO's link must be a
   * property of the PMO, not of where the viewer happens to be standing.
   */
  workspace_id: string;
  name: string;
  icon: string | null;
  color: string | null;
  status: string;
  projects: TreeProject[];
};

/**
 * Workspace → PMO → Project navigation tree (sidebar).
 * PMOs are never mixed with projects: each PMO is a group with its own
 * nested project list. Scales to many PMOs via per-group collapse.
 */
export function SidebarPmoTree({
  workspaceId,
  activeProjectId,
  onSelectProject,
}: {
  /**
   * The workspace this shell is RENDERING — the one the protected layout
   * authorized, which on a canonical route is the workspace named in the URL and
   * not the preferred-workspace cookie's.
   *
   * Without it `GET /api/pmos` answers from that cookie, and on
   * `/workspaces/B/projects/P` the tree came back holding workspace A's rows: the
   * routed project was absent so no row could light, and every PMO and project
   * link below pointed back into A. The tree is the navigation surface — chrome
   * that disagrees with the page it wraps sends people out of the workspace they
   * deliberately opened.
   *
   * It is only a SCOPE, never an authorization: the handler authorizes the id it
   * is given, and RLS admits rows only for workspaces the caller belongs to, so
   * passing one here can narrow the answer and can never widen it.
   */
  workspaceId?: string;
  activeProjectId?: string;
  onSelectProject?: (projectId: string) => void;
}) {
  const pathname = usePathname();
  const [pmos, setPmos] = useState<TreePmo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch(
          workspaceId ? `/api/pmos?workspaceId=${encodeURIComponent(workspaceId)}` : "/api/pmos",
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { pmos?: TreePmo[] };
        if (active) setPmos(data.pmos ?? []);
      } catch {
        if (active) setPmos([]);
      } finally {
        if (active) setLoaded(true);
      }
    }
    void load();
    return () => { active = false; };
    // Refetch when the rendered workspace changes as well as on navigation:
    // moving between two workspaces' canonical routes must reload the tree, not
    // keep showing the first one's PMOs.
  }, [pathname, workspaceId]);

  const routedPmo = parseCanonicalPmoRoute(pathname);
  // Which project the viewer is actually on, when they are on a canonical
  // Project route. The legacy `/projects/<id>` prefix test below stays as well,
  // because that path is still routable while it drains.
  const routedProject = parseCanonicalProjectRoute(pathname);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between px-1">
        <p className="text-[9px] uppercase tracking-[0.28em] text-zinc-400">PMOs</p>
        <Link href={PMOS_NAV_HREF} className="text-[10px] font-semibold text-cyan-300/80 hover:text-cyan-800" title="Create or manage PMOs">
          + New PMO
        </Link>
      </div>

      {!loaded ? (
        <p className="px-1 text-[11px] text-zinc-400">Loading…</p>
      ) : pmos.length === 0 ? (
        <Link href={PMOS_NAV_HREF} className="block rounded-lg border border-dashed border-slate-200 px-2.5 py-2 text-[11px] text-slate-600 hover:border-cyan-300/40 hover:text-cyan-800">
          Create your first PMO
        </Link>
      ) : (
        <div className="space-y-1.5">
          {pmos.map((pmo) => {
            const isCollapsed = collapsed[pmo.id] ?? false;
            // Active on ANY of this PMO's canonical surfaces — Home, Chat,
            // Reports, Settings or its Command Center. The parser answers that in
            // one call, where a `startsWith` on a home path would also have to
            // guess about the workspace segment.
            const pmoActive = routedPmo?.pmoId === pmo.id;
            return (
              <div key={pmo.id} className="rounded-lg border border-slate-200 bg-white">
                <div className="flex items-center gap-1 px-1.5 py-1">
                  <button
                    type="button"
                    aria-label={isCollapsed ? `Expand ${pmo.name}` : `Collapse ${pmo.name}`}
                    onClick={() => setCollapsed((s) => ({ ...s, [pmo.id]: !isCollapsed }))}
                    className="shrink-0 rounded px-1 text-[10px] text-zinc-500 hover:text-zinc-700"
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                  <Link
                    href={pmoHomePath(pmo.workspace_id, pmo.id)}
                    className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-xs ${pmoActive ? "text-cyan-900" : "text-slate-700 hover:text-slate-900"}`}
                    style={pmo.color ? { textShadow: `0 0 14px ${pmo.color}55` } : undefined}
                  >
                    <span className="mr-1">{pmo.icon ?? "🏛️"}</span>
                    {pmo.name}
                  </Link>
                  <Link
                    href={`/projects/new?pmoId=${pmo.id}`}
                    aria-label={`New project in ${pmo.name}`}
                    title={`New project in ${pmo.name}`}
                    className="shrink-0 rounded px-1 text-[11px] text-zinc-500 hover:text-cyan-800"
                  >
                    +
                  </Link>
                </div>
                {!isCollapsed ? (
                  <div className="space-y-0.5 pb-1.5 pl-6 pr-2">
                    {pmo.projects.length === 0 ? (
                      <p className="px-1 text-[10px] text-zinc-400">No projects</p>
                    ) : (
                      pmo.projects.map((project) => {
                        const isActive =
                          project.id === activeProjectId ||
                          routedProject?.projectId === project.id ||
                          pathname.startsWith(`/projects/${project.id}`);
                        return (
                          <Link
                            key={project.id}
                            href={projectHomePath(project.workspace_id, project.id)}
                            onClick={() => onSelectProject?.(project.id)}
                            className={`block truncate rounded px-1.5 py-1 text-[11px] transition-colors ${
                              isActive ? "bg-cyan-300/[0.08] text-cyan-900" : "text-slate-600 hover:bg-white hover:text-slate-800"
                            }`}
                          >
                            {project.name}
                          </Link>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
