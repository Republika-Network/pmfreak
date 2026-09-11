import Link from "next/link";
import { workspaceSurfacePath, type WorkspaceSurface } from "@/lib/workspaces/workspace-paths";

/**
 * The Workspace family's own section nav — the thing that makes Home, Command
 * Center and Settings read as three surfaces of ONE workspace rather than three
 * screens that happen to share a URL prefix.
 *
 * The Command Center entry is labeled "Workspace Command Center", not a bare
 * "Command Center". ADR-PMF-014 Rule 1 requires every user-facing appearance of
 * the phrase to name the entity it projects over, and Rule 3 blesses exactly this
 * "[Entity] Command Center" form as a navigation label — which also keeps it
 * visibly distinct from the PMO's, one level down.
 *
 * Rendered by Home and Settings. The Command Center does NOT mount it: that
 * screen shipped in PR #604 with its own chrome across five render branches, and
 * this slice is only allowed to close the family's navigation seams, not restyle
 * a shipped surface. Its ancestor link (`WorkspaceContextBanner`) now points at
 * Workspace Home, so the family is reachable from it in one hop.
 */
const TABS: readonly { label: string; surface: WorkspaceSurface }[] = [
  { label: "Overview", surface: "home" },
  { label: "Workspace Command Center", surface: "command-center" },
  { label: "Settings", surface: "settings" },
];

export function WorkspaceTabNav({
  workspaceId,
  active,
}: {
  /**
   * The AUTHORIZED workspace, as returned by `resolveRoutedWorkspace` — never the
   * raw routed segment and never the preferred-workspace cookie. Every call site
   * holds it because every call site authorized the route before rendering.
   */
  workspaceId: string;
  active: WorkspaceSurface;
}) {
  return (
    <nav aria-label="Workspace sections" className="flex flex-wrap gap-2">
      {TABS.map((tab) => {
        const isActive = active === tab.surface;
        return (
          <Link
            key={tab.label}
            href={workspaceSurfacePath(workspaceId, tab.surface)}
            className={`rounded-xl border px-3.5 py-2 text-sm transition ${
              isActive
                ? "border-cyan-300/50 bg-cyan-400/10 text-cyan-900"
                : "border-slate-200 bg-white text-slate-700 hover:border-slate-200"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
