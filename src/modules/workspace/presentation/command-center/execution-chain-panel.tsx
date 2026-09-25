"use client";

/**
 * P2-12 — the PM Execution Center continuation surface.
 *
 * Renders what happens AFTER a Decision is recorded, as one continuous story:
 *   governed Material Action -> canonical Task -> internal Execution
 *   -> expected Outcome -> evidence-backed Observation -> review and lineage
 *
 * Every control calls an operation that already existed before P2-12. This component
 * defines no aggregate, mints no canonical id, invents no status, and never reports
 * success before the authoritative server write returns. Stage gating comes from
 * `execution-read-model.ts`, which derives it from persisted rows and the server's own
 * eligibility rules — never from a client-side role name.
 */

import { useId, useState } from "react";
import {
  MATERIAL_ACTION_CLASSES,
  MATERIAL_ACTION_RISKS,
  MATERIAL_ACTION_REVERSIBILITY,
  MATERIAL_ACTION_SIDE_EFFECTS,
  MISSING_DATA_STATES,
  type ExecutionOperation,
  type ExecutionStage,
  type GovernedActionBranch,
  type GovernedActionView,
  type GovernedExecutionChain,
  type ExecutionStageKey,
} from "./execution-read-model";

/** Plain-language help for the P2-06 classification the human must supply. */
const MISSING_DATA_HELP: Record<string, string> = {
  COMPLETE: "All the data needed to judge this was available.",
  PARTIAL: "Some of the data needed was missing.",
  UNKNOWN: "It is not known whether data was missing.",
};

function Choice({
  id,
  label,
  value,
  options,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
  hint?: string;
}) {
  return (
    <div className="mt-2">
      <label htmlFor={id} className="text-[11px] font-medium text-slate-600">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800 focus:border-sky-500/40 focus:outline-none"
      >
        <option value="">Choose…</option>
        {options.map((option) => (
          <option key={option} value={option}>{option.replaceAll("_", " ")}</option>
        ))}
      </select>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{hint}</p>}
    </div>
  );
}

const OBSERVATION_STATES: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: "achieved", label: "Achieved", hint: "Evidence supports the expected outcome." },
  { value: "partial", label: "Partially achieved", hint: "Evidence supports only part of the expected outcome." },
  { value: "failed", label: "Not achieved", hint: "Evidence shows the expected outcome did not happen." },
  { value: "disputed", label: "Disputed", hint: "Evidence conflicts. Recorded as disputed, not resolved." },
  { value: "inconclusive", label: "Inconclusive", hint: "Evidence cannot settle whether it happened." },
];

function labelize(value: string | null): string {
  return value ? value.replaceAll("_", " ") : "—";
}

function StageRow({
  stage,
  children,
}: {
  stage: ExecutionStage;
  children?: React.ReactNode;
}) {
  const stateLabel = stage.state === "complete" ? "Complete" : stage.state === "present" ? "Recorded" : "Not started";
  return (
    <li className="border-t border-slate-200 pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold text-slate-800">{stage.label}</h4>
        {/* State is conveyed as text, never by colour alone. */}
        <span className="text-[11px] text-slate-600">{stateLabel}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{stage.effect}</p>
      {stage.blockedReason && (
        <p className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-600">
          {stage.blockedReason}
        </p>
      )}
      {children}
    </li>
  );
}

/** Human-readable label for a canonical P2-08 command. The canonical verb is kept — no
 *  command is renamed into a friendlier concept the contract does not have. */
const COMMAND_LABEL: Record<string, string> = {
  queue: "Queue internal execution",
  start: "Start",
  block: "Mark blocked",
  fail: "Mark failed",
  retry: "Retry",
  complete: "Mark complete",
};

/** What the persisted authorization actually says about its own validity. P2-07 refuses
 *  dispatch on the Action's `expires_at` AND on the evaluation's `valid_until`, so a
 *  lapse of either is stated here rather than left for a server rejection to reveal. */
function authorizationLabel(action: GovernedActionView): string {
  if (action.expired) return `expired ${action.expiresAt ?? ""}`.trim();
  if (action.evaluationStale) return `evaluation no longer valid as of ${action.validUntil ?? ""}`.trim();
  if (action.expiresAt) return `valid until ${action.expiresAt}`;
  return "no expiry recorded";
}

