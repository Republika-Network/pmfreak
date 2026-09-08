import type { NeedsYouItem } from "./types";

/**
 * The human job an attention item asks of a PM.
 *
 * This is PRESENTATION semantics. No backend row is migrated to this taxonomy, no canonical
 * status is renamed, and the two attention sources keep their own models beneath it — the
 * grouping only answers "what is being asked of me", which is the question a PM opens the
 * Command Center with.
 *
 * Each job is derived from a fact the read models already carry, never guessed:
 *
 *   decision  the actor may SETTLE this item — record a decision that closes it. For a
 *             governed Recommendation that means at least one TERMINAL canonical status is
 *             permitted by the server-evaluated `actor_authority` map already projected
 *             onto the item; for a RAID suggestion, accept and reject are both terminal and
 *             always open on the bounded triage path.
 *   review    the actor may inspect the item but cannot settle it. Three real persisted
 *             conditions produce this, and all three are the contract's own behaviour
 *             rather than a category invented to fill out a heading:
 *               - no status at all is permitted (a read-only role), or
 *               - only the NON-terminal statuses are permitted, which is precisely what
 *                 `evaluateOperationalDecisionAuthority` returns for, say, a project
 *                 manager against a rule requiring sponsor authority. They may escalate or
 *                 record that more evidence is needed; they may not close it, or
 *               - the item's governed lineage is incomplete, so the canonical write would
 *                 be refused however much authority the actor holds. See below.
 *             That is exactly "assess, but do not authorize".
 *   approval  RESERVED AND NOT PRODUCED. See `APPROVAL_ITEMS_AVAILABLE` below.
 */
export type AttentionHumanJob = "decision" | "review" | "approval";

/**
 * Whether any attention source currently produces a genuine approval item.
 *
 * It does not. Needs You is fed by governed Recommendations awaiting a Decision and by
 * RAID-derived suggestions awaiting triage; neither is an authorization the human grants.
 * The governance `authorityRequired` field is a REQUIREMENT placed on a decision, not an
 * approval object, and the P2-06/P2-07 authorization of a Material Action is a governance
 * evaluation that happens after a Decision — it lives in the In Progress surface and is
 * never a Needs You item.
 *
 * So no Approvals group is rendered. Showing an empty one to satisfy a vocabulary would be
 * telling a PM that a kind of work exists which does not.
 */
export const APPROVAL_ITEMS_AVAILABLE = false;

/** PM-facing group headings. Never the source's internal vocabulary. */
export const HUMAN_JOB_GROUP_LABELS: Record<AttentionHumanJob, string> = {
  decision: "Decisions",
  review: "Reviews",
  approval: "Approvals",
};

/** PM-facing chip on a card. Singular — it names what this one item asks for. */
export const HUMAN_JOB_ITEM_LABELS: Record<AttentionHumanJob, string> = {
  decision: "Decision",
  review: "Review",
  approval: "Approval",
};

/** Order the groups are rendered in: what you can act on, then what you can only assess. */
export const HUMAN_JOB_ORDER: readonly AttentionHumanJob[] = ["decision", "review", "approval"];

/**
 * The job one item asks of this actor.
 *
 * Read from the decision panel the item already carries, which both sources populate from
 * their own authority model — the governed path from the server-evaluated per-status
 * authority, the RAID path from its bounded triage contract. Nothing is re-derived from
 * role names here, and no control is enabled or disabled by this function: it only reads
 * what the server already decided, to name what the PM is being asked for.
 *
 * An item offering no terminal control the actor may use is a review. An item with no
 * decision panel at all is also a review — the safe direction to fail, since the
 * alternative would file something under "Decisions" that offers no decision.
 */
export function humanJobFor(item: NeedsYouItem): AttentionHumanJob {
  const panel = item.drawer.decisionPanel;
  // Authority is not the only thing that decides whether a Decision can be recorded.
  //
  // `record_operational_decision` walks the governed lineage before it checks authority at
  // all, and raises `governed_lineage_incomplete` when the governance event, risk, signal
  // or evidence row is missing (20260611000000_operational_evidence_decision_loop.sql).
  // The write is REFUSED for such an item no matter who is asking, so calling it a
  // Decision because the actor holds authority would promise an action the server will not
  // accept. `blockedReason` is the read model's projection of exactly that state.
  //
  // This reads a condition the read model already computed. It does not re-implement the
  // server's gate, and it does not enable or disable any control — the panel's own
  // `blockedReason` still governs what is offered.
  if (panel?.blockedReason) return "review";
  const controls = panel?.controls ?? [];
  return controls.some((control) => control.terminal && control.allowed) ? "decision" : "review";
}

export type AttentionGroup = {
  job: AttentionHumanJob;
  /** Heading rendered above the group. */
  label: string;
  items: NeedsYouItem[];
};

/**
 * Splits the attention queue into human-job groups.
 *
 * Three properties this must keep, and which the tests assert:
 *
 *   1. Every item appears in exactly one group. An item shown twice would be counted twice
 *      by a PM deciding how much is on their plate.
 *   2. Relative order inside a group is the order the queue supplied. The read models
 *      already order attention; grouping is not a new prioritisation and must not become
 *      one by accident.
 *   3. Empty groups are omitted entirely, so a heading is never a promise of work that
 *      does not exist.
 */
export function groupAttentionItems(items: NeedsYouItem[]): AttentionGroup[] {
  const byJob = new Map<AttentionHumanJob, NeedsYouItem[]>();
  for (const item of items) {
    const job = humanJobFor(item);
    const bucket = byJob.get(job);
    if (bucket) bucket.push(item);
    else byJob.set(job, [item]);
  }
  return HUMAN_JOB_ORDER.flatMap((job) => {
    const grouped = byJob.get(job);
    if (!grouped || grouped.length === 0) return [];
    return [{ job, label: HUMAN_JOB_GROUP_LABELS[job], items: grouped }];
  });
}
