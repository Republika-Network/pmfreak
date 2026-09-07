import type { NeedsYouItem } from "./types";
import type { AttentionHumanJob } from "./attention-presentation";
import { HUMAN_JOB_ITEM_LABELS } from "./attention-presentation";
import { StatusBadge } from "./status-badge";

/**
 * One attention card.
 *
 * The card answers three questions without anything being opened — what needs me, why, and
 * what does PMFreak recommend — and a fourth, what is this based on, when the source has
 * evidence to name. A PM should be able to read it in seconds.
 *
 * What is deliberately NOT here: the six canonical lifecycle rows, governance evaluation
 * tables, authority requirements, provenance, confidence, evidence hashes and canonical
 * ids. All of it still exists and none of it is deleted — it lives one click away, beneath
 * the drawer's collapsed detail, because a PM should not have to parse a governance model
 * to find out whether something needs them.
 *
 * Every line renders only when the source actually has it. There is no invented severity,
 * no generated business impact and no plausible-sounding filler: a card with thin data is
 * a shorter card, not a fabricated one.
 */
export function AttentionCard({
  item,
  job,
  onSelect,
}: {
  item: NeedsYouItem;
  job: AttentionHumanJob;
  onSelect: (item: NeedsYouItem) => void;
}) {
  const headline = item.subject ?? item.title;
  const severity = item.severity ?? null;
  // The recommendation is dropped when it would repeat the headline verbatim.
  const recommendation = item.recommendation && item.recommendation !== headline ? item.recommendation : null;

  return (
    <button
      type="button"
      data-testid="cc-attention-card"
      data-human-job={job}
      onClick={() => onSelect(item)}
      className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5 text-left transition hover:border-white/20 hover:bg-white/[0.05] focus:border-sky-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
    >
      <span className="flex flex-wrap items-center gap-2">
        {severity && (
          <StatusBadge tone={item.badge.tone}>
            <span data-testid="cc-attention-severity">{severity}</span>
          </StatusBadge>
        )}
        <span
          data-testid="cc-attention-job"
          className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400"
        >
          {HUMAN_JOB_ITEM_LABELS[job]}
        </span>
      </span>

      <span className="mt-2 block text-[15px] font-medium leading-snug text-zinc-100" data-testid="cc-attention-title">
        {headline}
      </span>

      {item.whyItMatters && (
        <span className="mt-2.5 block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Why this matters</span>
          <span className="mt-1 block text-sm leading-relaxed text-zinc-300" data-testid="cc-attention-why">
            {item.whyItMatters}
          </span>
        </span>
      )}

      {recommendation && (
        <span className="mt-2.5 block">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">PMFreak recommends</span>
          <span className="mt-1 block text-sm leading-relaxed text-zinc-200" data-testid="cc-attention-recommendation">
            {recommendation}
          </span>
        </span>
      )}

      {item.evidenceSummary && (
        <span className="mt-2.5 block text-xs text-zinc-500" data-testid="cc-attention-evidence">
          Based on: {item.evidenceSummary}
        </span>
      )}

      {/* The card opens the judgment surface rather than offering Approve/Reject inline:
          deciding is a considered act, and the supporting context lives one click away. */}
      <span className="mt-3 block text-xs font-medium text-sky-300" data-testid="cc-attention-cta">
        Review recommendation →
      </span>
    </button>
  );
}
