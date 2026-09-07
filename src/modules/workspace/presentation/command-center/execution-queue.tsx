import { useId } from "react";
import type { GovernedExecutionChain } from "./execution-read-model";
import { StatusBadge } from "./status-badge";
import { SectionEmptyState, SectionLoadingState } from "./section-empty-state";

/*
 * Badge and summary both come from `chain.status`, which the read model derives from
 * persisted state: the canonical Decision status, the latest governance evaluation of each
 * Action, and whether an authorization has expired.
 *
 * Two things this must never do. It must not describe a terminal stopped Decision as
 * unfinished work — a rejected Decision is reported as rejected before any progress
 * reading. And it must not describe an Action as "authorized" unless the governance state
 * P2-07 requires is the one actually persisted; `requires_approval`, `denied`,
 * `unavailable`, `degraded`, `revoked` and expired authorizations are each named as the
 * contract names them.
 */

export function ExecutionQueue({
  chains,
  onSelect,
  loading = false,
}: {
  chains: GovernedExecutionChain[];
  onSelect: (chain: GovernedExecutionChain) => void;
  loading?: boolean;
}) {
  const showEmpty = !loading && chains.length === 0;
  // `CommandCenterLayout` mounts this component twice — desktop sidebar and the mobile
  // overlay, which is never unmounted — so a document-global id would appear twice and
  // `aria-labelledby` would resolve to whichever came first, naming the visible section
  // after a hidden heading. Each instance names its own heading.
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="cc-section-in-progress">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          In Progress
        </h2>
        {!loading && chains.length > 0 && <span className="shrink-0 text-[11px] text-zinc-500">{chains.length}</span>}
      </div>
      {/* The section is named for what the PM sees — work under way — while the sentence
          below keeps the canonical meaning intact: this is what follows a recorded
          Decision, and nothing appears here that a human did not decide. */}
      <p className="mt-1 px-1 text-[11px] text-zinc-500">What is happening after your decisions.</p>

      <div role="status" aria-live="polite">
        {loading && chains.length === 0 && <SectionLoadingState label="Checking what you have decided…" />}
      </div>

      {showEmpty && (
        <SectionEmptyState
          title="Nothing is in progress yet."
          description="Once you record a decision, the governed action, task, execution and outcome appear here."
        />
      )}

      <ul className="mt-2 space-y-1.5">
        {chains.map((chain) => (
          <li key={chain.id}>
            <button
              type="button"
              onClick={() => onSelect(chain)}
              className="flex w-full items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition hover:border-white/20 hover:bg-white/[0.05] focus:border-sky-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-zinc-200">{chain.title}</span>
                <span className="block truncate text-[11px] text-zinc-500">{chain.status.detail}</span>
              </span>
              <StatusBadge tone={chain.status.tone}>{chain.status.label}</StatusBadge>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
