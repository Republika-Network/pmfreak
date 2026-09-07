"use client";

import Link from "next/link";
import type { ProjectListItem, RepositoryItem } from "./types";
import { StatusBadge } from "./status-badge";
import { REPOSITORY_ICONS } from "./icons";
import { MenuIcon, UploadIcon } from "./icons";

/**
 * Project context header — the first thing read, so it carries only what a PM needs to
 * orient: the project's own name, its health, how much is waiting on them, and how fresh
 * the reading is.
 *
 * The generated project code is an identifier, not an answer to any of those questions.
 * It is preserved (downstream surfaces and support conversations use it) but demoted below
 * the human name rather than printed ahead of it.
 *
 * Nothing here is invented. Health is the same derivation as before, read from the real
 * governance brief badges; the attention count is the real queue length and is omitted
 * entirely while the read is loading or failed; the update time is the newest persisted
 * record's timestamp, or nothing at all when no record exists.
 */
export function ProjectTopBar({
  project,
  sources = [],
  onOpenProjects,
  onSourceClick,
  onAttach,
  lastUpdatedLabel,
  needsYouCount = null,
}: {
  project: ProjectListItem;
  /** Sources of truth currently attached to this conversation (documents, decisions, evidence, ...). */
  sources?: RepositoryItem[];
  onOpenProjects: () => void;
  /** Opens the detail drawer for a given attached source. */
  onSourceClick?: (source: RepositoryItem) => void;
  /** Opens the notes/context intake — the way new context gets attached. */
  onAttach?: () => void;
  /** Human-readable timestamp of the newest real operational record. Omitted when no data exists. */
  lastUpdatedLabel?: string;
  /** Items currently awaiting this PM. Null while the read is loading or failed — a
   *  header must not answer "how much needs me?" with a number it does not have. */
  needsYouCount?: number | null;
}) {
  const warnings = project.badges.find((b) => b.tone === "danger")?.label;
  const tasks = project.badges.find((b) => b.tone === "task")?.label;
  const approvals = project.badges.find((b) => b.tone === "approval")?.label;
  const healthLabel = project.healthy ? "Healthy" : warnings ? "At Risk" : project.hasIntelligence ? "On Track" : "Awaiting data";
  const healthTone = project.healthy ? "success" : warnings ? "danger" : "info";
  const activeSources = sources.filter((source) => (source.count ?? 0) > 0);

  return (
    <header className="border-b border-white/10 bg-white/[0.02]" data-testid="cc-project-header">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-start gap-2">
          <button
            type="button"
            onClick={onOpenProjects}
            className="mt-0.5 rounded-lg border border-white/10 p-1.5 text-zinc-400 hover:bg-white/5 xl:hidden"
            aria-label="Open projects"
          >
            <MenuIcon />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight text-zinc-100">{project.fullName}</h1>
            {/* Primary reading line: how much is waiting, and how fresh this is. */}
            <p className="mt-1 text-xs text-zinc-400" data-testid="cc-header-attention-line">
              {needsYouCount !== null && (
                <span data-testid="cc-header-attention-count">
                  {needsYouCount === 0 ? "Nothing needs your attention" : `${needsYouCount} need${needsYouCount === 1 ? "s" : ""} your attention`}
                </span>
              )}
              {needsYouCount !== null && lastUpdatedLabel && <span className="text-zinc-600"> · </span>}
              {lastUpdatedLabel && <span>Updated {lastUpdatedLabel}</span>}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge tone={healthTone as "success" | "danger" | "info"}>Health: {healthLabel}</StatusBadge>
          <Link
            href={`/upload?projectId=${encodeURIComponent(project.id)}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5"
          >
            <UploadIcon className="h-3.5 w-3.5" /> Upload
          </Link>
        </div>
      </div>

      {/* Secondary: the identifier, the brief's own counters, and every source of truth
          this project is currently grounded in. Supporting detail, never the headline. */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 sm:px-5">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-600" data-testid="cc-header-project-code">
          {project.code}
        </span>
        {warnings && <StatusBadge tone="danger">{warnings} warnings</StatusBadge>}
        {tasks && <StatusBadge tone="task">{tasks} tasks</StatusBadge>}
        {approvals && <StatusBadge tone="approval">{approvals} approval</StatusBadge>}
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">Context:</span>
        {activeSources.length === 0 && <span className="text-[11px] text-zinc-600">No sources attached yet</span>}
        {activeSources.map((source) => {
          const Icon = REPOSITORY_ICONS[source.icon];
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => onSourceClick?.(source)}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-400 transition hover:border-sky-500/25 hover:bg-sky-500/[0.06] hover:text-sky-300"
            >
              <Icon className="h-3 w-3 shrink-0" />
              {source.label}
              <span className="text-zinc-600">{source.count}</span>
            </button>
          );
        })}
        {onAttach && (
          <button
            type="button"
            onClick={onAttach}
            /* The persistent intake affordance. It carries the same accessible name as the
               every other "add context" control so the way in is one name at every width —
               the chat composer's paperclip used to be the always-present one, and chat is
               no longer always open. */
            aria-label="Add project notes"
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-white/15 px-2.5 py-1 text-[11px] text-zinc-500 transition hover:border-white/30 hover:text-zinc-300"
          >
            + Attach
          </button>
        )}
      </div>
    </header>
  );
}
