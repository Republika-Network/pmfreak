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
 *   3. A value later than the SERVER's own reading is ignored rather than reported as "just
 *      now". `observed_at` is supplied by a human and can legitimately be mis-entered; the
 *      honest answer to "when was this last updated" is never a moment in the future. When
 *      nothing qualifies, the result is null and the header shows no timestamp at all.
 *
 * Rule 3 turns on WHOSE clock decides what "future" means, and the browser's cannot. The
 * Command Center advances a presentation clock from the client so relative labels tick
 * forward between loads; handing that same value to this function let a browser running ten
 * minutes fast accept an `observed_at` the server would call future, quietly defeating the
 * guard. So the two clocks are now separate concerns and only one of them is authoritative:
 *
 *   ACTIVITY CEILING   what counts as "already happened"
 *   LABEL BASELINE     what "ago" is measured from
 *
 * Both are the server's own reading for the payload, and both are read from the payload
 * itself rather than accepted as arguments — so a caller cannot hand these functions a
 * skewable clock even by accident. Nothing in this module reads a clock.
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
 *
 * The list was audited column-by-column against the sixteen tables
 * `load_operational_summary` reads. Three findings worth recording, so the next reader does
 * not have to redo the work:
 *
 *   - `operational_raw_inputs` has NO `created_at` or `updated_at`. Its persisted activity
 *     timestamp is `captured_at` — the column the service itself orders that query by, and
 *     the one the service reads as the raw input's `recordedAt`. It is deliberately not the
 *     same fact as `occurred_at`, which is when the event happened in the world and can be
 *     far older than the moment PMFreak captured it. Without `captured_at`, a raw input
 *     captured minutes ago was invisible to the header until something downstream of it
 *     existed.
 *   - `evidence_items.frozen_at` and `recommended_actions.decided_at` are both written in
 *     the SAME statement as `updated_at = now()`, which is already read here. They can
 *     therefore never carry activity this list misses, and adding them would change no
 *     answer.
 *   - Everything else unlisted is a deadline or a planning date: `expires_at`,
 *     `valid_until`, `stale_at`, `deferred_until`, `due_date`, `start_date`, and the
 *     baseline/forecast/planned schedule columns. Reading any of them would date the
 *     project forward to something that has not happened.
 */
export const ACTIVITY_TIMESTAMP_FIELDS = [
  "created_at",
  "updated_at",
  "recorded_at",
  "persisted_at",
  "evaluated_at",
  "occurred_at",
  /** `operational_raw_inputs`: when PMFreak captured the input. That table has no
   *  `created_at`/`updated_at`, and this is the column the summary query orders by. */
  "captured_at",
  "observed_at",
  "queued_at",
  "started_at",
  "blocked_at",
  "failed_at",
  "completed_at",
  "last_transition_at",
] as const;

/**
 * The server's own reading for this payload — the only clock allowed to decide what
 * "future" means. Null when the payload carries no trustworthy server time.
 *
 * `generatedAt` is the server's reading at load. `assurance.asOf` is produced by
 * `get_operational_assurance_summary` in the same request and is the fallback when an older
 * payload shape carries no `generatedAt`. Both are server-side; neither is ever treated as
 * project activity (see `ACTIVITY_COLLECTIONS`, which contains no summary metadata).
 *
 * There is deliberately no `new Date()` fallback. A client clock cannot adjudicate whether
 * persisted server state is in the future, and silently substituting one would keep the
 * label alive by dropping the guarantee it depends on.
 */
export function serverActivityCeiling(data: OperationalSummary | undefined): Date | null {
  for (const candidate of [data?.generatedAt, data?.assurance?.asOf]) {
    if (typeof candidate !== "string") continue;
    const time = Date.parse(candidate);
    if (Number.isFinite(time)) return new Date(time);
  }
  return null;
}

/**
 * The newest moment this project actually did something, ISO-8601, or null when no record
 * carries a usable timestamp — or when the payload carries no server anchor to judge
 * "future" against, in which case no freshness claim is made at all.
 *
 * Pure for a given payload: the ceiling comes from the payload, not from a clock.
 */
export function latestOperationalActivityAt(data: OperationalSummary | undefined): string | null {
  if (!data) return null;
  const anchor = serverActivityCeiling(data);
  // No trustworthy server reading: refuse to answer rather than answer with the browser's.
  if (anchor === null) return null;
  const ceiling = anchor.getTime();
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
 * The header's "Updated ..." value, or null when this project has no dated activity — in
 * which case the header states no time rather than guessing one.
 *
 * BOTH ends of this subtraction are server-side: the activity is a persisted column, and
 * the instant it is measured against is the server's own reading for the same payload. The
 * browser's clock is not consulted at all, so it can neither decide what counts as activity
 * nor distort how old that activity appears. A browser running ten minutes fast reports the
 * same "2 minutes ago" as one running ten minutes slow.
 *
 * The cost is that the label does not tick between loads. That is the right trade: the
 * summary revalidates on an interval and on focus, so the reading is refreshed from the
 * server anyway, and a label that is accurate at every load beats one that drifts with
 * whatever the local clock happens to believe.
 */
export function deriveLastUpdatedLabel(data: OperationalSummary | undefined): string | null {
  const latest = latestOperationalActivityAt(data);
  const anchor = serverActivityCeiling(data);
  if (latest === null || anchor === null) return null;
  return relativeLabel(Date.parse(latest), anchor.getTime());
}
