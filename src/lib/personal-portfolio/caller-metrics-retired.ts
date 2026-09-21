import { NextResponse } from "next/server";

/**
 * P2-17 — caller-trusted portfolio metrics are refused.
 *
 * The personal-portfolio compute endpoints (snapshot, prioritize, attention, neglect,
 * command-center) accepted `projectMetrics` — healthScore, riskScore, status and task/decision
 * counts — from the request body and ranked, allocated, projected and (for `snapshot`) PERSISTED
 * results computed from them. Nothing on the server could rebuild those values: PMFreak has no
 * canonical health or risk score, and inventing one to replace the caller's would be a new
 * unsupported metric rather than a repair. So the endpoints are retired, not re-sourced.
 *
 * They still authenticate first (401 stays 401), then refuse with 410 BEFORE the body is read,
 * so no caller-supplied value can reach a computation or a table. The pure engines in this
 * module remain as a bounded compatibility library; server-derived, coverage- and
 * confidence-qualified portfolio attention lives on the PMO Command Center
 * (`GET /api/pmos/[id]/attention`, `src/lib/pmos/pmo-portfolio-attention.ts`).
 */
export const CALLER_METRICS_FAILURE_CLASS = "caller_metrics_not_accepted";

export function callerMetricsRetiredResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      failureClass: CALLER_METRICS_FAILURE_CLASS,
      error:
        "Caller-supplied portfolio metrics are no longer accepted. Portfolio attention is derived on the server from canonical project records; use the PMO Command Center attention view.",
      replacement: "/api/pmos/{pmoId}/attention?workspaceId={workspaceId}",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Snapshots persisted before retirement were computed from caller-supplied metrics. They are
 * still readable by their owner (nothing is deleted), but are labelled so they are never read
 * as server-verified portfolio state.
 */
export const LEGACY_SNAPSHOT_PROVENANCE = {
  provenance: "caller_supplied_unverified",
  note: "Computed from metrics supplied by a client before P2-17; not derived from canonical project records.",
} as const;
