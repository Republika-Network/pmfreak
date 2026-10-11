// Project Brain activation lifecycle for a project created by the onboarding
// wizard (saveProjectOnboarding).
//
// WHY THIS EXISTS
// ---------------
// Activation is several writes that cannot share one transaction: the project
// row, then best-effort setup-context ingestion (vault document, RAID
// extraction, recommended actions, operational evidence) and the operational
// governance brief. When a request died after the project insert — a server
// action timeout, a lost response — the wizard reported a failure, kept the
// draft, and the retry created a SECOND project and ingested the context
// again. A downstream exception instead deleted the project, leaving any
// already-written intelligence rows pointing at nothing.
//
// This marker makes activation resumable and idempotent:
//   - `requestId` is the wizard's activation key, stable across retries and
//     reloads. One user + one requestId = one project (enforced by the unique
//     index in 20261012000000_project_brain_activation_idempotency.sql; the
//     lookup in saveProjectOnboarding covers sequential retries even before
//     that migration is applied).
//   - each downstream step records when it completed, so a resumed activation
//     runs only what is still missing and never re-ingests the same context.
//
// STORAGE (same convention as initial-ingestion-state.ts — no new column)
// ------------------------------------------------------------------------
// Persisted inside `projects.onboarding_payload` under the `brainActivation`
// key. The key is always written by the server; a client-supplied value in the
// submitted payload is discarded. Every read is narrowed below.

export const BRAIN_ACTIVATION_KEY = "brainActivation";

export type BrainActivationMarker = {
  requestId: string;
  startedAt: string;
  setupContextCompletedAt: string | null;
  briefCompletedAt: string | null;
  completedAt: string | null;
};

const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{8,100}$/;

/** A usable activation key, or null. Never trusted beyond its shape — it is always scoped to the caller's own user id. */
export function normalizeActivationRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return REQUEST_ID_SHAPE.test(trimmed) ? trimmed : null;
}

const isoOrNull = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;

/** Narrows the persisted marker out of an untrusted `onboarding_payload`; anything malformed reads as no marker. */
export function readBrainActivation(payload: unknown): BrainActivationMarker | null {
  if (!payload || typeof payload !== "object") return null;
  const marker = (payload as Record<string, unknown>)[BRAIN_ACTIVATION_KEY];
  if (!marker || typeof marker !== "object") return null;
  const m = marker as Record<string, unknown>;
  const requestId = normalizeActivationRequestId(m.requestId);
  const startedAt = isoOrNull(m.startedAt);
  if (!requestId || !startedAt) return null;
  return {
    requestId,
    startedAt,
    setupContextCompletedAt: isoOrNull(m.setupContextCompletedAt),
    briefCompletedAt: isoOrNull(m.briefCompletedAt),
    completedAt: isoOrNull(m.completedAt),
  };
}

/**
 * The payload to persist: the user's submitted onboarding content, verbatim,
 * plus server-owned markers. Any `brainActivation` key in the submission is
 * replaced; server-owned keys already on the row (e.g. `initialIngestion`) are
 * carried over from `existing` so a resumed activation never drops them.
 */
export function composeActivationPayload(
  submitted: Record<string, unknown>,
  marker: BrainActivationMarker,
  existing?: unknown,
  serverOwnedKeys: readonly string[] = ["initialIngestion"],
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  if (existing && typeof existing === "object") {
    for (const key of serverOwnedKeys) {
      if (key in (existing as Record<string, unknown>)) carried[key] = (existing as Record<string, unknown>)[key];
    }
  }
  const { [BRAIN_ACTIVATION_KEY]: _discarded, ...content } = submitted;
  void _discarded;
  return { ...content, ...carried, [BRAIN_ACTIVATION_KEY]: marker };
}
