"use client";

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import { ProjectBrainConversation } from "@/components/pmfreak/project-brain/project-brain-conversation";
import { ProjectTaskList } from "@/components/pmfreak/tasks/project-task-list";
import { WorkspaceOnboardingPanel } from "@/components/pmfreak/onboarding/workspace-onboarding-panel";
import { ProjectOperationsInspector, type OperationalToolKey } from "@/modules/workspace";
import { MenuButton, useShellNavigation } from "./conversation-shell";
import { OperationalInspector } from "./operational-inspector";
import { OperationalRail, OPERATIONAL_INSPECTOR_ID } from "./operational-rail";
import { projectToolDefinition, type ProjectToolKey } from "./operational-tools";
import type { BriefIndicator } from "./project-brief-indicators";

const INDICATOR_TONES: Record<BriefIndicator["tone"], string> = {
  danger: "bg-rose-50 text-rose-800 ring-1 ring-rose-200",
  task: "bg-sky-50 text-sky-800 ring-1 ring-sky-200",
  approval: "bg-amber-50 text-amber-900 ring-1 ring-amber-200",
};

export type ProjectConversationLinks = {
  workspace: string;
  pmo: string | null;
  overview: string;
  operationalOverview: string;
  guidedSetup: string;
  documents: string;
  evidence: string;
  settings: string;
};

/**
 * CHAT-SHELL-01 — a project, as a conversation.
 *
 *   ┌──────────────────────────────────────────────┬──────┬───────────────┐
 *   │ header: project · workspace / PMO · status    │      │               │
 *   ├──────────────────────────────────────────────┤ rail │  inspector    │
 *   │                                              │      │  (one tool,   │
 *   │            Project Brain transcript          │      │   when open)  │
 *   │                                              │      │               │
 *   │ [ composer                              ] ↑ │      │               │
 *   └──────────────────────────────────────────────┴──────┴───────────────┘
 *
 * The conversation is a sibling of the rail and the inspector, never their
 * child, so opening, switching or closing a tool cannot remount it: its
 * transcript, its unsent draft and its scroll position stay exactly where they
 * were. Which tool is open is presentational state, held here and not in the
 * URL — except that a link may ASK for one (`?tool=`, e.g. the Command Center's
 * hand-off opening "Needs you"), which seeds the initial state and is then
 * dropped from the address bar so a refresh does not keep reopening it.
 *
 * Everything here is scoped to the ONE project the page authorized. The page
 * keys this component by project id, so moving to another project starts from a
 * clean slate — no open tool, notes draft or operational state carries across.
 */
