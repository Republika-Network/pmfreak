"use client";

import { useState } from "react";
import { Modal } from "@/components/pmfreak/ui/modal";
import type { EvidenceProvenanceResult } from "@/lib/operational-flow/types";
import { captureAndDeriveLiveEvidence } from "@/modules/workspace/presentation/command-center/operational-data";
import { INTAKE_ATTEMPT_WINDOW_MS, sha256Hex } from "@/modules/workspace/presentation/command-center/execution-read-model";
import { clearSubmissionAttempt, intakeAttemptKey, loadSubmissionAttempt } from "@/modules/workspace/presentation/command-center/submission-attempt";

/**
 * Project Memory context capture.
 *
 * This is a customer surface, so it records LIVE operational input (UX-P0-01). It used to
 * announce itself as demonstration input and write the fixture lineage, which meant every
 * note a PM took here derived Evidence that can never support an Outcome Observation. That
 * label was accurate, which is exactly why relabelling it alone would have been a lie: the
 * fix is the contract it calls, not the copy.
 *
 * Shares `captureAndDeriveLiveEvidence` and the attempt store with the Command Center
 * intake panel — one capture primitive, one retry identity, two presentations.
 */
type CaptureMode = "paste" | "note";

const COPY = {
  paste: { title: "Capture operational context", placeholder: "Paste an email thread, meeting recap, or other project context…" },
  note: { title: "Take a note", placeholder: "The supplier said delivery may slip to next Friday…" },
} satisfies Record<CaptureMode, { title: string; placeholder: string }>;

