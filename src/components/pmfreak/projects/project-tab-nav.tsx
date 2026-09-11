import Link from "next/link";
import { projectHomePath } from "@/lib/projects/project-paths";
import { projectCommandCenterPath } from "@/lib/projects/project-command-center-paths";

/**
 * Project section navigation. The project opens on Overview; the chat is one
 * view among many (never the landing view). Sections that already exist as
 * workspace surfaces are reused via ?projectId= links rather than rebuilt.
 *
 * Meetings and Risks & Issues intentionally omit ?projectId= and are labeled
 * "(preview)": their destination pages (/meetings, /change-detection) are
 * generic workspace-wide modules that do not read a projectId param at all —
 * passing one would falsely imply per-project scoping that doesn't exist yet.
 *
 * WHY ONLY OVERVIEW AND THE COMMAND CENTER ARE CANONICAL
 * ------------------------------------------------------
 * Overview points at canonical Project Home,
 * `/workspaces/[workspaceId]/projects/[projectId]`, and Project Command Center at
 * `/workspaces/[workspaceId]/projects/[projectId]/command-center` — because those
 * two routes exist and are where those screens live. The Command Center entry is
 * labeled "Project Command Center", not a bare "Command Center": ADR-PMF-014
 * Rule 1 requires every user-facing appearance of the phrase to name the entity
 * it projects over, and Rule 3 blesses exactly this "[Entity] Command Center"
 * form as a navigation label. Sitting inside a nav labeled "Project sections" is
 * context, not qualification — the rule is literal and checkable on purpose,
 * because "obvious from context" is how the ambiguity accumulated in the first
 * place.
 *
 * NOTHING ELSE in this strip is rewritten, and that is the honest state of the
 * product rather than a half-finished migration:
 *
 *   - Chat and Settings still point at `/projects/[id]/chat` and
 *     `/projects/[id]/settings`. `07-route-layout-and-navigation-architecture.md`
 *     §2's ratified Project family does not contain `chat` or `settings` at all,
 *     so `/workspaces/W/projects/P/chat` is not a route this architecture
 *     authorizes — writing it here would invent one and 404.
 *   - Execution, Timeline, Tasks, Documents, Evidence and Reports point at
 *     workspace-wide modules with a `?projectId=`. Their canonical replacements
 *     (`…/projects/[projectId]/tasks`, `/milestones`, `/documents`, …) are in the
 *     ratified map and none of them is built. A link is a claim that a screen
 *     exists; these tabs keep pointing where the screens actually are.
 *
 * So this strip is not yet canonical, and does not pretend to be. It becomes
 * canonical one tab at a time, as each destination ships.
 */
export function ProjectTabNav({
  workspaceId,
  projectId,
  active,
}: {
  /**
   * The project's AUTHORITATIVE workspace — `projects.workspace_id`, as returned
   * by `resolveRoutedProject` or read from the project's own row, never the
   * preferred-workspace cookie. Every call site holds it because every call site
   * read the project before rendering.
   */
  workspaceId: string;
  projectId: string;
  active: "overview" | "command-center" | "chat" | "settings";
}) {
  const tabs: { label: string; href: string; key?: string }[] = [
    { label: "Overview", href: projectHomePath(workspaceId, projectId), key: "overview" },
    { label: "Project Command Center", href: projectCommandCenterPath(workspaceId, projectId), key: "command-center" },
    { label: "Chat", href: `/projects/${projectId}/chat`, key: "chat" },
    { label: "Execution", href: `/command-center?projectId=${projectId}` },
    { label: "Timeline", href: `/dashboard?projectId=${projectId}` },
    { label: "Tasks", href: `/follow-up-dashboard?projectId=${projectId}` },
    { label: "Documents", href: `/upload?projectId=${projectId}` },
    { label: "Meetings (preview)", href: `/meetings` },
    { label: "Evidence", href: `/evidence?projectId=${projectId}` },
    { label: "Risks & Issues (preview)", href: `/change-detection` },
    { label: "Reports", href: `/executive?projectId=${projectId}` },
    { label: "Settings", href: `/projects/${projectId}/settings`, key: "settings" },
  ];

  return (
    <nav aria-label="Project sections" className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.label}
            href={tab.href}
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
