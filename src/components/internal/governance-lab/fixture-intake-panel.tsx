"use client";

import { useId, useState } from "react";
import { captureAndDeriveDemoEvidence, OperationalFlowRequestError } from "@/modules/workspace/presentation/command-center/operational-data";

/**
 * DEMO / FIXTURE capture — internal and certification use only.
 *
 * This is where the fixture lineage kept its entry point when UX-P0-01 removed the
 * lineage question from the customer surface. The customer panel
 * (`vault-intake-panel.tsx`) now records LIVE input and never offers this choice; a PM
 * pasting real project notes should not be asked to classify their own lineage, and
 * should certainly not be defaulted onto the one that can never support an Outcome.
 *
 * No canonical logic lives here. `captureAndDeriveDemoEvidence` is the same shared
 * primitive the panel always called, so the fixture path is unchanged in behaviour — only
 * in who can reach it. The separation it enforces is unchanged too: fixture Evidence is
 * derived as `DEMO_FIXTURE`, is never promoted to LIVE, and stays ineligible to be cited
 * by an Outcome Observation under P2-09.
 *
 * Reachable only through `/internal/governance-lab`, which is gated on
 * `isFounderOrInternalUser` and registered as `founder-internal` in the route guard
 * registry.
 */
export function FixtureIntakePanel({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const uid = useId();
  const inputId = `${uid}-fixture-content`;

  const submit = async () => {
    if (!content.trim()) { setError("Add content before capture."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await captureAndDeriveDemoEvidence(workspaceId, projectId, { title: content.slice(0, 80), content });
      setNotice("DEMO / FIXTURE Evidence derived with complete provenance. Intelligence has not run.");
      setContent("");
    } catch (caught) {
      // Reported exactly as the contract answered it; the reference id is what ties this
      // to the redacted server log line.
      const reference = caught instanceof OperationalFlowRequestError && caught.referenceId
        ? ` Reference: ${caught.referenceId}.`
        : "";
      setError(caught instanceof Error ? `${caught.message}${reference}` : "Fixture capture failed. Nothing was reported as successful.");
    } finally { setBusy(false); }
  };

  return (
    <section className="rounded-2xl border border-amber-300/40 bg-amber-50/60 p-4">
      <h2 className="text-sm font-semibold text-amber-950">DEMO / FIXTURE capture</h2>
      <p className="mt-1 text-xs text-amber-900/80">
        Internal only. Derives DEMO / FIXTURE Evidence, which is never promoted to LIVE and can
        never be cited by an Outcome Observation. Customer context capture does not use this path.
      </p>

      <label className="sr-only" htmlFor={inputId}>Fixture input</label>
      <textarea
        id={inputId}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={4}
        placeholder="Fixture input for certification scenarios…"
        className="mt-3 w-full rounded-xl border border-amber-300/50 bg-white p-3 text-sm text-zinc-900 outline-none"
      />

      {error && <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-amber-900">{notice}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={busy || !content.trim()}
        className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Capturing and deriving…" : "Capture fixture and derive Evidence"}
      </button>
    </section>
  );
}
