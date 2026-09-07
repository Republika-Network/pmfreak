"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DecisionPanel, DetailSection, DrawerContent, RecordedDecision } from "./types";
import { StatusBadge } from "./status-badge";
import { CloseIcon } from "./icons";
import { ExecutionChainPanel } from "./execution-chain-panel";

const labelize = (value: string) => value.replaceAll("_", " ");

function RowList({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="mt-1.5 space-y-1">
      {rows.map((row) => (
        <div key={`${row.label}-${row.value}`} className="rounded-lg bg-white/[0.04] px-2.5 py-1.5">
          <dt className="text-[10px] uppercase tracking-[0.1em] text-zinc-500">{row.label}</dt>
          <dd className="mt-0.5 break-words text-xs text-zinc-300">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DisclosureSection({ section }: { section: DetailSection }) {
  return (
    <details className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-zinc-300">{section.title}</summary>
      <RowList rows={section.rows} />
    </details>
  );
}

/**
 * A Decision already recorded against this item, in the primary surface.
 *
 * A non-terminal Decision — `escalated`, `needs_more_evidence` — deliberately leaves the
 * Recommendation open, so an item still awaiting the PM can carry one of these. This card
 * therefore renders in front of a live judgment, and it used to print the canonical
 * Decision id, the raw actor id, the authority basis and the evidence snapshot digest
 * there. That is the audit record, not the history a PM needs to decide.
 *
 * What stays: what was decided, whether it closed the item, why, and when. What moves to
 * `Evidence & governance`: every identifier and every governance internal. Nothing is
 * dropped — see `RecordedDecisionAudit`.
 */
function RecordedDecisionCard({ decision }: { decision: RecordedDecision }) {
  return (
    <div className="mt-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
      <p className="text-xs font-semibold text-emerald-300">
        Decision recorded — {labelize(decision.decisionStatus)}
        {decision.terminal ? "" : " (recommendation stays open)"}
      </p>
      <RowList
        rows={[
          ...(decision.rationale ? [{ label: "Rationale", value: decision.rationale }] : []),
          ...(decision.recordedAt ? [{ label: "Recorded at", value: decision.recordedAt }] : []),
        ]}
      />
    </div>
  );
}

/** The same Decisions, complete, behind the disclosure. Every field the read model
 *  projects is here — the canonical record is preserved in full, just not in front of a
 *  human trying to make the next judgment. */
function RecordedDecisionAudit({ decisions }: { decisions: RecordedDecision[] }) {
  if (decisions.length === 0) return null;
  return (
    <details className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2" data-testid="cc-decision-record-details">
      <summary className="cursor-pointer text-xs font-medium text-zinc-300">Decision record details</summary>
      {decisions.map((decision) => (
        <div key={decision.decisionId} className="mt-2">
          <p className="text-[11px] font-medium text-zinc-400">{labelize(decision.decisionStatus)}</p>
          <RowList
            rows={[
              { label: "Decision ID", value: decision.decisionId },
              ...(decision.recordedAt ? [{ label: "Recorded at", value: decision.recordedAt }] : []),
              ...(decision.decidedBy ? [{ label: "Decided by", value: decision.decidedBy }] : []),
              ...(decision.authorityBasis ? [{ label: "Authority basis", value: decision.authorityBasis }] : []),
              ...(decision.rationale ? [{ label: "Rationale", value: decision.rationale }] : []),
              ...(decision.evidenceSnapshot ? [{ label: "Evidence snapshot", value: decision.evidenceSnapshot }] : []),
            ]}
          />
        </div>
      ))}
    </details>
  );
}

/**
 * The decision experience for one attention item.
 *
 * Authority is honoured per canonical Decision status: only statuses the server evaluated as
 * allowed are rendered as controls. Denied statuses are listed as text with their reason, so the
 * denial is never communicated by colour alone and a denied control can never be pressed.
 */
function DecisionSection({ panel, headingId }: { panel: DecisionPanel; headingId: string }) {
  const [rationale, setRationale] = useState("");
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rationaleId = useId();

  const allowed = panel.controls.filter((control) => control.allowed);
  const denied = panel.controls.filter((control) => !control.allowed);
  const terminalDecision = panel.decisions.find((decision) => decision.terminal) ?? null;
  const rationaleMissing = panel.requiresRationale && rationale.trim().length === 0;

  const submit = async (status: string) => {
    setPendingStatus(status);
    setError(null);
    try {
      await panel.onDecide(status, rationale.trim());
      // Success is never assumed: the caller only resolves after the server persisted the write
      // and the canonical summary was revalidated. The refreshed record renders below.
      setRationale("");
    } catch (caught) {
      // Keep the drawer open and the rationale intact so the PM can retry.
      setError(caught instanceof Error ? caught.message : "We couldn't record that decision. Please try again.");
    } finally {
      setPendingStatus(null);
    }
  };

  return (
    <section aria-labelledby={headingId} className="mt-5 border-t border-white/10 pt-4">
      <h3 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
        Your decision
      </h3>

      {panel.decisions.length > 0 && (
        <div className="mt-3">
          {panel.decisions.map((decision) => (
            <RecordedDecisionCard key={decision.decisionId} decision={decision} />
          ))}
        </div>
      )}

      {panel.blockedReason && (
        <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-200">
          {panel.blockedReason}
        </p>
      )}

      {terminalDecision ? (
        <p className="mt-3 text-xs text-zinc-400">
          This recommendation has been decided. No further decision can be recorded against it.
        </p>
      ) : (
        <>
          {allowed.length > 0 && (
            <div className="mt-3">
              <label htmlFor={rationaleId} className="text-[11px] font-medium text-zinc-400">
                Rationale{panel.requiresRationale ? " (required)" : " (optional)"}
              </label>
              <textarea
                id={rationaleId}
                rows={3}
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                placeholder="Why are you deciding this?"
                className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] p-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-sky-500/40 focus:outline-none"
              />
              <ul className="mt-2 flex flex-col gap-2">
                {allowed.map((control) => (
                  <li key={control.status}>
                    <button
                      type="button"
                      onClick={() => void submit(control.status)}
                      disabled={pendingStatus !== null || rationaleMissing}
                      aria-describedby={`${rationaleId}-${control.status}-effect`}
                      className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-xs font-medium text-zinc-200 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pendingStatus === control.status ? `Recording ${labelize(control.status)}…` : control.label}
                    </button>
                    <p id={`${rationaleId}-${control.status}-effect`} className="mt-1 px-1 text-[11px] leading-relaxed text-zinc-500">
                      {control.effect}
                    </p>
                  </li>
                ))}
              </ul>
              {rationaleMissing && (
                <p className="mt-2 text-[11px] text-zinc-500">Add a rationale to record a decision.</p>
              )}
            </div>
          )}

          {denied.length > 0 && (
            <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
              <p className="text-[11px] font-medium text-zinc-400">Not available to you</p>
              <ul className="mt-1 space-y-1">
                {denied.map((control) => (
                  <li key={control.status} className="text-[11px] leading-relaxed text-zinc-500">
                    <span className="text-zinc-400">{control.label}</span> — {control.deniedExplanation}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!panel.anyAllowed && panel.readOnlyNote && (
            <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-200">
              {panel.readOnlyNote}
            </p>
          )}
        </>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {pendingStatus ? `Recording ${labelize(pendingStatus)} decision.` : ""}
      </p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-3 py-2 text-xs text-rose-200">
          {error}
        </p>
      )}
    </section>
  );
}

export function DetailDrawer({ content, onClose }: { content: DrawerContent | null; onClose: () => void }) {
  const open = content !== null;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const decisionHeadingId = useId();

  // Move focus into the drawer when it opens and return it to the triggering control on close.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      headingRef.current?.focus();
      return;
    }
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (previous && document.contains(previous)) previous.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={`absolute right-0 top-0 h-full w-full max-w-sm border-l border-white/10 bg-[#0b0b0e] shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {content && (
          <div className="flex h-full flex-col overflow-y-auto p-5">
            <div className="flex items-start justify-between gap-3">
              <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-base font-semibold leading-snug text-zinc-100 focus:outline-none">
                {content.title}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 rounded-lg p-1 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>

            {/*
              An attention item's badge names its SOURCE — "Governed · decision required",
              "Suggestion · extracted intelligence". That distinction is a contract and is
              preserved verbatim beneath `Evidence & governance`; it is simply not the first
              thing a PM should read, because it answers a question about PMFreak's
              architecture rather than about their project. Every other drawer type — agent
              cards, governed execution chains — keeps its badge here, so this is gated on
              the decision panel rather than applied to the component as a whole.
            */}
            {content.badge && !content.decisionPanel && (
              <div className="mt-2">
                <StatusBadge tone={content.badge.tone}>{content.badge.label}</StatusBadge>
              </div>
            )}

            <section aria-labelledby={`${headingId}-why`} className="mt-5">
              <h3 id={`${headingId}-why`} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                Why this matters
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-300">{content.why}</p>
            </section>

            <section aria-labelledby={`${headingId}-evidence`} className="mt-5">
              <h3 id={`${headingId}-evidence`} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                Evidence
              </h3>
              <ul className="mt-1.5 space-y-1">
                {content.evidence.map((item) => (
                  <li key={item} className="rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-xs text-zinc-300">
                    {item}
                  </li>
                ))}
              </ul>
            </section>

            <div className="mt-5 rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-sky-300">PMFreak recommends</p>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-200">{content.recommendation ?? content.nextStep}</p>
              {/* The caveat qualifies the recommendation; it is never presented AS the
                  recommendation, which is what "Suggested next step" used to do here. */}
              {content.recommendation && content.nextStep && content.nextStep !== content.recommendation && (
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">{content.nextStep}</p>
              )}
            </div>

            {/* Keyed by subject so switching items remounts the form — a draft rationale can
                never leak from one recommendation onto another. */}
            {content.decisionPanel && (
              <DecisionSection key={content.decisionPanel.subjectId} panel={content.decisionPanel} headingId={decisionHeadingId} />
            )}

            {/*
              UX-W3 — progressive disclosure.

              Everything below this point is the canonical record: how PMFreak got here, the
              provenance of the evidence, its quality, the governance rule and authority, and
              the canonical references. None of it is deleted, none of it is changed, and all
              of it stays one click away. It simply no longer stands between a PM and their
              judgment: it sits AFTER the decision controls, collapsed, for the reader who
              wants to audit rather than decide.
            */}
            {((content.chain && content.chain.length > 0) || (content.sections && content.sections.length > 0)) && (
              <section aria-labelledby={`${headingId}-detail`} className="mt-6 border-t border-white/10 pt-4">
                <h3 id={`${headingId}-detail`} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  Evidence &amp; governance
                </h3>
                {content.chain && content.chain.length > 0 && (
                  <details className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-zinc-300">How PMFreak got here</summary>
                    <RowList rows={content.chain} />
                  </details>
                )}
                {(content.sections ?? []).map((section) => (
                  <DisclosureSection key={section.id} section={section} />
                ))}
                {/* What kind of object this is, and exactly what a decision on it writes.
                    Both are preserved verbatim — the two attention sources deliberately use
                    different language here and that difference is a contract, not styling.
                    They simply no longer sit above the judgment, where a table name in front
                    of a PM is noise rather than provenance. */}
                {content.decisionPanel && (
                  <RecordedDecisionAudit decisions={content.decisionPanel.decisions} />
                )}
                {(content.kindSummary || content.decisionPanel?.writePathLabel || content.badge) && (
                  <details className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-zinc-300">What this is, and what a decision records</summary>
                    {content.decisionPanel && content.badge && (
                      <p className="mt-2">
                        <StatusBadge tone={content.badge.tone}>{content.badge.label}</StatusBadge>
                      </p>
                    )}
                    {content.kindSummary && <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">{content.kindSummary}</p>}
                    {content.decisionPanel?.writePathLabel && (
                      <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">{content.decisionPanel.writePathLabel}</p>
                    )}
                  </details>
                )}
              </section>
            )}

            {/* P2-12: keyed by the canonical Decision so switching chains remounts the
                stage forms and no draft can leak between chains. */}
            {content.executionPanel && (
              <ExecutionChainPanel
                key={content.executionPanel.chain.decisionId}
                chain={content.executionPanel.chain}
                evidenceOptions={content.executionPanel.evidenceOptions}
                onRun={content.executionPanel.onRun}
                refreshFailedAfterWrite={content.executionPanel.refreshFailedAfterWrite}
                onRetryRefresh={content.executionPanel.onRetryRefresh}
              />
            )}

            {(content.actions ?? []).length > 0 && (
              <div className="mt-auto flex flex-wrap gap-2 pt-6">
                {(content.actions ?? []).map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={action.onClick}
                    disabled={action.disabled}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            {content.note && <p className="mt-3 text-[11px] text-amber-300">{content.note}</p>}
          </div>
        )}
      </aside>
    </div>
  );
}
