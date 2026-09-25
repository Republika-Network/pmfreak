import type { ReactNode } from "react";
import type { StatusTone } from "./types";

const TONE_STYLES: Record<StatusTone, { dot: string; bg: string; text: string; border: string }> = {
  danger: { dot: "bg-rose-400", bg: "bg-rose-500/10", text: "text-rose-800", border: "border-rose-500/25" },
  task: { dot: "bg-sky-400", bg: "bg-sky-500/10", text: "text-sky-800", border: "border-sky-500/25" },
  approval: { dot: "bg-amber-400", bg: "bg-amber-500/10", text: "text-amber-800", border: "border-amber-500/25" },
  insight: { dot: "bg-violet-400", bg: "bg-violet-500/10", text: "text-violet-800", border: "border-violet-500/25" },
  success: { dot: "bg-emerald-400", bg: "bg-emerald-500/10", text: "text-emerald-800", border: "border-emerald-500/25" },
  info: { dot: "bg-zinc-400", bg: "bg-slate-100", text: "text-slate-700", border: "border-slate-300" },
};

export const TONE_LABELS: Record<StatusTone, string> = {
  danger: "Warning",
  task: "Task",
  approval: "Approval",
  insight: "Insight",
  success: "Done",
  info: "Info",
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const c = TONE_STYLES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-5 ${c.bg} ${c.text} ${c.border}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
      {children}
    </span>
  );
}

export function StatusDot({ tone, pulse = false }: { tone: StatusTone; pulse?: boolean }) {
  const c = TONE_STYLES[tone];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${c.dot}`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${c.dot}`} />
    </span>
  );
}

export function toneStyles(tone: StatusTone) {
  return TONE_STYLES[tone];
}
