import { useId } from "react";
import type { GovernedExecutionChain } from "./execution-read-model";
import { projectChainProgress } from "./in-progress-read-model";
import { deriveDecisionJourney } from "./decision-journey";
import { JourneyTrack } from "./journey-track";
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
 *
 * The heading is a third claim, and it is the one this component owns. "In Progress" is a
 * statement about the LIST, so the list holds only chains `projectChainProgress` finds
 * genuinely under way. Everything else the canonical projection carries is still here —
 * open-but-stalled chains in their own labelled group, terminal chains behind a
 * disclosure — because completeness and honesty are both required, and grouping is how
 * you get both.
 */

/**
 * UX-W4 — one decision's work, as a PM would read it.
 *
 * The card answers, in this order: what are we doing, why does it exist, who owns it,
 * where are we in the loop, and what happens next. The canonical badge and chain detail
 * are still here — the badge above and everything else in the drawer — but they no longer
 * come first, because a governance state is not what a PM is trying to find out.
 *
 * Every line is conditional on a persisted value. There is no "Owner: Unknown" and no
 * invented deadline: a fact this project does not hold is a line that does not render.
 *
 * The card is not a `<button>`. It contains an ordered list (the loop indicator), which a
 * button may not contain, so the title carries the control and a stretched pseudo-element
 * gives the whole card the click target. One tab stop, valid markup, same affordance.
 */
function ChainRow({
  chain,
  onSelect,
  testId,
  actorUserId,
}: {
  chain: GovernedExecutionChain;
  onSelect: (chain: GovernedExecutionChain) => void;
  testId: string;
  /** The VIEWER, from `summary.actor.userId` — never the decider. It answers "is this
   *  mine?" and nothing else; it grants no capability. */
  actorUserId: string | null;
}) {
  const journey = deriveDecisionJourney(chain, actorUserId);
  return (
    <li>
      <div
        data-testid={testId}
        data-journey-phase={journey.phase}
        data-journey-closure={journey.closure}
        className="relative rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 transition focus-within:border-sky-500/40 hover:border-white/20 hover:bg-white/[0.05]"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 text-sm text-zinc-200">
            <button
              type="button"
              data-testid={`${testId}-open`}
              onClick={() => onSelect(chain)}
              className="block w-full truncate text-left after:absolute after:inset-0 after:content-[''] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
            >
              {chain.title}
            </button>
          </h3>
          <StatusBadge tone={chain.status.tone}>{chain.status.label}</StatusBadge>
        </div>

        {/* Why this work exists — the Decision's own rationale, never a restatement. */}
        {journey.why && (
          <p className="mt-1.5 line-clamp-2 text-[11px] text-zinc-400" data-testid="cc-journey-why">
            <span className="text-zinc-500">Why </span>
            {journey.why}
          </p>
        )}

        {/* What is happening, from persisted state. */}
        <p className="mt-1 text-[11px] text-zinc-400" data-testid="cc-journey-state">
          {journey.state}
        </p>

        {/* Owner only when a canonical actor is persisted. Never a fabricated name. */}
        {journey.owner && (
          <p className="mt-1 text-[11px] text-zinc-500" data-testid="cc-journey-owner">
            {journey.owner.isYou ? "Owned by you" : "Owned by another workspace member"}
          </p>
        )}

        {/* The next real step. Absent when nothing is pending. */}
        {journey.next && (
          <p className="mt-1 text-[11px] text-zinc-300" data-testid="cc-journey-next">
            <span className="text-zinc-500">Next </span>
            {journey.next}
          </p>
        )}

        {/* Known facts stay visible; completion is not claimed over a gap. */}
        {journey.partialReason && (
          <p className="mt-1 text-[11px] text-amber-300/80" data-testid="cc-journey-partial">
            {journey.partialReason}
          </p>
        )}

        <JourneyTrack journey={journey} className="mt-2" />
      </div>
    </li>
  );
}

export function ExecutionQueue({
  chains,
  onSelect,
  loading = false,
  actorUserId = null,
  incomplete = false,
  incompleteNote = null,
}: {
  chains: GovernedExecutionChain[];
  onSelect: (chain: GovernedExecutionChain) => void;
  loading?: boolean;
  /** The viewer's canonical actor id, used only to say whether work is theirs. */
  actorUserId?: string | null;
  /**
   * True when the set of chains is NOT proven to be every one this project holds.
   *
   * "Nothing is in progress yet." is a claim about the project, and a request that merely
   * succeeded does not license it. When completeness is unproven the empty state says what
   * is actually known instead, exactly as Needs You does.
   */
  incomplete?: boolean;
  incompleteNote?: string | null;
}) {
  const { inProgress, notProgressing, closed } = projectChainProgress(chains);
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
        {/* The count is the count of the heading's own claim, not of the section. */}
        {!loading && !incomplete && inProgress.length > 0 && <span className="shrink-0 text-[11px] text-zinc-500">{inProgress.length}</span>}
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
          title={incomplete ? "We cannot confirm what is in progress." : "Nothing is in progress yet."}
          description={
            incomplete
              ? "Some of this project's work could not be read, so this is not a complete answer. Try again in a moment."
              : "Once you record a decision, the work that follows it appears here."
          }
        />
      )}

      {/* Known items ARE shown; what is withheld is the claim that they are all of them. */}
      {!loading && !showEmpty && incomplete && incompleteNote && (
        <p className="mt-2 px-1 text-[11px] text-amber-300/80" data-testid="cc-in-progress-incomplete">
          {incompleteNote}
        </p>
      )}

      {inProgress.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {inProgress.map((chain) => (
            <ChainRow key={chain.id} chain={chain} onSelect={onSelect} actorUserId={actorUserId} testId="cc-in-progress-item" />
          ))}
        </ul>
      )}

      {/* Decided, still open, and not moving. Said plainly rather than counted as progress
          — and left expanded, because the next move on every one of these is the PM's and
          this row is how they reach it. */}
      {!loading && notProgressing.length > 0 && (
        <div className="mt-3" data-testid="cc-not-progressing-group">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            Not progressing
          </p>
          <p className="mt-1 px-1 text-[11px] text-zinc-500">
            Decided, but nothing is advancing on its own. Each row says why.
          </p>
          <ul className="mt-2 space-y-1.5">
            {notProgressing.map((chain) => (
              <ChainRow key={chain.id} chain={chain} onSelect={onSelect} actorUserId={actorUserId} testId="cc-not-progressing-item" />
            ))}
          </ul>
        </div>
      )}

      {/* Terminal chains. Preserved and reachable — a PM must still be able to open a
          rejected Decision or an achieved Outcome — but never presented as live work. */}
      {!loading && closed.length > 0 && (
        <details className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2" data-testid="cc-closed-chains">
          <summary className="cursor-pointer text-[11px] font-medium text-zinc-500 transition hover:text-zinc-300">
            Closed ({closed.length})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {closed.map((chain) => (
              <ChainRow key={chain.id} chain={chain} onSelect={onSelect} actorUserId={actorUserId} testId="cc-closed-chain-item" />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
