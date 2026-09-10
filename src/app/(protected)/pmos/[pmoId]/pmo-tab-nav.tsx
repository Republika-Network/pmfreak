import Link from "next/link";
import { pmoCommandCenterPath } from "@/lib/pmos/pmo-command-center-paths";

export type PmoTab = "" | "command-center" | "chat" | "reports" | "settings";

/**
 * The PMO Command Center entry is labeled "PMO Command Center", not a bare
 * "Command Center". ADR-PMF-014 Rule 1 requires every user-facing appearance of
 * the phrase to name the entity it projects over, and Rule 3 blesses exactly
 * this "[Entity] Command Center" form as a navigation label. Sitting inside a
 * nav labeled "PMO sections" is context, not qualification — the rule is
 * literal and checkable on purpose, because "obvious from context" is how the
 * ambiguity accumulated in the first place.
 *
 * It is also the only tab whose href is not a `/pmos/<id>/…` segment: the
 * canonical Command Center route is workspace-rooted, and the PMO family's own
 * migration to that root is separate, later work.
 */
const TABS: readonly { label: string; tab: PmoTab }[] = [
  { label: "Overview", tab: "" },
  { label: "PMO Command Center", tab: "command-center" },
  { label: "Chat", tab: "chat" },
  { label: "Reports", tab: "reports" },
  { label: "Settings", tab: "settings" },
];

export function PmoTabNav({
  workspaceId,
  pmoId,
  active,
}: {
  /**
   * The PMO's own workspace. Every call site already holds it, and holds it
   * authoritatively: each resolved a workspace and then looked this PMO up
   * scoped to it, so the PMO is known to belong there. Passing it down beats
   * fetching workspace identity client-side just to build one link.
   */
  workspaceId: string;
  pmoId: string;
  active: PmoTab;
}) {
  return (
    <nav aria-label="PMO sections" className="flex flex-wrap gap-2">
      {TABS.map((tab) => {
        const href =
          tab.tab === "command-center"
            ? pmoCommandCenterPath(workspaceId, pmoId)
            : tab.tab
              ? `/pmos/${encodeURIComponent(pmoId)}/${tab.tab}`
              : `/pmos/${encodeURIComponent(pmoId)}`;
        const isActive = active === tab.tab;
        return (
          <Link
            key={tab.label}
            href={href}
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
