/** Honest empty state for a Command Center section: what it means, why it is
 *  empty, and what the user can do now. Never renders placeholder data. */
export function SectionEmptyState({
  title,
  description,
  ctaLabel,
  onCta,
  note,
}: {
  title: string;
  description: string;
  ctaLabel?: string;
  onCta?: () => void;
  /** Real supporting context for the emptiness, e.g. what is still being monitored.
   *  Omitted entirely when the caller has no true statement to make. */
  note?: string | null;
}) {
  return (
    <div className="mt-2 rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-3 py-3">
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">{description}</p>
      {note && <p className="mt-2 text-xs leading-relaxed text-zinc-500">{note}</p>}
      {ctaLabel && onCta && (
        <button
          type="button"
          onClick={onCta}
          className="mt-2.5 rounded-lg border border-sky-500/25 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-300 transition hover:bg-sky-500/15"
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}

/** Muted placeholder while a section's real data is still loading. */
export function SectionLoadingState({ label }: { label: string }) {
  return <p className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5 text-xs text-zinc-500">{label}</p>;
}