export function TextCaptureModal({ mode, workspaceId, projectId, onClose, onCaptured }: {
  mode: CaptureMode; workspaceId: string; projectId: string; onClose: () => void; onCaptured: (title: string) => void;
}) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Observer judgement, asked for rather than assumed.
  //
  // UNANSWERED is the only honest initial state. These opened on
  // ASSUMPTION / UNCLASSIFIED / UNKNOWN / 0.50 — a complete set of judgements nobody made,
  // which the LIVE Evidence row then records as observer-supplied and an Observation
  // inherits. A weak-looking default is still a fabricated one. Same fix, same reasoning
  // and same canonical vocabularies as the Command Center intake panel.
  const [assertionType, setAssertionType] = useState<"INFERENCE" | "ASSUMPTION" | "">("");
  const [classification, setClassification] = useState("");
  const [missingDataState, setMissingDataState] = useState<"UNKNOWN" | "PARTIAL" | "COMPLETE" | "">("");
  const [confidenceScore, setConfidenceScore] = useState("");
  const [result, setResult] = useState<EvidenceProvenanceResult | null>(null);
  const copy = COPY[mode];

  // Answered, not merely valid — drives the disabled button below.
  const judgementsAnswered = assertionType !== "" && classification !== "" && missingDataState !== "";

  const submit = async () => {
    if (!content.trim()) { setError("Add content before capture."); return; }
    // The explicit comparison rather than `!judgementsAnswered`, so the compiler narrows
    // the three unions here: the canonical contract accepts no empty member.
    if (assertionType === "" || classification === "" || missingDataState === "") {
      setError("Answer assertion type, classification and missing data before capture."); return;
    }
    const confidenceEntered = confidenceScore.trim();
    const confidence = Number(confidenceEntered);
    // EMPTY is not EXPLICIT ZERO. `Number("")` is 0, so an emptied or whitespace-only field
    // passed every range check and persisted `confidence_score = 0` — the strongest possible
    // "no confidence at all" claim — onto immutable Evidence as though the observer had made
    // it. Same defect, same fix as the Command Center intake panel: a deliberate 0 stays
    // valid, the absence of an answer does not become one.
    if (confidenceEntered === "" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) { setError("Confidence must be between 0 and 1."); return; }
    setBusy(true); setError("");
    try {
      // Two canonical writes, so an ambiguous retry needs the SAME identity or it appends a
      // second Raw Input and Normalized Event for one human submission. That mattered less
      // when this surface wrote fixture Evidence; now it writes Observation-eligible LIVE
      // Evidence, so the duplicate would be citable. Same attempt store, same key shape and
      // same "live" mode segment as the Command Center panel.
      const attemptKey = intakeAttemptKey(workspaceId, projectId, "live", await sha256Hex(content.trim()));
      const attempt = loadSubmissionAttempt(attemptKey, { ttlMs: INTAKE_ATTEMPT_WINDOW_MS });
      const derived = await captureAndDeriveLiveEvidence(workspaceId, projectId, {
        title: content.slice(0, 80), content,
        assertionType, classification, confidenceScore: confidence, missingDataState,
        submissionId: attempt.attemptId,
      }) as EvidenceProvenanceResult;
      // Retired only on success: a refusal leaves the attempt in place so a deliberate retry
      // reconciles onto the rows already written instead of minting a second assertion.
      clearSubmissionAttempt(attemptKey);
      setResult(derived);
      onCaptured(content.slice(0, 80) || copy.title);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Capture failed. Nothing was reported as successful.");
    } finally { setBusy(false); }
  };

  if (result) return (
    <Modal title="Provenance recorded" onClose={onClose}>
      <div role="status" aria-live="polite" className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 text-xs text-cyan-950">
        {result.disposition === "duplicate" ? "Safe duplicate replay — this submission was already recorded" : "Evidence derived"}
      </div>
      <ol aria-label="Source to Evidence provenance chain" className="mt-4 space-y-3 text-xs text-slate-700">
        {[["Source", result.source.id, result.source.status], ["Raw Input", result.rawInput.id, result.rawInput.content_digest], ["Normalized Event", result.normalizedEvent.id, result.normalizedEvent.event_digest], ["Evidence", result.evidence.id, result.evidence.derivation_digest]].map(([label, id, detail]) => (
          <li key={String(label)} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="font-semibold">{String(label)}</p><p className="mt-1 break-all font-mono text-[10px]">ID: {String(id)}</p><p className="mt-1 break-all font-mono text-[10px]">{String(detail)}</p>
          </li>
        ))}
      </ol>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div><dt className="text-slate-400">Assertion</dt><dd className="font-semibold">{String(result.evidence.assertion_type)}</dd></div>
        <div><dt className="text-slate-400">Classification</dt><dd className="font-semibold">{String(result.evidence.classification)}</dd></div>
        <div><dt className="text-slate-400">Confidence</dt><dd>{String(result.evidence.confidence_score)}</dd></div>
        <div><dt className="text-slate-400">Missing data</dt><dd>{String(result.evidence.missing_data_state)}</dd></div>
        <div><dt className="text-slate-400">Freshness</dt><dd>{String(result.evidence.freshness_state)}</dd></div>
        <div><dt className="text-slate-400">Recorded</dt><dd>{String(result.evidence.recorded_at)}</dd></div>
      </dl>
      <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">Intelligence has not run. No Finding, Recommendation, Decision, Action, Task, or Outcome was created.</p>
      <button type="button" onClick={onClose} className="mt-4 w-full rounded-lg border border-cyan-200 bg-cyan-50 px-3.5 py-2 text-xs font-semibold text-cyan-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600">Close</button>
    </Modal>
  );

  return (
    <Modal title={copy.title} onClose={onClose}>
      <p className="text-xs text-slate-500">What you type here is not externally verified, and is not Evidence until explicitly derived.</p>
      <label className="sr-only" htmlFor="manual-provenance-content">Project context</label>
      <textarea id="manual-provenance-content" value={content} onChange={(event) => setContent(event.target.value)} rows={7} placeholder={copy.placeholder} autoFocus className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-100" />
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-600">Assertion type<select value={assertionType} onChange={(e) => setAssertionType(e.target.value as "INFERENCE" | "ASSUMPTION")} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2"><option value="" disabled>Select…</option><option value="ASSUMPTION">Assumption</option><option value="INFERENCE">Inference</option></select></label>
        <label className="text-xs text-slate-600">Classification<select value={classification} onChange={(e) => setClassification(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2"><option value="" disabled>Select…</option><option value="UNCLASSIFIED">Unclassified</option><option value="PROJECT_STATUS">Project status</option><option value="RISK">Risk</option><option value="ISSUE">Issue</option><option value="DECISION_CONTEXT">Decision context</option><option value="DELIVERY">Delivery</option></select></label>
        <label className="text-xs text-slate-600">Missing data<select value={missingDataState} onChange={(e) => setMissingDataState(e.target.value as "UNKNOWN" | "PARTIAL" | "COMPLETE")} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2"><option value="" disabled>Select…</option><option value="UNKNOWN">Unknown</option><option value="PARTIAL">Partial</option><option value="COMPLETE">Complete</option></select></label>
        <label className="text-xs text-slate-600">Confidence (0–1)<input type="number" min="0" max="1" step="0.01" placeholder="Enter a value" value={confidenceScore} onChange={(e) => setConfidenceScore(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 bg-white p-2" /></label>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-rose-600">{error}</p>}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-600">Cancel</button>
        <button type="button" onClick={submit} disabled={busy || !content.trim() || !judgementsAnswered || confidenceScore.trim() === ""} className="rounded-lg border border-cyan-200 bg-cyan-50/80 px-3.5 py-2 text-xs font-semibold text-cyan-800 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Capturing and deriving…" : "Capture, then derive Evidence"}</button>
      </div>
    </Modal>
  );
}
