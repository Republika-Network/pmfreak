"use client";

import { PROJECT_TOOLS, type ProjectToolKey } from "./operational-tools";

export const OPERATIONAL_INSPECTOR_ID = "operational-inspector";

/**
 * The compact right-hand rail: one button per project tool. Selecting a tool
 * opens the inspector beside the conversation; selecting the open tool closes
 * it. The rail never navigates — tools are supporting context, so opening one
 * leaves the conversation, its draft and its scroll exactly where they were.
 */
export function OperationalRail({
  active,
  onSelect,
}: {
  active: ProjectToolKey | null;
  onSelect: (tool: ProjectToolKey) => void;
}) {
  return (
    <nav
      aria-label="Project tools"
      className="hidden w-[68px] shrink-0 flex-col items-center gap-1 border-l border-slate-200 bg-[#F6F5F1] py-3 md:flex"
      data-testid="operational-rail"
    >
      {PROJECT_TOOLS.map((tool) => {
        const isActive = tool.key === active;
        return (
          <button
            key={tool.key}
            type="button"
            onClick={() => onSelect(tool.key)}
            aria-pressed={isActive}
            aria-label={tool.label}
            aria-controls={OPERATIONAL_INSPECTOR_ID}
            title={tool.description}
            data-tool={tool.key}
            className={`flex w-[56px] flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] font-medium leading-tight transition outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60 ${
              isActive ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.08)] ring-1 ring-slate-200" : "text-slate-500 hover:bg-white/70 hover:text-slate-900"
            }`}
          >
            <ToolIcon tool={tool.key} className={`h-[18px] w-[18px] ${isActive ? "text-cyan-700" : ""}`} />
            <span aria-hidden className="w-full truncate text-center">{tool.short}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function ToolIcon({ tool, className = "" }: { tool: ProjectToolKey; className?: string }) {
  const paths: Record<ProjectToolKey, string> = {
    attention: "M8 2.5a4 4 0 00-4 4v2.2L2.8 11h10.4L12 8.7V6.5a4 4 0 00-4-4zM6.5 13a1.5 1.5 0 003 0",
    activity: "M1.5 8h3l2-4.5 3 9 2-4.5h3",
    execution: "M3 8a5 5 0 109.2-2.7M12.5 2.5v3h-3",
    tasks: "M2.5 4l1.5 1.5L6.5 3M8.5 4.5h5M2.5 9l1.5 1.5L6.5 8M8.5 9.5h5M8.5 13h5",
    schedule: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
    monitoring: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z",
    repository: "M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5",
    project: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  };
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`shrink-0 ${className}`}>
      <path d={paths[tool]} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
