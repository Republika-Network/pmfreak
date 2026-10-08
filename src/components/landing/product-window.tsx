"use client";

import type { NeedsYouItem } from "@/modules/workspace/presentation/command-center/types";
import type { ChangeItem } from "@/modules/workspace/presentation/command-center/change-read-model";
import { NeedsYouQueue } from "@/modules/workspace/presentation/command-center/needs-you-queue";
import { WhatChangedPanel } from "@/modules/workspace/presentation/command-center/what-changed-panel";

// The landing's product evidence is the real Command Center: these are the
// shipped `NeedsYouQueue` and `WhatChangedPanel` components, unmodified, inside
// a window frame that uses the app shell's real navigation and tool-tab labels.
// Only the project content is sample data, and the frame says so on screen.
// The window is `inert`: it is a picture of the product, not a working control.

const noop = () => {};

const SIDEBAR = ["Command Center", "Projects", "Execution", "Portfolio"] as const;
// operational-tools.ts, in order.
const TOOL_TABS = ["Needs you", "What changed", "In progress", "Tasks", "Schedule", "Monitoring", "Evidence", "Project"] as const;

const decideControls = [
  { status: "accepted", label: "Accept", effect: "", terminal: true, allowed: true, deniedExplanation: null },
];

function sampleItem(item: Omit<NeedsYouItem, "badge" | "drawer"> & { tone: "danger" | "task"; canDecide: boolean }): NeedsYouItem {
  const { tone, canDecide, ...rest } = item;
  return {
    ...rest,
    badge: { tone, label: item.severity ?? "" },
    drawer: {
      title: item.title,
      why: item.whyItMatters ?? "",
      evidence: [],
      nextStep: "",
      decisionPanel: {
        kind: "raid_suggestion",
        subjectId: item.id,
        writePathLabel: "",
        controls: canDecide ? decideControls : [],
        anyAllowed: canDecide,
        readOnlyNote: null,
        blockedReason: null,
        onDecide: async () => {},
        requiresRationale: false,
        decisions: [],
      },
    },
  };
}

const NEEDS_YOU: NeedsYouItem[] = [
  sampleItem({
    id: "sample-1",
    title: "Vendor API change pushes integration testing past the launch date",
    severity: "high",
    tone: "danger",
    canDecide: true,
    whyItMatters: "The launch milestone depends on integration testing finishing first.",
    recommendation: "Re-sequence testing and confirm a new launch date with the sponsor.",
    evidenceSummary: "Vendor email · weekly status notes",
  }),
  sampleItem({
    id: "sample-2",
    title: "Design sign-off has no named approver",
    severity: "medium",
    tone: "task",
    canDecide: false,
    whyItMatters: "Build starts Monday and nobody has authority to accept the designs.",
    evidenceSummary: "Kickoff meeting notes",
  }),
];

const WHAT_CHANGED: ChangeItem[] = [
  {
    id: "change-1",
    title: "Scope changed",
    detail: "Two new pages were added to the launch scope in Tuesday's meeting.",
    severityLabel: "Medium",
    tone: "task",
    occurredAt: null,
    whenLabel: "2h ago",
  },
  {
    id: "change-2",
    title: "Approval missing",
    detail: "Extra QA budget was agreed in chat but has no recorded approval.",
    severityLabel: "High",
    tone: "danger",
    occurredAt: null,
    whenLabel: "Yesterday",
  },
  {
    id: "change-3",
    title: "Schedule at risk",
    detail: "Content migration is running a week behind plan.",
    severityLabel: "High",
    tone: "danger",
    occurredAt: null,
    whenLabel: "Yesterday",
  },
];

function WindowChrome({ children, compact }: { children: React.ReactNode; compact: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/15! bg-white text-slate-900 shadow-[0_30px_80px_-20px_rgba(20,184,166,0.45)]">
      <div className="flex items-center gap-2 border-b border-slate-200! bg-slate-50 px-4 py-2.5">
        <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        <span className="ml-3 truncate text-xs font-semibold text-slate-600">PMFreak · Website relaunch</span>
        <span className="ml-2 shrink-0 rounded-full border border-dashed border-slate-300! px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          Sample project
        </span>
      </div>
      <div className={compact ? "" : "grid md:grid-cols-[168px_1fr]"}>
        {!compact && (
          <nav aria-label="Sample app navigation" className="hidden border-r border-slate-200! bg-slate-50/70 p-3 md:block">
            <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Start here</p>
            <ul className="mt-2 space-y-0.5 text-sm">
              {SIDEBAR.map((label, index) => (
                <li
                  key={label}
                  className={`rounded-lg px-2 py-1.5 ${index === 0 ? "bg-white font-semibold text-slate-900 shadow-sm" : "text-slate-600"}`}
                >
                  {label}
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200! px-4 pt-3">
            <span className="text-sm font-semibold text-slate-900">Website relaunch</span>
            <span className="rounded-full border border-rose-500/25! bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-800">2 high risks</span>
            <span className="rounded-full border border-amber-500/25! bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-800">1 governance gap</span>
            <ul className="-mb-px mt-1 flex w-full gap-4 overflow-hidden text-xs font-medium text-slate-500">
              {TOOL_TABS.slice(0, compact ? 4 : TOOL_TABS.length).map((tab, index) => (
                <li
                  key={tab}
                  className={`shrink-0 border-b-2 pb-2 ${
                    index === (compact ? 1 : 0) ? "border-calm-teal! text-slate-900" : "border-transparent!"
                  }`}
                >
                  {tab}
                </li>
              ))}
            </ul>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Hero monitor: the calm side of the split shows what changed, already sorted. */
export function HeroProductWindow() {
  return (
    <div inert>
      <WindowChrome compact>
        <div className="bg-slate-50/60 p-3">
          <WhatChangedPanel items={WHAT_CHANGED} />
        </div>
      </WindowChrome>
    </div>
  );
}

/** Product showcase: the Command Center's two first questions, side by side. */
export function ShowcaseProductWindow() {
  return (
    <div inert>
      <WindowChrome compact={false}>
        {/* Cropped like a window that scrolls on: the fade marks where the view continues. */}
        <div className="relative max-h-[540px] overflow-hidden">
          <div className="grid gap-4 bg-slate-50/60 p-4 lg:grid-cols-[1.25fr_1fr]">
            <NeedsYouQueue items={NEEDS_YOU} onSelect={noop} variant="canvas" />
            <WhatChangedPanel items={WHAT_CHANGED} />
          </div>
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-white to-transparent" />
        </div>
      </WindowChrome>
    </div>
  );
}
