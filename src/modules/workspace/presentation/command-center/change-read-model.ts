import type { OperationalSummary } from "@/lib/operational-flow/types";
import { relativeLabel } from "./activity-read-model";
import type { StatusTone } from "./types";

/**
 * "What changed" — a PRESENTATION projection over `data.signals`.
 *
 * No new intelligence is produced here and no new request is made. `useOperationalFlow`
 * already loads `operational_signals` for the active project (newest 30, ordered by the
 * server), and every field rendered below is a persisted column of that row:
 * `id`, `signal_type`, `severity`, `summary`, `created_at`.
 *
 * Three rules this module exists to keep:
 *
 *   1. Nothing is invented. A row without a parseable `created_at` gets no timestamp at
 *      all rather than a plausible one, and a row without a `summary` gets no detail line.
 *      There is no impact statement anywhere in this file — the product does not compute
 *      one, so the surface does not claim one.
 *   2. The order is deterministic. Newest first by `created_at`, then by `id` ascending,
 *      so two loads of the same data always render the same sequence. Rows with no
 *      timestamp sort last, among themselves by id — they are not silently promoted to
 *      "now".
 *   3. One row is displayed once. Identity is the canonical signal `id`; a repeated id is
 *      the same record, not a second change.
 *
 * The relative label is computed against an EXPLICIT `now` rather than a clock read during
 * render, matching `deriveExecutionChains` / `nextProjectionDeadline`: the caller passes
 * the server-anchored projection instant, so the same inputs always render the same text.
 */

/**
 * Plain-language name for each canonical `signal_type`.
 *
 * The canonical vocabulary is unchanged — this maps it for display only. A PM reads
 * "Schedule slipped", not `schedule_risk`.
 */
export const SIGNAL_CHANGE_LABELS: Record<string, string> = {
  scope_creep: "Scope changed",
  schedule_risk: "Schedule at risk",
  cost_risk: "Budget at risk",
  quality_risk: "Quality concern raised",
  stakeholder_blocker: "Stakeholder blocking progress",
  missing_approval: "Approval missing",
  decision_needed: "Decision needed",
  delivery_impediment: "Delivery blocked",
  billing_risk: "Billing at risk",
  governance_gap: "Ownership or control gap",
};

/** Severity is a canonical value; this is only how it is spoken. */
const SEVERITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const SEVERITY_TONES: Record<string, StatusTone> = {
  low: "info",
  medium: "task",
  high: "danger",
  critical: "danger",
};

export type ChangeItem = {
  /** The canonical `operational_signals.id`. Never rendered — it is the dedupe key. */
  id: string;
  /** Plain-language change name. Falls back to a humanised type, never a raw identifier. */
  title: string;
  /** The signal's own persisted `summary`. Null when the row does not carry one. */
  detail: string | null;
  severityLabel: string | null;
  tone: StatusTone;
  /** Persisted `created_at`, ISO. Null when absent or unparseable — never substituted. */
  occurredAt: string | null;
  /** Relative label for `occurredAt` against the caller's instant. Null when unknown. */
  whenLabel: string | null;
};

/** Humanises an unrecognised canonical type instead of printing it raw. */
function humaniseType(signalType: string): string {
  const words = signalType.replaceAll("_", " ").trim();
  if (words.length === 0) return "Change detected";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Projects the already-loaded signal rows into the "What changed" surface.
 *
 * `now` is the caller's server-anchored projection instant (`projectionNow` in the
 * Command Center), so this function is pure for a given payload.
 */
export function deriveWhatChanged(data: OperationalSummary | undefined, now: Date): ChangeItem[] {
  if (!data) return [];
  const nowMs = now.getTime();
  const seen = new Set<string>();
  const items: ChangeItem[] = [];

  for (const row of data.signals ?? []) {
    const id = text(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const signalType = text(row.signal_type) ?? "";
    const severity = text(row.severity) ?? "";
    const createdAt = text(row.created_at);
    const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
    const hasTimestamp = Number.isFinite(createdMs);

    items.push({
      id,
      title: SIGNAL_CHANGE_LABELS[signalType] ?? humaniseType(signalType),
      detail: text(row.summary),
      severityLabel: SEVERITY_LABELS[severity] ?? null,
      tone: SEVERITY_TONES[severity] ?? "info",
      occurredAt: hasTimestamp ? new Date(createdMs).toISOString() : null,
      whenLabel: hasTimestamp ? relativeLabel(createdMs, nowMs) : null,
    });
  }

  // Deterministic: newest first, undated last, ties broken by canonical id.
  return items.sort((a, b) => {
    const aTime = a.occurredAt ? Date.parse(a.occurredAt) : null;
    const bTime = b.occurredAt ? Date.parse(b.occurredAt) : null;
    if (aTime !== bTime) {
      if (aTime === null) return 1;
      if (bTime === null) return -1;
      return bTime - aTime;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
