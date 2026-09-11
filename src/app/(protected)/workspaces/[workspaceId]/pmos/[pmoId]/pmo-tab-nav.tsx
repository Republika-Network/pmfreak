import Link from "next/link";
import { pmoSurfacePath, type PmoSurface } from "@/lib/pmos/pmo-paths";

/**
 * The PMO Command Center entry is labeled "PMO Command Center", not a bare
 * "Command Center". ADR-PMF-014 Rule 1 requires every user-facing appearance of
 * the phrase to name the entity it projects over, and Rule 3 blesses exactly
 * this "[Entity] Command Center" form as a navigation label. Sitting inside a
 * nav labeled "PMO sections" is context, not qualification — the rule is
 * literal and checkable on purpose, because "obvious from context" is how the
 * ambiguity accumulated in the first place.
 *
 * Every tab is now one row of the same canonical family. Before this slice only
 * the Command Center was workspace-rooted and the other four pointed back into
 * `/pmos/<id>/…`, so moving between tabs crossed in and out of legacy space —
 * and the legacy side could not say which workspace it was in. There is nothing
 * left in this nav that leaves `/workspaces/<workspaceId>/pmos/<pmoId>/`.
 */
const TABS: readonly { label: string; surface: PmoSurface }[] = [
  { label: "Overview", surface: "home" },
  { label: "PMO Command Center", surface: "command-center" },
  { label: "Chat", surface: "chat" },
  { label: "Reports", surface: "reports" },
  { label: "Settings", surface: "settings" },
];

export function PmoTabNav({
  workspaceId,
  pmoId,
  active,
}: {
  /**
   * The PMO's AUTHORITATIVE workspace — `pmos.workspace_id`, as returned by
   * `resolveRoutedPmo`, never the routed segment and never a preferred-workspace
   * cookie. Every call site holds it because every call site authorized this PMO
   * before rendering, and the resolver returns the real parent rather than the
   * asserted one.
   */
  workspaceId: string;
  pmoId: string;
  active: PmoSurface;
}) {
  return (
    <nav aria-label="PMO sections" className="flex flex-wrap gap-2">
      {TABS.map((tab) => {
        const isActive = active === tab.surface;
        return (
          <Link
            key={tab.label}
            href={pmoSurfacePath(workspaceId, pmoId, tab.surface)}
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
