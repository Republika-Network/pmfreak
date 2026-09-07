"use client";

import { useId, useState } from "react";
import { captureAndDeriveLiveEvidence, OperationalFlowRequestError } from "./operational-data";
import { INTAKE_ATTEMPT_WINDOW_MS, sha256Hex } from "./execution-read-model";
import { clearSubmissionAttempt, intakeAttemptKey, loadSubmissionAttempt } from "./submission-attempt";
import { CloseIcon } from "./icons";

/**
 * Customer context capture. This surface records LIVE operational input, always.
 *
 * It used to ask the PM to classify their own notes as DEMO / FIXTURE or LIVE, and
 * defaulted to DEMO / FIXTURE — so ordinary project context landed on a lineage that can
 * never support an Outcome Observation, chosen by a customer who had no way to know what
 * the question meant (UX-P0-01).
 *
 * The canonical distinction is unchanged and still enforced by the contract. What changed
 * is who answers it: the product surface answers LIVE on the customer's behalf, because
 * a PM pasting their own project notes IS making a real operational record. Fixture
 * capture keeps its own surface for internal/certification use
 * (`@/components/internal/governance-lab/fixture-intake-panel`), and both surfaces call
 * the same capture primitives in `operational-data.ts` — the two lineages never merge,
 * fixture Evidence is not promoted, and the live contract still refuses to write against
 * a fixture Source.
 */
const ASSERTION_TYPES = ["FACT", "INFERENCE", "ASSUMPTION"] as const;
const CLASSIFICATIONS = ["UNCLASSIFIED", "PROJECT_STATUS", "RISK", "ISSUE", "DECISION_CONTEXT", "DELIVERY"] as const;
const MISSING_DATA_STATES = ["COMPLETE", "PARTIAL", "UNKNOWN"] as const;

/**
 * Part of the durable attempt-key identity, so it is a named constant rather than an
 * inline literal: changing the string would orphan every in-flight attempt and reopen the
 * duplicate-on-retry seam the key exists to close.
 */
const mode = "live" as const;

const labelize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");

