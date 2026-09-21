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
    neutral: "border-white/15 bg-white/[0.04] text-zinc-300",
    warn: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    danger: "border-rose-400/30 bg-rose-400/10 text-rose-200",
    ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  } as const;
  return <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function EvaluationFeedback({ feedback }: { feedback: ScheduleExposureEvaluationFeedback }) {
  if (feedback.kind === "denied") {
    return <p role="alert" className="text-sm text-rose-200">You do not have permission to evaluate schedule exposure for this project.</p>;
  }
  if (feedback.kind === "error") {
    return <p role="alert" className="text-sm text-rose-200">{feedback.message}</p>;
  }
  const { evaluation } = feedback;
  const snapshot = <span className="font-mono text-[11px] text-zinc-500">{evaluation.snapshot.digest.slice(0, 19)}…</span>;
  if (feedback.kind === "refused") {
    return (
      <div role="alert" data-testid="schedule-exposure-refused" className="rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-3 py-2">
        <p className="text-sm font-medium text-rose-200">Degraded: the schedule topology is invalid.</p>
        <ul className="mt-1 list-disc pl-5 text-xs text-rose-200/90">
          {evaluation.topologyIssues.map((issue, index) => <li key={`${issue.type}-${index}`}>{issue.message}</li>)}
        </ul>
        <p className="mt-1 text-xs text-rose-200/80">No critical path was computed and nothing was recorded. Correct the dependencies, then evaluate again.</p>
      </div>
    );
  }
  if (feedback.kind === "not_recorded" && evaluation.status === "insufficient_data") {
    return (
      <div role="status" data-testid="schedule-exposure-insufficient" className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2">
        <p className="text-sm font-medium text-amber-200">Insufficient schedule data — exposure cannot be stated.</p>
        <ul className="mt-1 list-disc pl-5 text-xs text-amber-100/90">
          {evaluation.missingData.map((item) => <li key={item.code}>{item.message}</li>)}
        </ul>
        <p className="mt-1 text-xs text-amber-100/70">Nothing was recorded. Snapshot {snapshot}</p>
      </div>
    );
  }
  if (feedback.kind === "not_recorded") {
    return (
      <p role="status" data-testid="schedule-exposure-no-exposure" className="text-sm text-zinc-300">
        No milestone exposure from this change. Nothing was recorded. Snapshot {snapshot}
      </p>
    );
  }
  return (
    <p role="status" data-testid="schedule-exposure-recorded" className="text-sm text-emerald-200">
      {feedback.disposition === "duplicate"
        ? "Already recorded for this schedule state and change — nothing new was created."
        : "Recorded as Evidence, a Finding and a proposed Recommendation. No decision has been made."}
    </p>
  );
}

