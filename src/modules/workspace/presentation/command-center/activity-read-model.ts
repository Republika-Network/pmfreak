import type { OperationalSummary } from "@/lib/operational-flow/types";

/**
 * "Updated ..." in the project header — how fresh this project's real activity is.
 *
 * The header used to read three collections: evidence, signals and decisions. Everything
 * that happens AFTER a decision — the governed Action, its evaluation, the Task, the
 * execution, the expected Outcome, the Observation — was invisible to it. A PM could
 * record an Observation two minutes ago and be told the project was last updated
 * yesterday, which is not a rounding error but a wrong answer to the question the header
 * is asking.
 *
 * This reads every collection of persisted records the summary already carries. It is a
 * presentation derivation over data that is already loaded; there is no new request.
 *
 * Three rules:
 *
 *   1. `generatedAt` is NOT activity. It is when the summary was fetched, so using it
 *      would report the page's own freshness as the project's and would never be stale.
 *   2. Timestamp fields are an ALLOWLIST, not "anything ending in _at". `expires_at`,
 *      `valid_until` and `stale_at` are deadlines in the future; treating them as activity
 *      would date the project forward to an event that has not happened.
 *   3. A value later than the caller's instant is ignored rather than reported as "just
 *      now". `observed_at` is supplied by a human and can legitimately be mis-entered; the
 *      honest answer to "when was this last updated" is never a moment in the future. When
 *      nothing qualifies, the result is null and the header shows no timestamp at all.
 */

/**
 * Collections of persisted records to read, by their key on `OperationalSummary`.
 *
 * `observationEligibleEvidence` is deliberately absent: it is a re-projection of rows
 * already counted through `evidence`, and reading it would count the same record twice.
 * `lineages`, `assurance` and `actor` are projections and metadata, not records.
 */
export const ACTIVITY_COLLECTIONS = [
  "sources",
  "rawInputs",
  "normalizedEvents",
  "evidence",
  "signals",
  "risksIssues",
  "governanceEvents",
  "recommendations",
  "decisions",
  "evidenceLinks",
  "materialActions",
  "materialActionEvaluations",
  "tasks",
  "executions",
  "outcomes",
  "observations",
] as const;

/**
 * Timestamp columns that record something that HAPPENED.
 *
 * Every entry is a persisted column on one of the tables above. Deadlines and planning
 * dates are excluded on purpose — see rule 2. Adding a field here is a claim that the
 * column records a past event, so it belongs in this list only if that is true.
 */
export const ACTIVITY_TIMESTAMP_FIELDS = [
  "created_at",
  "updated_at",
  "recorded_at",
  "persisted_at",
  "evaluated_at",
  "occurred_at",
  "observed_at",
  "queued_at",
  "started_at",
  "blocked_at",
  "failed_at",
  "completed_at",
  "last_transition_at",
] as const;

/**
 * The newest moment this project actually did something, ISO-8601, or null when no
 * record carries a usable timestamp.
 *
 * `now` is the caller's server-anchored instant and acts as the ceiling described in
 * rule 3, so this function is pure for a given payload.
 */
export function latestOperationalActivityAt(data: OperationalSummary | undefined, now: Date): string | null {
  if (!data) return null;
  const ceiling = now.getTime();
  let latest = Number.NEGATIVE_INFINITY;

  for (const key of ACTIVITY_COLLECTIONS) {
    const rows = data[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      for (const field of ACTIVITY_TIMESTAMP_FIELDS) {
        const raw = (row as Record<string, unknown>)[field];
        if (typeof raw !== "string") continue;
        const time = Date.parse(raw);
        // Unparseable is not "now", and later-than-now is not "just now".
        if (!Number.isFinite(time) || time > ceiling) continue;
        if (time > latest) latest = time;
      }
    }
  }

  return latest === Number.NEGATIVE_INFINITY ? null : new Date(latest).toISOString();
}

/** Relative label for a past instant, against the caller's own instant. Shared with the
 *  "What changed" surface so the two speak about time the same way. */
export function relativeLabel(occurredMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - occurredMs) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(occurredMs).toISOString().slice(0, 10);
}

/**
 * The header's "Updated ..." value, or null when this project has no dated activity —
 * in which case the header states no time rather than guessing one.
 */
export function deriveLastUpdatedLabel(data: OperationalSummary | undefined, now: Date): string | null {
  const latest = latestOperationalActivityAt(data, now);
  if (latest === null) return null;
  return relativeLabel(Date.parse(latest), now.getTime());
}
