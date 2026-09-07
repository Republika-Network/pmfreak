import { useId } from "react";
import type { ChangeItem } from "./change-read-model";
import { StatusBadge } from "./status-badge";
import { SectionEmptyState, SectionLoadingState } from "./section-empty-state";

/**
 * "What changed" — the third question a PM asks, answered from records that already exist.
 *
 * Every line is one persisted signal row. There is no impact statement, no trend and no
 * "since your last visit": the read model does not compute any of those, so this surface
 * does not imply them. A row with no persisted timestamp simply shows no time.
 *
 * Empty, unavailable and failed stay three different screens. A failed read renders the
 * failure and a retry — never the empty state, which would read as "nothing has changed".
 */
export function WhatChangedPanel({
  items,
  loading = false,
  errorMessage = null,
  onRetry,
}: {
  items: ChangeItem[];
  loading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
}) {
  const headingId = useId();
  const showEmpty = !loading && !errorMessage && items.length === 0;
  return (
    <section aria-labelledby={headingId} data-testid="cc-section-what-changed">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          What changed
        </h2>
      </div>

      <div role="status" aria-live="polite">
        {loading && items.length === 0 && <SectionLoadingState label="Checking what changed…" />}
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
          title="No meaningful changes detected yet."
          description="Changes appear here as PMFreak reads new project evidence. Nothing has been detected for this project so far."
        />
      )}

      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li
            key={item.id}
            data-testid="cc-change-item"
            className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 text-sm font-medium text-zinc-200">{item.title}</p>
              {item.severityLabel && <StatusBadge tone={item.tone}>{item.severityLabel}</StatusBadge>}
            </div>
            {item.detail && <p className="mt-1 text-xs leading-relaxed text-zinc-400">{item.detail}</p>}
            {item.whenLabel && (
              <p className="mt-1 text-[11px] text-zinc-500">
                <time dateTime={item.occurredAt ?? undefined}>{item.whenLabel}</time>
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