export function VaultIntakePanel({ workspaceId, projectId, onClose, onIntakeComplete }: {
  workspaceId: string; projectId: string; onClose: () => void; onIntakeComplete: (summary: string) => void;
}) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // P2-09 evidence quality, supplied by the observer rather than assumed.
  //
  // UNANSWERED is the only honest initial state. These four fields used to open on
  // INFERENCE / PROJECT_STATUS / COMPLETE / 0.90 — a complete, plausible, entirely
  // invented set of judgements a PM could submit without ever reading. The Evidence row
  // records them as observer-supplied either way, and an Observation that cites it
  // inherits them, so a preselection is not a convenience: it is the fabrication P2-09
  // exists to prevent, performed by the form instead of the person.
  //
  // `""` is outside every canonical vocabulary below, which is what makes it unsubmittable
  // rather than merely untouched. The vocabularies themselves are unchanged.
  const [assertionType, setAssertionType] = useState<(typeof ASSERTION_TYPES)[number] | "">("");
  const [classification, setClassification] = useState<string>("");
  const [missingDataState, setMissingDataState] = useState<(typeof MISSING_DATA_STATES)[number] | "">("");
  const [confidenceScore, setConfidenceScore] = useState("");

  // Scoped ids: the Command Center mounts responsive surfaces simultaneously, and a
  // hardcoded id would produce duplicate document ids and break label association.
  const uid = useId();
  const inputId = `${uid}-content`;

  const confidenceEntered = confidenceScore.trim();
  const confidence = Number(confidenceEntered);
  // EMPTY is not EXPLICIT ZERO. `Number("")` is 0, so an emptied or whitespace-only field
  // used to pass every range check and persist `confidence_score = 0` — the strongest
  // possible "no confidence at all" claim — as though the observer had made it. An
  // Observation citing that Evidence would inherit a judgement nobody gave. A deliberate
  // 0 stays valid; the absence of an answer does not become one.
  const confidenceValid = confidenceEntered !== "" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
  // Answered, not merely valid. Kept separate from `confidenceValid` so an out-of-range
  // number still reports a range problem rather than an unanswered one.
  const judgementsAnswered = assertionType !== "" && classification !== "" && missingDataState !== "";
  const canSubmit = content.trim() !== "" && judgementsAnswered && confidenceValid;

  const submit = async () => {
    if (!content.trim()) { setError("Paste some notes before capture."); return; }
    if (assertionType === "" || classification === "" || missingDataState === "") {
      setError("Answer assertion type, classification and missing data before capture."); return;
    }
    if (!confidenceValid) { setError("Confidence must be a number between 0 and 1."); return; }
    setBusy(true); setError("");
    try {
      // LIVE capture is two canonical writes. If the first commits and the second fails —
      // or its response is simply lost — the observer's natural recovery is to press the
      // button again, and under a freshly minted identity that retry appended a SECOND
      // Raw Input and Normalized Event for one human submission. The attempt store gives
      // the retry the same identity, so both idempotency keys match and the contract
      // reconciles onto the rows it already holds. Retired on success, so the next
      // deliberate capture is recorded as its own submission.
      const attemptKey = intakeAttemptKey(workspaceId, projectId, mode, await sha256Hex(content.trim()));
      const attempt = loadSubmissionAttempt(attemptKey, { ttlMs: INTAKE_ATTEMPT_WINDOW_MS });
      await captureAndDeriveLiveEvidence(workspaceId, projectId, {
        title: content.slice(0, 80), content,
        assertionType, classification, confidenceScore: confidence, missingDataState,
        submissionId: attempt.attemptId,
      });
      clearSubmissionAttempt(attemptKey);
      onIntakeComplete("Evidence derived with complete provenance. Intelligence has not run. No Outcome was achieved.");
      setContent(""); onClose();
    } catch (caught) {
      // P2-15. A refused canonical write is reported exactly as the contract answered it.
      //
      // The attempt is deliberately NOT retired and nothing is resubmitted: an
      // `evidence_quality_conflict` means this submission is ALREADY recorded as an
      // immutable Evidence assertion carrying different quality fields. Silently retrying
      // under a fresh identity would mint a second Raw Input and Normalized Event for one
      // human submission; silently folding the changed quality into the identity would
      // mint a second Evidence assertion that stays Observation-eligible alongside the
      // first. Both are duplicate-manufacturing recoveries. The observer is told what
      // happened and reloads the recorded assertion themselves.
      //
      // The reference id is shown because it is the only thing that ties what the observer
      // saw to the redacted server log line; without it a support request starts from
      // "something went wrong".
      const reference = caught instanceof OperationalFlowRequestError && caught.referenceId
        ? ` Reference: ${caught.referenceId}.`
        : "";
      setError(
        caught instanceof Error
          ? `${caught.message}${reference}`
          : "Could not capture those notes. Nothing was reported as successful."
      );
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 shadow-[0_2px_20px_rgba(0,0,0,0.2)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-100">Add project notes</p>
          <p className="mt-0.5 text-xs text-zinc-500">Capture and Evidence derivation remain separate transitions; intelligence will not run.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-zinc-500 hover:bg-white/5"><CloseIcon className="h-4 w-4" /></button>
      </div>

      <label className="sr-only" htmlFor={inputId}>Project notes</label>
      <textarea
        id={inputId}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        placeholder="The supplier said delivery may slip to next Friday…"
        className="mt-3 w-full rounded-xl border border-white/10 bg-white/[0.02] p-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-sky-500/40 focus:ring-2 focus:ring-sky-500/10"
      />

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-[11px] text-zinc-400">
          Assertion type
          <select value={assertionType} onChange={(e) => setAssertionType(e.target.value as (typeof ASSERTION_TYPES)[number])} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-xs text-zinc-100">
            <option value="" disabled>Select…</option>
            {ASSERTION_TYPES.map((value) => <option key={value} value={value}>{labelize(value)}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-zinc-400">
          Classification
          <select value={classification} onChange={(e) => setClassification(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-xs text-zinc-100">
            <option value="" disabled>Select…</option>
            {CLASSIFICATIONS.map((value) => <option key={value} value={value}>{labelize(value)}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-zinc-400">
          Missing data
          <select value={missingDataState} onChange={(e) => setMissingDataState(e.target.value as (typeof MISSING_DATA_STATES)[number])} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-xs text-zinc-100">
            <option value="" disabled>Select…</option>
            {MISSING_DATA_STATES.map((value) => <option key={value} value={value}>{labelize(value)}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-zinc-400">
          Confidence (0–1)
          <input type="number" min="0" max="1" step="0.01" placeholder="Enter a value" value={confidenceScore} onChange={(e) => setConfidenceScore(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 p-2 text-xs text-zinc-100" />
        </label>
      </div>

      {error && <p role="alert" className="mt-2 text-xs text-rose-400">{error}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/5">Cancel</button>
        <button type="button" onClick={submit} disabled={busy || !canSubmit} className="rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:bg-sky-500/15 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? "Capturing and deriving…" : "Capture and derive Evidence"}
        </button>
      </div>
    </div>
  );
}
