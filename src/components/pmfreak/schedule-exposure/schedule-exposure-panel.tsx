"use client";

import { useCallback, useEffect, useId, useState } from "react";
import type { ScheduleExposureEvaluation } from "@/lib/critical-path/schedule-exposure";
import type { ScheduleExposureRecord, ScheduleTriggerCandidate } from "@/lib/critical-path/schedule-exposure-service";

/** Evidence confidence is persisted as a 0–1 fraction (numeric(5,4)). */
export function formatEvidenceConfidence(fraction: number): string {
  return Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : "N/A";
}

/** A Finding's (operational_signals) confidence is persisted on a 0–100 scale (numeric(5,2)). */
export function formatFindingScore(percentage: number): string {
  return Number.isFinite(percentage) ? `${Math.round(percentage)}%` : "N/A";
}

const COVERAGE_LABEL: Record<string, string> = {
  COMPLETE: "Complete data",
  PARTIAL: "Partial data",
  UNKNOWN: "Insufficient data",
};

export type ScheduleExposureLoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "denied" }
  | { kind: "ready"; exposures: ScheduleExposureRecord[]; candidates: ScheduleTriggerCandidate[]; canEvaluate: boolean };

export type ScheduleExposureEvaluationFeedback =
  | { kind: "recorded"; disposition: "created" | "duplicate"; evaluation: ScheduleExposureEvaluation }
  | { kind: "not_recorded"; evaluation: ScheduleExposureEvaluation }
  | { kind: "refused"; evaluation: ScheduleExposureEvaluation }
  | { kind: "denied" }
  | { kind: "error"; message: string };