function ExposureCard({ record }: { record: ScheduleExposureRecord }) {
  const headingId = useId();
  const coverageTone = record.missingDataState === "COMPLETE" ? "ok" : "warn";
  return (
    <li data-testid="schedule-exposure-item" className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} className="min-w-0 text-sm font-medium text-zinc-100">{record.title}</h3>
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
          <dt className="font-semibold text-zinc-400">What changed</dt>
          <dd className="mt-0.5 whitespace-pre-line text-zinc-300">{record.content.split("\n")[0]?.replace(/^What changed: /, "")}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="font-semibold text-zinc-400">Why it matters</dt>
          <dd className="mt-0.5 text-zinc-300">
            <ul className="list-disc space-y-0.5 pl-5">
              {record.exposures.map((exposure) => (
                <li key={exposure.milestoneId}>
                  <span className="font-medium text-zinc-200">{exposure.title}</span>: {exposure.reasons.join(" ")}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-zinc-500">An inference of the deterministic schedule engine, not an observed fact or a cause.</p>
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-zinc-400">Confidence</dt>
          <dd className="mt-0.5 text-zinc-300">
            <span data-testid="schedule-exposure-confidence">{formatEvidenceConfidence(record.confidence)}</span>
            {record.confidenceMethod && <span className="text-zinc-500"> · method {record.confidenceMethod}</span>}
            {record.confidenceDrivers.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-[11px] text-zinc-500">
                {record.confidenceDrivers.map((driver) => <li key={driver}>{driver}</li>)}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-zinc-400">Coverage</dt>
          <dd className="mt-0.5 text-zinc-300" data-testid="schedule-exposure-coverage">
            {record.missingDataState === "COMPLETE" ? "All schedule inputs the engine reads were present." : (
              <ul className="list-disc pl-5">
                {record.missingData.map((item) => <li key={item.code}>{item.message}</li>)}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {record.recommendation && (
        <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2 text-xs">
          <p className="font-semibold text-zinc-400">
            Recommendation <span className="font-normal text-zinc-500">({record.recommendation.status}; a Decision is recorded separately)</span>
          </p>
          <p className="mt-0.5 text-zinc-300">{record.recommendation.recommendation}</p>
        </div>
      )}

      <details className="mt-2 text-xs text-zinc-400">
        <summary className="cursor-pointer select-none text-zinc-300">Supporting evidence</summary>
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
          <ul className="mt-1 list-disc pl-5 text-[11px] text-zinc-500">
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
  onRetry,
}: {
  state: ScheduleExposureLoadState;
  feedback?: ScheduleExposureEvaluationFeedback | null;
  busyEntityId?: string | null;
  onEvaluate?: (candidate: ScheduleTriggerCandidate) => void;
  onRetry?: () => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="schedule-exposure-panel" className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Schedule exposure</h2>
      </div>

      {state.kind === "loading" && (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-zinc-400">Loading schedule exposure…</p>
      )}
      {state.kind === "error" && (
        <div role="alert" className="mt-2 rounded-xl border border-rose-500/25 bg-rose-500/[0.08] px-3 py-3">
          <p className="text-sm text-rose-200">{state.message}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20">
              Try again
            </button>
          )}
        </div>
      )}
      {state.kind === "denied" && (
        <p role="alert" className="mt-2 text-sm text-rose-200">You do not have access to this project&apos;s schedule exposure.</p>
      )}

      {state.kind === "ready" && (
        <>
          {feedback && <div className="mt-2" aria-live="polite"><EvaluationFeedback feedback={feedback} /></div>}

          {state.exposures.length === 0 ? (
            <p data-testid="schedule-exposure-empty" className="mt-2 text-sm text-zinc-400">
              No schedule exposure has been recorded for this project. Evaluate a dependency or milestone change below to check it against the critical path.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {state.exposures.map((record) => <ExposureCard key={record.evidenceId} record={record} />)}
            </ul>
          )}

          {state.canEvaluate && state.candidates.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-semibold text-zinc-400">Evaluate a schedule change</h3>
              <ul className="mt-1 space-y-1">
                {state.candidates.map((candidate) => (
                  <li key={`${candidate.kind}:${candidate.entityId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 px-2.5 py-1.5">
                    <span className="min-w-0 text-xs text-zinc-300">
                      <span className="text-zinc-500">{candidate.kind === "dependency_change" ? "Dependency" : "Milestone"}: </span>
                      {candidate.label} <span className="text-zinc-500">({candidate.status})</span>
                    </span>
                    <button
                      type="button"
                      data-testid="schedule-exposure-evaluate"
                      disabled={busyEntityId !== null}
                      onClick={() => onEvaluate?.(candidate)}
                      aria-label={`Evaluate exposure for ${candidate.kind === "dependency_change" ? "dependency" : "milestone"} ${candidate.label}`}
                      className="rounded-lg border border-white/15 bg-white/[0.05] px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-white/10 disabled:opacity-50"
                    >
                      {busyEntityId === candidate.entityId ? "Evaluating…" : "Evaluate exposure"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!state.canEvaluate && (
            <p className="mt-3 text-xs text-zinc-500">Only project owners, admins and PMs can evaluate schedule changes.</p>
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

  return <ScheduleExposureView state={state} feedback={feedback} busyEntityId={busyEntityId} onEvaluate={evaluate} onRetry={load} />;
}
