import Link from "next/link";
import { workspaceHomePath } from "@/lib/workspaces/workspace-paths";

/**
 * The workspace-scope strip: "Workspace / {lens}", plus a way back UP to the
 * workspace itself.
 *
 * WHY `workspaceId` MATTERS HERE
 * ------------------------------
 * That "Workspace" link is an ANCESTOR node, and `03-navigation-contracts.md`
 * §2.3 rule 1 says an ancestor always navigates to that ancestor's HOME and
 * never to its Command Center — §2.3 rule 4 and ADR-PMF-014 Rule 4 forbid a
 * Command Center appearing anywhere but at the end of a trail.
 *
 * The default `/workspace` breaks that rule invisibly: it looks like a workspace
 * home, and `src/proxy.ts` quarantines it, bouncing every authenticated request
 * to `/command-center`, which resolves on to the Workspace Command Center. So on
 * the Workspace Command Center the "up" link led back to the same Command
 * Center — a trail whose ancestor is its own descendant.
 *
 * Passing `workspaceId` fixes that properly, now that Workspace Home exists at
 * `/workspaces/[workspaceId]`: the link goes to the real parent entity. The
 * default is unchanged for the callers that genuinely have no workspace id in
 * hand (the Summary, Executive, Portfolio and Workspace Setup lenses, which
 * resolve their scope from the session rather than the route). Repointing those
 * is a separate question about those screens, not about this one.
 */
export function WorkspaceContextBanner({
  lens,
  workspaceId,
  returnHref,
}: {
  lens: string;
  /**
   * The AUTHORIZED workspace this lens is rendering, when the caller has one —
   * `resolveRoutedWorkspace`'s answer, never the raw routed segment.
   */
  workspaceId?: string;
  returnHref?: string;
}) {
  const href = returnHref ?? (workspaceId ? workspaceHomePath(workspaceId) : "/workspace");
  return (
    <section className="rounded-2xl border border-slate-200 bg-white/70 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">Workspace / {lens}</p>
        <Link href={href} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50">
          Workspace
        </Link>
      </div>
    </section>
  );
}