export function ProjectConversationView({
  workspaceId,
  project,
  workspaceName,
  pmoName,
  initialTool,
  hasBrief,
  indicators = [],
  canCreateTask,
  links,
  notice,
}: {
  workspaceId: string;
  project: { id: string; name: string; status: string; icon: string | null; color: string | null };
  workspaceName: string;
  pmoName: string | null;
  initialTool: ProjectToolKey | null;
  hasBrief: boolean;
  /** Small counts from the latest governance brief — orientation, not analytics. */
  indicators?: BriefIndicator[];
  canCreateTask: boolean;
  links: ProjectConversationLinks;
  /** Server-rendered state notice (archived, ancestry unavailable). */
  notice?: ReactNode;
}) {
  const [tool, setTool] = useState<ProjectToolKey | null>(initialTool);
  // The operational read stays mounted while the inspector is open, even across a
  // switch to Tasks or Project, so a notes draft or a pending reconciliation is not
  // thrown away by a glance at another tool.
  const [lastOperationalTool, setLastOperationalTool] = useState<OperationalToolKey | null>(
    initialTool && projectToolDefinition(initialTool).operational ? (initialTool as OperationalToolKey) : null,
  );
  const shell = useShellNavigation();

  const dropToolFromUrl = () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("tool")) return;
    url.searchParams.delete("tool");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const selectTool = (next: ProjectToolKey) => {
    dropToolFromUrl();
    setTool((current) => (current === next ? null : next));
    if (projectToolDefinition(next).operational) setLastOperationalTool(next as OperationalToolKey);
  };
  const switchTool = (next: ProjectToolKey) => {
    dropToolFromUrl();
    setTool(next);
    if (projectToolDefinition(next).operational) setLastOperationalTool(next as OperationalToolKey);
  };
  const closeTool = useCallback(() => {
    dropToolFromUrl();
    setTool(null);
  }, []);

  const operationalTool = tool && projectToolDefinition(tool).operational ? (tool as OperationalToolKey) : lastOperationalTool;

  return (
    <div className="flex h-full min-h-0" data-testid="project-conversation-shell" data-project-id={project.id}>
      <section aria-label={`Project Brain — ${project.name}`} className="flex min-w-0 flex-1 flex-col" data-testid="project-conversation-center">
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2.5 sm:px-5" data-testid="project-conversation-header">
          {shell ? <MenuButton onClick={shell.openNavigation} /> : null}
          <div className="min-w-0 flex-1">
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[11px] text-slate-500">
              <Link href={links.workspace} className="truncate hover:text-slate-800">
                {workspaceName}
              </Link>
              {pmoName && links.pmo ? (
                <>
                  <span aria-hidden>/</span>
                  <Link href={links.pmo} className="truncate hover:text-slate-800">
                    {pmoName}
                  </Link>
                </>
              ) : null}
            </nav>
            <h1 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold tracking-tight text-slate-900">
              {project.color ? <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: project.color }} /> : null}
              {project.icon ? <span aria-hidden>{project.icon}</span> : null}
              <span className="truncate">{project.name}</span>
              <span className="shrink-0 rounded-full border border-slate-200 px-2 py-px text-[10px] font-medium uppercase tracking-wide text-slate-500" data-testid="project-status">
                {project.status}
              </span>
              {indicators.map((indicator) => (
                <span
                  key={indicator.key}
                  title="From this project's latest governance brief"
                  data-testid={`project-indicator-${indicator.key}`}
                  className={`hidden shrink-0 rounded-full px-2 py-px text-[10px] font-medium sm:inline ${INDICATOR_TONES[indicator.tone]}`}
                >
                  {indicator.label}
                </span>
              ))}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => (tool ? closeTool() : switchTool(lastOperationalTool ?? "attention"))}
            aria-expanded={tool !== null}
            aria-controls={OPERATIONAL_INSPECTOR_ID}
            className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 md:hidden"
          >
            Tools
          </button>
        </header>

        {notice ? <div className="shrink-0 px-4 pt-3 sm:px-6">{notice}</div> : null}

        <div className="min-h-0 flex-1">
          <ProjectBrainConversation projectId={project.id} projectName={project.name} variant="light" layout="surface" />
        </div>
      </section>

      <OperationalRail active={tool} onSelect={selectTool} />

      <OperationalInspector tool={tool} onSelect={switchTool} onClose={closeTool}>
        {tool !== null && operationalTool ? (
          <div hidden={!projectToolDefinition(tool).operational}>
            <ProjectOperationsInspector
              workspaceId={workspaceId}
              projectId={project.id}
              projectName={project.name}
              tool={operationalTool}
              hasBrief={hasBrief}
            />
          </div>
        ) : null}
        {tool === "tasks" ? <ProjectTaskList projectId={project.id} canCreateTask={canCreateTask} /> : null}
        {tool === "project" ? <ProjectLinksTool links={links} /> : null}
      </OperationalInspector>
    </div>
  );
}

/**
 * The project's other screens — reachable from beside the conversation, never
 * competing with it. Each is a real, authorized route that already existed.
 */
function ProjectLinksTool({ links }: { links: ProjectConversationLinks }) {
  const entries = [
    { href: links.overview, label: "Project details", description: "Identity, execution, PM assignment and analyses" },
    { href: links.operationalOverview, label: "Operational overview", description: "Risks, recommendations, pending decisions and governance totals" },
    { href: links.guidedSetup, label: "Project Memory setup", description: "The guided intelligence inbox" },
    { href: links.documents, label: "Documents", description: "Upload documents for this project" },
    { href: links.evidence, label: "Evidence collection", description: "This project's evidence documents" },
    { href: links.settings, label: "Settings", description: "Project settings" },
  ];
  return (
    <div className="space-y-5">
      <ul className="space-y-1" data-testid="project-tool-links">
        {entries.map((entry) => (
          <li key={entry.href}>
            <Link href={entry.href} className="block rounded-xl border border-transparent px-3 py-2.5 transition hover:border-slate-200 hover:bg-slate-50">
              <span className="block text-sm font-medium text-slate-900">{entry.label}</span>
              <span className="block text-xs text-slate-500">{entry.description}</span>
            </Link>
          </li>
        ))}
      </ul>
      <WorkspaceOnboardingPanel surface="dashboard" />
    </div>
  );
}