function Badge({ children, tone }: { children: string; tone: "neutral" | "warn" | "danger" | "ok" }) {
  const tones = {
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
    warn: "border-amber-400/30 bg-amber-400/10 text-amber-900",
    danger: "border-rose-400/30 bg-rose-400/10 text-rose-900",
    ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-900",
  } as const;
  return <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function EvaluationFeedback({ feedback }: { feedback: ScheduleExposureEvaluationFeedback }) {
  if (feedback.kind === "denied") {
    return <p role="alert" className="text-sm text-rose-900">You do not have permission to evaluate schedule exposure for this project.</p>;
  }
  if (feedback.kind === "error") {
    return <p role="alert" className="text-sm text-rose-900">{feedback.message}</p>;
  }
  const { evaluation } = feedback;
  const snapshot = <span className="font-mono text-[11px] text-slate-500">{evaluation.snapshot.digest.slice(0, 19)}…</span>;
  if (feedback.kind === "refused") {
    return (
      <div role="alert" data-testid="schedule-exposure-refused" className="rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-3 py-2">
        <p className="text-sm font-medium text-rose-900">Degraded: the schedule topology is invalid.</p>
        <ul className="mt-1 list-disc pl-5 text-xs text-rose-900/90">
          {evaluation.topologyIssues.map((issue, index) => <li key={`${issue.type}-${index}`}>{issue.message}</li>)}
        </ul>
        <p className="mt-1 text-xs text-rose-900/80">No critical path was computed and nothing was recorded. Correct the dependencies, then evaluate again.</p>
      </div>
    );
  }
  if (feedback.kind === "not_recorded" && evaluation.status === "insufficient_data") {
    return (
      <div role="status" data-testid="schedule-exposure-insufficient" className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2">
        <p className="text-sm font-medium text-amber-900">Insufficient schedule data — exposure cannot be stated.</p>
        <ul className="mt-1 list-disc pl-5 text-xs text-amber-900/90">
          {evaluation.missingData.map((item) => <li key={item.code}>{item.message}</li>)}
        </ul>
        <p className="mt-1 text-xs text-amber-900/70">Nothing was recorded. Snapshot {snapshot}</p>
      </div>
    );
  }
  if (feedback.kind === "not_recorded") {
    return (
      <p role="status" data-testid="schedule-exposure-no-exposure" className="text-sm text-slate-700">
        No milestone exposure from this change. Nothing was recorded. Snapshot {snapshot}
      </p>
    );
  }
  return (
    <p role="status" data-testid="schedule-exposure-recorded" className="text-sm text-emerald-900">
      {feedback.disposition === "duplicate"
        ? "Already recorded for this schedule state and change — nothing new was created."
        : "Recorded as Evidence, a Finding and a proposed Recommendation. No decision has been made."}
    </p>
  );
}

/**
 * A chain whose Evidence committed but whose Finding/Recommendation did not. It must never look
 * like a finished exposure: it states what is missing and offers to resume that exact Evidence.
 */
function IncompleteExposureCard({
  record,
  canResume,
  busy,
  onResume,
}: {
  record: ScheduleExposureRecord;
  canResume: boolean;
  busy: boolean;
  onResume?: (record: ScheduleExposureRecord) => void;
}) {
  return (
    <li data-testid="schedule-exposure-incomplete" role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-3">
      <h3 className="text-sm font-medium text-amber-900">{record.title}</h3>
      <p className="mt-1 text-xs text-amber-900/90">
        Schedule evaluation recorded, but the Finding and Recommendation did not finish materializing. No decision or action has been created.
      </p>
      <p className="mt-1 break-all font-mono text-[11px] text-amber-900/60">Evidence {record.evidenceId}</p>
      {canResume ? (
        <button
          type="button"
          data-testid="schedule-exposure-resume"
          disabled={busy}
          onClick={() => onResume?.(record)}
          className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-400/20 disabled:opacity-50"
        >
          {busy ? "Resuming…" : "Resume materialization"}
        </button>
      ) : (
        <p className="mt-2 text-xs text-amber-900/70">A project owner, admin or PM can resume it.</p>
      )}
    </li>
  );
}

function ExposureCard({ record }: { record: ScheduleExposureRecord }) {
  const headingId = useId();
  const coverageTone = record.missingDataState === "COMPLETE" ? "ok" : "warn";
  return (
    <li data-testid="schedule-exposure-item" className="rounded-xl border border-slate-200 bg-white px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} className="min-w-0 text-sm font-medium text-slate-900">{record.title}</h3>
        <div className="flex flex-wrap gap-1">
          {record.severity && <Badge tone={record.severity === "critical" || record.severity === "high" ? "danger" : "warn"}>{`Severity: ${record.severity}`}</Badge>}
          <Badge tone={coverageTone}>{COVERAGE_LABEL[record.missingDataState] ?? record.missingDataState}</Badge>
          <Badge tone="neutral">Inference</Badge>
          {/* Customer wording for DEMO_FIXTURE rows, as the attention read model uses (UX-W0). */}
          {record.fixtureState === "DEMO_FIXTURE" && <Badge tone="warn">Demo data — not a live project record</Badge>}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <div className="sm:col-span-2">
          <dt className="font-semibold text-slate-600">What changed</dt>
          <dd className="mt-0.5 whitespace-pre-line text-slate-700">{record.content.split("\n")[0]?.replace(/^What changed: /, "")}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="font-semibold text-slate-600">Why it matters</dt>
          <dd className="mt-0.5 text-slate-700">
            <ul className="list-disc space-y-0.5 pl-5">
              {record.exposures.map((exposure) => (
                <li key={exposure.milestoneId}>
                  <span className="font-medium text-slate-800">{exposure.title}</span>: {exposure.reasons.join(" ")}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-slate-500">An inference of the deterministic schedule engine, not an observed fact or a cause.</p>
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-600">Confidence</dt>
          <dd className="mt-0.5 text-slate-700">
            <span data-testid="schedule-exposure-confidence">{formatEvidenceConfidence(record.confidence)}</span>
            {record.confidenceMethod && <span className="text-slate-500"> · method {record.confidenceMethod}</span>}
            {record.confidenceDrivers.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-[11px] text-slate-500">
                {record.confidenceDrivers.map((driver) => <li key={driver}>{driver}</li>)}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-600">Coverage</dt>
          <dd className="mt-0.5 text-slate-700" data-testid="schedule-exposure-coverage">
            {record.missingDataState === "COMPLETE" ? "All schedule inputs the engine reads were present." : (
              <ul className="list-disc pl-5">
                {record.missingData.map((item) => <li key={item.code}>{item.message}</li>)}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {record.recommendation && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs">
          <p className="font-semibold text-slate-600">
            Recommendation <span className="font-normal text-slate-500">({record.recommendation.status}; a Decision is recorded separately)</span>
          </p>
          <p className="mt-0.5 text-slate-700">{record.recommendation.recommendation}</p>
        </div>
      )}

      <details className="mt-2 text-xs text-slate-600">
        <summary className="cursor-pointer select-none text-slate-700">Supporting evidence</summary>
        <dl className="mt-1 grid grid-cols-1 gap-1 break-all sm:grid-cols-2">
          <div><dt className="inline font-medium">Snapshot: </dt><dd className="inline font-mono" data-testid="schedule-exposure-snapshot">{record.snapshotDigest}</dd></div>
          <div><dt className="inline font-medium">Evaluated: </dt><dd className="inline"><time dateTime={record.evaluatedAt}>{record.evaluatedAt}</time></dd></div>
          <div><dt className="inline font-medium">Changed: </dt><dd className="inline"><time dateTime={record.occurredAt}>{record.occurredAt}</time></dd></div>
          <div><dt className="inline font-medium">Source: </dt><dd className="inline font-mono">{record.provenance.sourceKey}</dd></div>
          <div><dt className="inline font-medium">Evidence: </dt><dd className="inline font-mono">{record.evidenceId}</dd></div>
          <div><dt className="inline font-medium">Evidence digest: </dt><dd className="inline font-mono">{record.provenance.derivationDigest}</dd></div>
          {record.finding && (
            <div><dt className="inline font-medium">Finding: </dt><dd className="inline">{record.finding.id} · score {formatFindingScore(record.finding.confidenceScore)} · {record.finding.detectedBy}</dd></div>
          )}
          <div><dt className="inline font-medium">Correlation: </dt><dd className="inline font-mono">{record.correlationId}</dd></div>
        </dl>
        {record.engineLimitations.length > 0 && (
          <ul className="mt-1 list-disc pl-5 text-[11px] text-slate-500">
            {record.engineLimitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        )}
      </details>
    </li>
  );
}

export function ScheduleExposureView({
  state,
  feedback = null,
  busyEntityId = null,
  onEvaluate,
  onResume,
  onRetry,
}: {
  state: ScheduleExposureLoadState;
  feedback?: ScheduleExposureEvaluationFeedback | null;
  busyEntityId?: string | null;
  onEvaluate?: (candidate: ScheduleTriggerCandidate) => void;
  onResume?: (record: ScheduleExposureRecord) => void;
  onRetry?: () => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="schedule-exposure-panel" className="rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Schedule exposure</h2>
      </div>

      {state.kind === "loading" && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-600">Loading schedule exposure…</p>
      )}
      {state.kind === "error" && (
        <div role="alert" className="mt-2 rounded-xl border border-rose-500/25 bg-rose-500/[0.08] px-3 py-3">
          <p className="text-sm text-rose-900">{state.message}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-900 hover:bg-rose-500/20">
              Try again
            </button>
          )}
        </div>
      )}
      {state.kind === "denied" && (
        <p role="alert" className="mt-2 text-sm text-rose-900">You do not have access to this project&apos;s schedule exposure.</p>
      )}

      {state.kind === "ready" && (
        <>
          {feedback && <div className="mt-2" aria-live="polite"><EvaluationFeedback feedback={feedback} /></div>}

          {state.exposures.length === 0 ? (
            <p data-testid="schedule-exposure-empty" className="mt-2 text-sm text-slate-600">
              No schedule exposure has been recorded for this project. Evaluate a dependency change or a milestone&apos;s current state below to check it against the critical path.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {state.exposures.map((record) =>
                record.materializationState === "incomplete" ? (
                  <IncompleteExposureCard
                    key={record.evidenceId}
                    record={record}
                    canResume={state.canEvaluate}
                    busy={busyEntityId !== null}
                    onResume={onResume}
                  />
                ) : (
                  <ExposureCard key={record.evidenceId} record={record} />
                ),
              )}
            </ul>
          )}

          {state.canEvaluate && state.candidates.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-semibold text-slate-600">Evaluate a schedule change</h3>
              <ul className="mt-1 space-y-1">
                {state.candidates.map((candidate) => (
                  <li key={`${candidate.kind}:${candidate.entityId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5">
                    <span className="min-w-0 text-xs text-slate-700">
                      <span className="text-slate-500">{candidate.kind === "dependency_change" ? "Dependency change" : "Milestone (current state)"}: </span>
                      {candidate.label} <span className="text-slate-500">({candidate.status})</span>
                    </span>
                    <button
                      type="button"
                      data-testid="schedule-exposure-evaluate"
                      disabled={busyEntityId !== null}
                      onClick={() => onEvaluate?.(candidate)}
                      aria-label={candidate.kind === "dependency_change" ? `Evaluate exposure for dependency ${candidate.label}` : `Evaluate current state of milestone ${candidate.label}`}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
                    >
                      {busyEntityId === candidate.entityId ? "Evaluating…" : "Evaluate exposure"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!state.canEvaluate && (
            <p className="mt-3 text-xs text-slate-500">Only project owners, admins and PMs can evaluate schedule changes.</p>
          )}
        </>
      )}
    </section>
  );
}

export function ScheduleExposurePanel({ workspaceId, projectId, onRecorded }: { workspaceId: string; projectId: string; onRecorded?: () => void }) {
  const [state, setState] = useState<ScheduleExposureLoadState>({ kind: "loading" });
  const [feedback, setFeedback] = useState<ScheduleExposureEvaluationFeedback | null>(null);
  const [busyEntityId, setBusyEntityId] = useState<string | null>(null);

  const fetchState = useCallback(async (): Promise<ScheduleExposureLoadState> => {
    try {
      const params = new URLSearchParams({ workspaceId, projectId });
      const response = await fetch(`/api/critical-path/schedule-exposure?${params.toString()}`, { cache: "no-store" });
      if (response.status === 401 || response.status === 403) return { kind: "denied" };
      const body = (await response.json()) as { ok?: boolean; exposures?: ScheduleExposureRecord[]; candidates?: ScheduleTriggerCandidate[]; canEvaluate?: boolean; error?: string };
      if (!response.ok || !body.ok) return { kind: "error", message: body.error ?? "Schedule exposure could not be loaded." };
      return { kind: "ready", exposures: body.exposures ?? [], candidates: body.candidates ?? [], canEvaluate: Boolean(body.canEvaluate) };
    } catch {
      return { kind: "error", message: "Schedule exposure could not be loaded." };
    }
  }, [workspaceId, projectId]);

  useEffect(() => {
    if (!workspaceId || !projectId) return;
    let cancelled = false;
    void fetchState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchState, workspaceId, projectId]);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    setState(await fetchState());
  }, [fetchState]);

  const evaluate = useCallback(async (candidate: ScheduleTriggerCandidate) => {
    setBusyEntityId(candidate.entityId);
    setFeedback(null);
    try {
      const response = await fetch("/api/critical-path/schedule-exposure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, projectId, trigger: { kind: candidate.kind, entityId: candidate.entityId } }),
      });
      if (response.status === 401 || response.status === 403) return setFeedback({ kind: "denied" });
      const body = (await response.json()) as { disposition?: string; evaluation?: ScheduleExposureEvaluation; error?: string };
      if (response.status === 422 && body.evaluation) return setFeedback({ kind: "refused", evaluation: body.evaluation });
      if (!response.ok || !body.evaluation) return setFeedback({ kind: "error", message: body.error ?? "Schedule exposure could not be evaluated." });
      if (body.disposition === "created" || body.disposition === "duplicate") {
        setFeedback({ kind: "recorded", disposition: body.disposition, evaluation: body.evaluation });
        onRecorded?.();
        await load();
        return;
      }
      setFeedback({ kind: "not_recorded", evaluation: body.evaluation });
    } catch {
      setFeedback({ kind: "error", message: "Schedule exposure could not be evaluated." });
    } finally {
      setBusyEntityId(null);
    }
  }, [workspaceId, projectId, load, onRecorded]);

  const resume = useCallback(async (record: ScheduleExposureRecord) => {
    setBusyEntityId(record.evidenceId);
    setFeedback(null);
    try {
      const response = await fetch("/api/critical-path/schedule-exposure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, projectId, action: "resume_materialization", evidenceId: record.evidenceId }),
      });
      if (response.status === 401 || response.status === 403) return setFeedback({ kind: "denied" });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) return setFeedback({ kind: "error", message: body.error ?? "Materialization could not be resumed." });
      onRecorded?.();
      await load();
    } catch {
      setFeedback({ kind: "error", message: "Materialization could not be resumed." });
    } finally {
      setBusyEntityId(null);
    }
  }, [workspaceId, projectId, load, onRecorded]);

  return <ScheduleExposureView state={state} feedback={feedback} busyEntityId={busyEntityId} onEvaluate={evaluate} onResume={resume} onRetry={load} />;
}
