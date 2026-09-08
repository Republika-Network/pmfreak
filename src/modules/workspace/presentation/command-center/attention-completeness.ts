/**
 * Whether the Command Center actually knows what needs this PM's attention.
 *
 * "Needs your attention" is fed by TWO independent reads — governed Recommendations from
 * the operational flow, and RAID-derived suggested actions from their own endpoint. They
 * resolve separately, and the screen used to decide the whole section's state from the
 * first one alone. So the operational flow could return zero governed items while the
 * suggestion read was still in flight or had failed, and the product would say
 *
 *     You're clear.
 *
 * on the strength of half an answer. "Nothing needs you" is a claim that requires every
 * source of attention to have been heard from; anything less is "we do not know yet".
 *
 * This module keeps that rule in one place, as data rather than as a conjunction of
 * booleans spread through a render. It does not merge the two collections: they remain
 * different business objects with different write paths and different authority language.
 * It only decides whether their combined answer is COMPLETE.
 */

export type AttentionSourceRead = {
  /** What this source contributes, in the PM's words. Used to explain an incomplete read. */
  label: string;
  /** Still resolving. */
  loading: boolean;
  /** Resolved with a failure. */
  failed: boolean;
  /**
   * Resolved successfully but KNOWN not to be the whole answer.
   *
   * A request finishing says nothing about whether it returned everything. The governed
   * source proves its own completeness against the project-wide open count, and when that
   * proof fails the surface must keep showing what it has while refusing to state a total
   * or call the PM clear.
   */
  partial?: boolean;
};

export type AttentionCompleteness = {
  /** Any source is still resolving. */
  loading: boolean;
  /** Any source failed. A failure is never an empty success. */
  failed: boolean;
  /** Any source resolved but returned less than it knows exists. */
  partial: boolean;
  /**
   * Every source resolved successfully. ONLY when this is true may the surface state a
   * definitive count, or tell the PM there is nothing waiting on them.
   */
  complete: boolean;
  /** The sources that have not resolved successfully, for an honest explanation. */
  unresolved: string[];
};

export function assessAttentionCompleteness(sources: AttentionSourceRead[]): AttentionCompleteness {
  const loading = sources.some((source) => source.loading);
  const failed = sources.some((source) => source.failed);
  const partial = sources.some((source) => source.partial === true);
  return {
    loading,
    failed,
    partial,
    // A known-partial source is not a complete answer, however cleanly its request finished.
    complete: !loading && !failed && !partial,
    unresolved: sources
      .filter((source) => source.loading || source.failed || source.partial === true)
      .map((source) => source.label),
  };
}