/**
 * One canonical Material Action and the work persisted beneath it.
 *
 * Each branch owns its own drafts and its own error, so two Actions on the same Decision
 * can never share input or report each other's failures.
 */
function BranchSection({
  branch,
  onRun,
  evidenceOptions,
  position,
  total,
}: {
  branch: GovernedActionBranch;
  onRun: (operation: ExecutionOperation) => Promise<void>;
  evidenceOptions: Array<{ id: string; title: string }>;
  position: number;
  total: number;
}) {
  const expectedId = useId();
  const summaryId = useId();
  const stateId = useId();
  const qualityId = useId();
  const branchHeadingId = useId();

  const [pending, setPending] = useState<ExecutionStageKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expectedResult, setExpectedResult] = useState("");
  const [observationState, setObservationState] = useState("achieved");
  const [observationSummary, setObservationSummary] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  // P2-09 evidence quality, supplied by the observer rather than assumed.
  const [confidence, setConfidence] = useState("");
  const [missingDataState, setMissingDataState] = useState("");

  const stage = (key: ExecutionStageKey) => branch.stages.find((entry) => entry.key === key)!;
  const taskStage = stage("task");
  const executionStage = stage("execution");
  const outcomeStage = stage("outcome");
  const observationStage = stage("observation");
  const reviewStage = stage("review");

  async function run(key: ExecutionStageKey, operation: ExecutionOperation) {
    setPending(key);
    setError(null);
    try {
      await onRun(operation);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The operation could not be completed.");
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const selectedEvidence = evidenceId || evidenceOptions[0]?.id || "";
  /** This branch's persisted correlation: P2-06 sets it on the Action and P2-08 copies it
   *  onto the Execution, so Outcome and Observation join the same chain rather than
   *  starting a disconnected one. */
  const correlationId = branch.action.correlationId ?? "";
  const confidenceValue = Number(confidence);
  const confidenceValid = confidence !== "" && Number.isFinite(confidenceValue) && confidenceValue >= 0 && confidenceValue <= 1;
  const observationComplete =
    observationSummary.trim().length > 0 && Boolean(selectedEvidence) && confidenceValid && Boolean(missingDataState);
  // Resolved by the read model from persisted state and the actor's own identity, so a
  // control is only offered when the P2-08 contract can actually accept it. Deliberately
  // not re-derived here: one list, one place it can be wrong.
  const commands = branch.offeredCommands;

  return (
    <li className="border-t border-slate-200 pt-3" data-branch-id={branch.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id={branchHeadingId} className="text-xs font-semibold text-slate-800">
          {total > 1 ? `Material action ${position} of ${total}` : "Governed material action"}
        </h4>
        <span className="text-[11px] text-slate-600">{labelize(branch.action.governanceState)}</span>
      </div>
      <dl className="mt-2 grid gap-1 text-[11px] text-slate-600">
        <div className="flex gap-2"><dt className="text-slate-500">Action</dt><dd className="font-mono">{branch.action.actionId}</dd></div>
        <div className="flex gap-2"><dt className="text-slate-500">Governance</dt><dd>{labelize(branch.action.governanceState)}</dd></div>
        <div className="flex gap-2"><dt className="text-slate-500">Executable</dt><dd>{branch.action.canExecute ? "yes" : "no — authorization is not execution"}</dd></div>
        <div className="flex gap-2">
          <dt className="text-slate-500">Authorization</dt>
          <dd>{authorizationLabel(branch.action)}</dd>
        </div>
      </dl>
      <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-700">
        {branch.boundary.statement}
      </p>

      <ol className="mt-2 space-y-3" aria-labelledby={branchHeadingId}>
        <StageRow stage={taskStage}>
          {branch.task ? (
            <dl className="mt-2 grid gap-1 text-[11px] text-slate-600">
              <div className="flex gap-2"><dt className="text-slate-500">Task</dt><dd className="font-mono">{branch.task.taskId}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-500">Status</dt><dd>{labelize(branch.task.status)}</dd></div>
            </dl>
          ) : taskStage.actionable ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("task", { kind: "task", actionId: branch.action.actionId })}
              className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending === "task" ? "Creating canonical task…" : "Create canonical internal task"}
            </button>
          ) : null}
        </StageRow>

        <StageRow stage={executionStage}>
          {branch.executions.length > 0 && (
            <dl className="mt-2 grid gap-1 text-[11px] text-slate-600">
              <div className="flex gap-2"><dt className="text-slate-500">Execution</dt><dd className="font-mono">{branch.latestExecution?.executionId}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-500">State</dt><dd>{labelize(branch.latestExecution?.status ?? null)}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-500">Attempts</dt><dd>{branch.latestExecution?.attemptCount ?? "—"}</dd></div>
            </dl>
          )}
          {executionStage.actionable && branch.task && (
            <div className="mt-2 flex flex-wrap gap-2">
              {commands.map((command) => (
                <button
                  key={command}
                  type="button"
                  disabled={busy}
                  onClick={() => void run("execution", { kind: "execution", taskId: branch.task!.taskId, command })}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending === "execution" ? "Recording…" : COMMAND_LABEL[command] ?? `Record ${command}`}
                </button>
              ))}
            </div>
          )}
        </StageRow>

        <StageRow stage={outcomeStage}>
          {branch.outcome ? (
            <dl className="mt-2 grid gap-1 text-[11px] text-slate-600">
              <div className="flex gap-2"><dt className="text-slate-500">Outcome</dt><dd className="font-mono">{branch.outcome.outcomeId}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-500">Expected</dt><dd>{branch.outcome.expectedResult ?? "—"}</dd></div>
              <div className="flex gap-2"><dt className="text-slate-500">State</dt><dd>{labelize(branch.outcome.state)}</dd></div>
            </dl>
          ) : outcomeStage.actionable && branch.task ? (
            <div className="mt-2">
              <label htmlFor={expectedId} className="text-[11px] font-medium text-slate-600">
                What is this work expected to achieve? (required)
              </label>
              <textarea
                id={expectedId}
                rows={2}
                value={expectedResult}
                onChange={(event) => setExpectedResult(event.target.value)}
                placeholder="The outcome you expect, in business terms"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-500/40 focus:outline-none"
              />
              <button
                type="button"
                disabled={busy || expectedResult.trim().length === 0 || !correlationId}
                onClick={() =>
                  void run("outcome", {
                    kind: "outcome",
                    taskId: branch.task!.taskId,
                    expectedResult: expectedResult.trim(),
                    correlationId,
                  })
                }
                className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending === "outcome" ? "Defining expected outcome…" : "Define expected outcome"}
              </button>
              {expectedResult.trim().length === 0 && (
                <p className="mt-1 text-[11px] text-slate-500">Describe the expected outcome to continue.</p>
              )}
            </div>
          ) : null}
        </StageRow>

        <StageRow stage={observationStage}>
          {branch.observations.length > 0 && (
            <ul className="mt-2 space-y-2">
              {branch.observations.map((observation) => (
                <li key={observation.observationId} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
                  <p className="text-slate-700">{labelize(observation.observationState)}</p>
                  <p className="mt-0.5">{observation.summary ?? "—"}</p>
                  <p className="mt-0.5">
                    Evidence: {observation.evidenceReferenceIds.length > 0 ? observation.evidenceReferenceIds.join(", ") : "none recorded"}
                    {observation.missingDataState ? ` · missing data: ${labelize(observation.missingDataState)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {observationStage.actionable && branch.outcome && (
            <div className="mt-2">
              <label htmlFor={stateId} className="text-[11px] font-medium text-slate-600">What does the evidence say?</label>
              <select
                id={stateId}
                value={observationState}
                onChange={(event) => setObservationState(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800 focus:border-sky-500/40 focus:outline-none"
              >
                {OBSERVATION_STATES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                {OBSERVATION_STATES.find((option) => option.value === observationState)?.hint}
              </p>

              <label htmlFor={summaryId} className="mt-2 block text-[11px] font-medium text-slate-600">
                What was observed? (required)
              </label>
              <textarea
                id={summaryId}
                rows={2}
                value={observationSummary}
                onChange={(event) => setObservationSummary(event.target.value)}
                placeholder="What the evidence actually shows"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-500/40 focus:outline-none"
              />

              {evidenceOptions.length > 0 ? (
                <>
                  <label htmlFor={`${summaryId}-evidence`} className="mt-2 block text-[11px] font-medium text-slate-600">
                    Supporting evidence (required)
                  </label>
                  <select
                    id={`${summaryId}-evidence`}
                    value={selectedEvidence}
                    onChange={(event) => setEvidenceId(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800 focus:border-sky-500/40 focus:outline-none"
                  >
                    {evidenceOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.title}</option>
                    ))}
                  </select>
                </>
              ) : (
                <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                  No live, provenance-bearing evidence is available for this project yet, so an
                  observation cannot be recorded. Demo or fixture evidence cannot promote an outcome.
                </p>
              )}

              {/* Epistemic state is stated by the observer, never assumed to be certain. */}
              <div className="mt-2">
                <label htmlFor={`${qualityId}-confidence`} className="text-[11px] font-medium text-slate-600">
                  How confident is this observation? 0 to 1 (required)
                </label>
                <input
                  id={`${qualityId}-confidence`}
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={confidence}
                  onChange={(event) => setConfidence(event.target.value)}
                  placeholder="e.g. 0.6"
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-500/40 focus:outline-none"
                />
              </div>
              <Choice
                id={`${qualityId}-missing`}
                label="Was any needed data missing? (required)"
                value={missingDataState}
                options={MISSING_DATA_STATES}
                onChange={setMissingDataState}
                hint={MISSING_DATA_HELP[missingDataState]}
              />

              <button
                type="button"
                disabled={busy || !observationComplete || !correlationId}
                onClick={() =>
                  void run("observation", {
                    kind: "observation",
                    outcomeId: branch.outcome!.outcomeId,
                    observationState,
                    summary: observationSummary.trim(),
                    evidenceReferenceIds: [selectedEvidence],
                    quality: { confidenceScore: confidenceValue, missingDataState },
                    correlationId,
                  })
                }
                className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending === "observation" ? "Recording observation…" : "Record evidence-backed observation"}
              </button>
              {!observationComplete && (
                <p className="mt-1 text-[11px] text-slate-500">
                  An observation needs a summary, supporting evidence, a confidence value and a missing-data state.
                </p>
              )}
            </div>
          )}
        </StageRow>

        <StageRow stage={reviewStage}>
          {branch.lineage && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-medium text-slate-600">
                Complete lineage ({branch.lineage.steps.length} steps · {labelize(branch.lineage.lineageStatus)})
              </summary>
              <ul className="mt-2 space-y-1.5">
                {branch.lineage.steps.map((step, index) => (
                  <li key={`${step.kind}-${step.id ?? index}`} className="text-[11px] leading-relaxed text-slate-600">
                    <span className="text-slate-700">{labelize(step.kind)}</span>
                    {" · "}
                    {step.id ? <span className="font-mono">{step.id}</span> : <span>{step.gapReason ?? "not present"}</span>}
                  </li>
                ))}
              </ul>
              {branch.lineage.gaps.length > 0 && (
                <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                  Gaps: {branch.lineage.gaps.join("; ")}
                </p>
              )}
              {branch.lineage.disputes.length > 0 && (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                  Disputes: {branch.lineage.disputes.join("; ")}
                </p>
              )}
              {branch.lineage.hasCorrelationOnly && (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                  Some links are correlation only, so this chain does not establish causation.
                </p>
              )}
            </details>
          )}
        </StageRow>
      </ol>

      <p role="status" aria-live="polite" className="sr-only">
        {pending ? `Recording ${pending.replaceAll("_", " ")}.` : ""}
      </p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-3 py-2 text-xs text-rose-900">
          {error}
        </p>
      )}
    </li>
  );
}

export function ExecutionChainPanel({
  chain,
  onRun,
  evidenceOptions,
  refreshFailedAfterWrite = false,
  onRetryRefresh,
}: {
  chain: GovernedExecutionChain;
  /** Must reject on failure so this panel can surface the real error and keep input.
   *  It must NOT reject merely because the post-write refresh failed — that is a read
   *  condition, reported through `refreshFailedAfterWrite`. */
  onRun: (operation: ExecutionOperation) => Promise<void>;
  /** Canonical evidence ids available to back an Observation. */
  evidenceOptions: Array<{ id: string; title: string }>;
  refreshFailedAfterWrite?: boolean;
  onRetryRefresh?: () => void;
}) {
  const headingId = useId();
  const actionFormId = useId();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // P2-06 classification, supplied by the authorized human. No value is pre-selected:
  // materiality — and therefore the governance outcome — is derived from these.
  const [actionType, setActionType] = useState("");
  const [intendedEffect, setIntendedEffect] = useState("");
  const [actionClass, setActionClass] = useState("");
  const [risk, setRisk] = useState("");
  const [reversibility, setReversibility] = useState("");
  const [sideEffect, setSideEffect] = useState("");

  const proposalStage = chain.proposalStage;
  const actionDraftComplete =
    actionType.trim().length > 0 &&
    intendedEffect.trim().length > 0 &&
    Boolean(actionClass && risk && reversibility && sideEffect);
  const replacement = chain.branches.length > 0;

  async function proposeAction() {
    setPending(true);
    setError(null);
    try {
      await onRun({
        kind: "material_action",
        decisionId: chain.decisionId,
        draft: { actionType: actionType.trim(), intendedEffect: intendedEffect.trim(), actionClass, risk, reversibility, sideEffect },
        justification: chain.rationale ?? "Recorded human decision.",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The operation could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="mt-5 border-t border-slate-200 pt-4">
      <h3 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
        After your decision
      </h3>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
        Recording a decision does not act. Each step below is a separate governed operation you choose to take.
      </p>

      {refreshFailedAfterWrite && (
        <p role="status" className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          Your last governed operation was saved. We could not refresh this view afterwards,
          so what you see below may be out of date — it does not mean the operation failed.{" "}
          {onRetryRefresh && (
            <button type="button" onClick={onRetryRefresh} className="underline underline-offset-2 hover:text-amber-900">
              Refresh now
            </button>
          )}
        </p>
      )}

      {/* The P2-12 invariant, stated from persisted state rather than implied by layout. */}
      <p className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-700">
        {chain.boundary.statement}
      </p>

      <ol className="mt-3 space-y-3">
        <StageRow stage={proposalStage}>
          {proposalStage.actionable ? (
            <div className="mt-2">
              <p className="text-[11px] leading-relaxed text-slate-500">
                Governance classifies this action from what you state below, so describe the action you
                actually intend — these values are not assumed for you.
                {replacement
                  ? " This records a new, separately evaluated authorization; the earlier action stays on the record exactly as it is."
                  : ""}
              </p>
              <label htmlFor={`${actionFormId}-type`} className="mt-2 block text-[11px] font-medium text-slate-600">
                What kind of action is this? (required)
              </label>
              <input
                id={`${actionFormId}-type`}
                value={actionType}
                onChange={(event) => setActionType(event.target.value)}
                placeholder="e.g. supplier contract amendment"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-500/40 focus:outline-none"
              />
              <label htmlFor={`${actionFormId}-effect`} className="mt-2 block text-[11px] font-medium text-slate-600">
                What would it change? (required)
              </label>
              <textarea
                id={`${actionFormId}-effect`}
                rows={2}
                value={intendedEffect}
                onChange={(event) => setIntendedEffect(event.target.value)}
                placeholder="The intended effect of acting"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-500/40 focus:outline-none"
              />
              <Choice id={`${actionFormId}-class`} label="Action class (required)" value={actionClass} options={MATERIAL_ACTION_CLASSES} onChange={setActionClass} />
              <Choice id={`${actionFormId}-risk`} label="Risk (required)" value={risk} options={MATERIAL_ACTION_RISKS} onChange={setRisk} />
              <Choice id={`${actionFormId}-reversibility`} label="Reversibility (required)" value={reversibility} options={MATERIAL_ACTION_REVERSIBILITY} onChange={setReversibility} />
              <Choice id={`${actionFormId}-side-effect`} label="Side effect (required)" value={sideEffect} options={MATERIAL_ACTION_SIDE_EFFECTS} onChange={setSideEffect} />
              <button
                type="button"
                disabled={pending || !actionDraftComplete}
                onClick={() => void proposeAction()}
                className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-800 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending
                  ? "Requesting governed action…"
                  : replacement
                    ? "Request replacement governed material action"
                    : "Request governed material action"}
              </button>
              {!actionDraftComplete && (
                <p className="mt-1 text-[11px] text-slate-500">
                  Describe the action and classify it to continue. Governance depends on these answers.
                </p>
              )}
            </div>
          ) : null}
        </StageRow>

        {chain.branches.map((branch, index) => (
          <BranchSection
            key={branch.id}
            branch={branch}
            onRun={onRun}
            evidenceOptions={evidenceOptions}
            position={index + 1}
            total={chain.branches.length}
          />
        ))}
      </ol>

      <p role="status" aria-live="polite" className="sr-only">
        {pending ? "Recording material action." : ""}
      </p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/[0.08] px-3 py-2 text-xs text-rose-900">
          {error}
        </p>
      )}
    </section>
  );
}
