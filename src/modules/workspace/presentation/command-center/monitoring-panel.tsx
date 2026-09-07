import { useId, type ReactNode } from "react";
import type { MonitoringSummary } from "./operational-data";
import { SectionEmptyState, SectionLoadingState } from "./section-empty-state";
import { toneStyles } from "./status-badge";

/**
 * "PMFreak is monitoring" — the compact answer to "what is being watched for me".
 *
 * The default Command Center should not ask a PM to hold nine AI personas in their head.
 * This surface states the coverage instead: one line per signal family PMFreak actually
 * watches, each carrying the real count of persisted signals in it. The specialist roster
 * is preserved verbatim behind the disclosure below (`detail`), which is collapsed by
 * default — it is supporting information, not the primary experience.
 *
 * The total is stated as signals DETECTED, never as signals that are "new": nothing in the
 * read model records what this PM has already looked at, so novelty would be invented.
 */
export function MonitoringPanel({
  summary,
  /** True once the project has real recorded evidence for PMFreak to read. */
  active,
  loading = false,
  errorMessage = null,
  onRetry,
  onAddContext,
  /** The specialist roster, rendered inside the collapsed disclosure. */
  detail,
}: {
  summary: MonitoringSummary;
  active: boolean;
  loading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
  onAddContext?: () => void;
  detail?: ReactNode;
}) {
  const headingId = useId();
  const showCoverage = !loading && !errorMessage && active;
  const showEmpty = !loading && !errorMessage && !active;
  return (
    <section aria-labelledby={headingId} data-testid="cc-section-monitoring">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 px-1">
        <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          PMFreak is monitoring
        </h2>
        {showCoverage && (
          <span className="text-[11px] text-zinc-500">
            {summary.totalSignals === 0
              ? "No signals detected"
              : `${summary.totalSignals} signal${summary.totalSignals === 1 ? "" : "s"} detected`}
          </span>
        )}
      </div>

      <div role="status" aria-live="polite">
        {loading && <SectionLoadingState label="Checking what PMFreak is watching…" />}
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
          title="Monitoring starts with your first project evidence."
          description="PMFreak watches risks, schedule, scope, budget and stakeholders as soon as this project has something recorded to read."
          ctaLabel="Add project notes"
          onCta={onAddContext}
        />
      )}

      {showCoverage && (
        <ul className="mt-2 space-y-0.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
          {summary.areas.map((area) => (
            <li key={area.id} data-testid="cc-monitoring-area" className="flex items-center justify-between gap-2 py-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneStyles(area.tone).dot}`} />
                <span className="truncate text-sm text-zinc-300">{area.label}</span>
              </span>
              <span className={`shrink-0 text-[11px] ${area.signalCount > 0 ? toneStyles(area.tone).text : "text-zinc-500"}`}>
                {area.statusLabel}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* A failed read has no monitoring state to disclose. Rendering the roster here would
          show every discipline as "Clear" on the strength of a payload that never arrived —
          an error redressed as good news, which is the one thing an honest surface may not
          do. The failure and its retry stand alone until the read succeeds. */}
      {detail && !errorMessage && (
        <details className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2" data-testid="cc-monitoring-detail">
          <summary className="cursor-pointer text-[11px] font-medium text-zinc-500 transition hover:text-zinc-300">
            View monitors
          </summary>
          <div className="mt-2">{detail}</div>
        </details>
      )}
    </section>
  );
}
