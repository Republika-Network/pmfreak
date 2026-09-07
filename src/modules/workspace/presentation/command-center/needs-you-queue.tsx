import { useId } from "react";
import type { NeedsYouItem } from "./types";
import { groupAttentionItems } from "./attention-presentation";
import { AttentionCard } from "./attention-card";
import { SectionEmptyState, SectionLoadingState } from "./section-empty-state";

/**
 * The Command Center's primary surface: what needs this PM's attention.
 *
 * `variant` changes prominence only. `canvas` is the main-content rendering — larger type,
 * more room — and `rail` is the original compact rendering, kept for any surface that still
 * shows the queue beside something else. The item anatomy is identical in both: canonical
 * semantics, ordering and decision authority are untouched by placement.
 *
 * Items are grouped by the job they ask of the PM (UX-W3). The grouping is presentation
 * only — see `attention-presentation.ts` — and it neither reorders items within a group nor
 * merges the two attention sources, which keep their own models and write paths beneath it.
 * Only populated groups get a heading.
 */
export function NeedsYouQueue({
  items,
  onSelect,
  loading = false,
  errorMessage = null,
  onRetry,
  onAddNotes,
  variant = "rail",
  emptyStateNote = null,
  incompleteNote = null,
}: {
  items: NeedsYouItem[];
  onSelect: (item: NeedsYouItem) => void;
  /** True while ANY source of attention is still resolving. Attention is fed by two
   *  independent reads, and this queue may only report emptiness once both have answered —
   *  so this is deliberately not "the operational flow is loading". */
  loading?: boolean;
  /** Set when project attention could not be loaded. Shown instead of a misleading empty state. */
  errorMessage?: string | null;
  /** Safe retry for the failed load. */
  onRetry?: () => void;
  /** Opens the notes intake — the real way to generate project signals. */
  onAddNotes?: () => void;
  /** Prominence only — `canvas` is the main content rendering. */
  variant?: "canvas" | "rail";
  /** Real monitoring context to show beneath an honest empty state. Never invented. */
  emptyStateNote?: string | null;
  /** Set when the items below are real but not yet the whole answer, because another
   *  attention source has not resolved. Keeps known items visible without letting the
   *  list read as complete. */
  incompleteNote?: string | null;
}) {
  const showEmpty = !loading && !errorMessage && items.length === 0;
  const groups = groupAttentionItems(items);
  // `CommandCenterLayout` may mount this component more than once across responsive
  // surfaces, so a document-global id would appear twice and `aria-labelledby` would
  // resolve to whichever came first, naming the visible section after a hidden heading.
  // Each instance names its own heading, matching `ExecutionQueue`.
  const headingId = useId();
  const canvas = variant === "canvas";
  return (
    <section aria-labelledby={headingId} data-testid="cc-section-needs-you">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          Needs your attention
        </h2>
        {!loading && !errorMessage && items.length > 0 && (
          <span className="shrink-0 text-[11px] text-zinc-500">{items.length}</span>
        )}
      </div>

      {/* Loading and failure are announced, so the state change is not visual-only. */}
      <div role="status" aria-live="polite">
        {loading && items.length === 0 && <SectionLoadingState label="Checking what needs your attention…" />}
        {/* Items already known stay on screen while another source answers — hiding real
            attention would be its own dishonesty — but the list says it is not final. */}
        {loading && items.length > 0 && incompleteNote && (
          <p className="mt-2 px-1 text-[11px] text-zinc-500" data-testid="cc-attention-incomplete">
            {incompleteNote}
          </p>
        )}
        {errorMessage && (
          <div className="mt-2 rounded-xl border border-rose-500/25 bg-rose-500/[0.08] px-3 py-3">
            <p className="text-sm text-rose-200">{errorMessage}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-500/20"
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>

      {showEmpty && (
        <SectionEmptyState
          title="You're clear."
          description="Nothing currently requires your decision or review."
          note={emptyStateNote}
          ctaLabel="Add project notes"
          onCta={onAddNotes}
        />
      )}

      {groups.map((group) => (
        <section key={group.job} aria-labelledby={`${headingId}-${group.job}`} data-testid={`cc-attention-group-${group.job}`} className="mt-3">
          {/* One heading per POPULATED group. An empty heading would promise work that
              does not exist, so a group with no items is not rendered at all. */}
          <h3
            id={`${headingId}-${group.job}`}
            className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500"
          >
            {group.label}
          </h3>
          <ul className={`mt-1.5 ${canvas ? "space-y-2" : "space-y-1.5"}`}>
            {group.items.map((item) => (
              <li key={item.id}>
                <AttentionCard item={item} job={group.job} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
