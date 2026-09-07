"use client";

import type { ReactNode } from "react";
import type { GovernedExecutionChain } from "./execution-read-model";
import type { ChangeItem } from "./change-read-model";
import type { MonitoringSummary } from "./operational-data";
import type { NeedsYouItem, ProjectListItem, RepositoryItem } from "./types";
import { ProjectTopBar } from "./project-top-bar";
import { NeedsYouQueue } from "./needs-you-queue";
import { WhatChangedPanel } from "./what-changed-panel";
import { ExecutionQueue } from "./execution-queue";
import { MonitoringPanel } from "./monitoring-panel";
import { AskPmfreakPanel } from "./ask-pmfreak-panel";

/**
 * The attention-first Command Center composition.
 *
 * This component owns the PRODUCT HIERARCHY and nothing else — every value it renders is
 * derived upstream by the screen from one already-loaded operational summary. It is pure
 * with respect to its props, which is what lets a test render it against canonical-shaped
 * fixtures and read the order a PM actually sees rather than inferring it from source.
 *
 * DOM order is the semantic order, and it is the mobile order:
 *
 *   1. project context / health   2. needs your attention   3. what changed
 *   4. in progress                5. PMFreak is monitoring  6. ask PMFreak
 *
 * On a wide viewport the same nodes are placed into two columns — attention and what
 * changed on the left, in progress and monitoring in the right rail, the conversation
 * across the bottom — using explicit grid placement rather than a different DOM. There is
 * one tree, so a small screen cannot end up with a different priority than a large one,
 * and no attention content is reachable only through an overlay.
 *
 * Chat is present, one click from every screen, and never the canvas.
 */
export function CommandCenterCanvas({
  project,
  sources,
  lastUpdatedLabel,
  onOpenProjects,
  onSourceClick,
  onAttach,

  needsYouItems,
  needsYouCount,
  onSelectNeedsYou,
  attentionErrorMessage,
  onRetryAttention,
  onAddNotes,
  monitoringNote,

  changes,
  chains,
  onSelectChain,

  monitoring,
  monitoringActive,
  agentDetail,

  chatOpen,
  onToggleChat,
  chatMessageCount,
  chat,

  loading = false,
  /** Rendered above the attention canvas when the screen supplies one (onboarding). */
  headerSlot,
  /** Rendered above the attention canvas (notes intake, when open). */
  intakeSlot,
  /** Rendered beneath every attention section — workspace-level supporting content that
   *  must stay reachable without competing with what needs the PM's attention. */
  footerSlot,
}: {
  project: ProjectListItem;
  sources: RepositoryItem[];
  lastUpdatedLabel?: string;
  onOpenProjects: () => void;
  onSourceClick?: (source: RepositoryItem) => void;
  onAttach?: () => void;

  needsYouItems: NeedsYouItem[];
  /** Null while the read is loading or failed — the header then states no count at all. */
  needsYouCount: number | null;
  onSelectNeedsYou: (item: NeedsYouItem) => void;
  attentionErrorMessage: string | null;
  onRetryAttention?: () => void;
  onAddNotes?: () => void;
  monitoringNote?: string | null;

  changes: ChangeItem[];
  chains: GovernedExecutionChain[];
  onSelectChain: (chain: GovernedExecutionChain) => void;

  monitoring: MonitoringSummary;
  monitoringActive: boolean;
  agentDetail?: ReactNode;

  chatOpen: boolean;
  onToggleChat: (next: boolean) => void;
  chatMessageCount: number;
  chat: ReactNode;

  loading?: boolean;
  headerSlot?: ReactNode;
  intakeSlot?: ReactNode;
  footerSlot?: ReactNode;
}) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="command-center-canvas"
      data-primary-surface="NEEDS_YOU"
      data-chat-role="COPILOT"
    >
      <ProjectTopBar
        project={project}
        sources={sources}
        onOpenProjects={onOpenProjects}
        onSourceClick={onSourceClick}
        onAttach={onAttach}
        lastUpdatedLabel={lastUpdatedLabel}
        needsYouCount={needsYouCount}
      />

      {intakeSlot}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {headerSlot && <div className="mb-4">{headerSlot}</div>}

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          {/* 2 — attention. First in the document, and the left column on a wide screen. */}
          <div className="min-w-0 xl:col-start-1 xl:row-start-1">
            <NeedsYouQueue
              variant="canvas"
              items={needsYouItems}
              onSelect={onSelectNeedsYou}
              loading={loading}
              errorMessage={attentionErrorMessage}
              onRetry={onRetryAttention}
              onAddNotes={onAddNotes}
              emptyStateNote={monitoringNote}
            />
          </div>

          {/* 3 — what changed. Below attention on every viewport. */}
          <div className="min-w-0 xl:col-start-1 xl:row-start-2">
            <WhatChangedPanel
              items={changes}
              loading={loading}
              errorMessage={attentionErrorMessage}
              onRetry={onRetryAttention}
            />
          </div>

          {/* 4 — in progress. Right rail on a wide screen, third section on a phone. */}
          <div className="min-w-0 self-start xl:col-start-2 xl:row-start-1">
            <ExecutionQueue chains={chains} onSelect={onSelectChain} loading={loading} />
          </div>

          {/* 5 — monitoring, with the specialist roster collapsed beneath it. */}
          <div className="min-w-0 self-start xl:col-start-2 xl:row-start-2">
            <MonitoringPanel
              summary={monitoring}
              active={monitoringActive}
              loading={loading}
              errorMessage={attentionErrorMessage}
              onRetry={onRetryAttention}
              onAddContext={onAddNotes}
              detail={agentDetail}
            />
          </div>

          {/* 6 — the copilot. Last, across both columns. */}
          <div className="min-w-0 xl:col-span-2 xl:col-start-1 xl:row-start-3">
            <AskPmfreakPanel open={chatOpen} onToggle={onToggleChat} messageCount={chatMessageCount}>
              {chat}
            </AskPmfreakPanel>
          </div>
        </div>

        {footerSlot && <div className="mt-5">{footerSlot}</div>}
      </div>
    </div>
  );
}
