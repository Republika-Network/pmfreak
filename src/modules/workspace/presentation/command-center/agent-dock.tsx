import type { Agent } from "./types";
import { AgentCard } from "./agent-card";
import { SectionEmptyState, SectionLoadingState } from "./section-empty-state";

export function AgentDock({
  agents,
  onSelect,
  loading = false,
  onAddContext,
}: {
  agents: Agent[];
  onSelect: (agent: Agent) => void;
  /** True while the operational flow for the active project is still loading. */
  loading?: boolean;
  /** Opens the notes intake — adding context is what activates agents. */
  onAddContext?: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">AI Specialist Team</p>
      </div>
      {loading && agents.length === 0 && <SectionLoadingState label="Checking agent activity..." />}
      {!loading && agents.length === 0 && (
        <SectionEmptyState
          title="No agent activity detected yet"
          description="Agents work from real project evidence. This project has none recorded yet."
          ctaLabel="Add project context to activate agents"
          onCta={onAddContext}
        />
      )}
      <div className="mt-2 space-y-1.5">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
