import type { Agent } from "./types";
import { StatusBadge } from "./status-badge";

function ActivityIndicator({ activity }: { activity: Agent["activity"] }) {
  if (activity === "idle") return null;
  if (activity === "pulsing") {
    return (
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-400" />
      </span>
    );
  }
  if (activity === "shimmer") {
    return (
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-100">
        <span className="block h-full w-4 rounded-full bg-gradient-to-r from-transparent via-sky-400/70 to-transparent motion-safe:animate-[shimmerMove_1.8s_ease-in-out_infinite]" />
      </span>
    );
  }
  return (
    <span className="h-1.5 w-10 overflow-hidden rounded-full bg-slate-100">
      <span className="block h-full w-1/3 rounded-full bg-rose-400/70 motion-safe:animate-[progressMove_1.6s_ease-in-out_infinite]" />
    </span>
  );
}

export function AgentCard({ agent, onSelect }: { agent: Agent; onSelect: (agent: Agent) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(agent)}
      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-slate-300 hover:bg-slate-50"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-slate-900">{agent.name}</p>
        <StatusBadge tone={agent.badge.tone}>{agent.badge.label}</StatusBadge>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <ActivityIndicator activity={agent.activity} />
        <p className="truncate text-xs text-slate-500">{agent.statusText}</p>
      </div>
    </button>
  );
}
