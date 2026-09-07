import {
  isBranchLive,
  UNOBSERVABLE_OUTCOME_STATES,
  type GovernedExecutionChain,
} from "./execution-read-model";

/**
 * Which governed chains may honestly be shown as work in progress.
 *
 * `buildExecutionChains` is deliberately COMPLETE: it projects one chain per persisted
 * Decision, including the ones that stop there — a rejected Decision, an achieved Outcome,
 * a superseded Outcome, an authorization that expired. That completeness is correct and is
 * not changed here. What was wrong was rendering all of it beneath the word "In Progress".
 * Every badge was accurate and the list as a whole still said something false, because a
 * section heading is a claim about its contents.
 *
 * So this is a PRESENTATION selector over the canonical projection. It reads the same
 * persisted state `describeChainStatus` reads — the Decision status, `boundary.outcomeAchieved`,
 * `UNOBSERVABLE_OUTCOME_STATES`, and `isBranchLive` — in the same order, and it invents no
 * state of its own. No chain is dropped: each lands in exactly one group, and every group
 * is rendered.
 *
 * The four non-live states the review asked to be decided explicitly, and why each is
 * `not_progressing` rather than `in_progress`:
 *
 *   - Decision recorded, no Action yet — a decision is not work. Nothing has been
 *     requested, so nothing is under way. It stays visible and un-collapsed because
 *     requesting the first governed Material Action is the PM's next move and this row is
 *     the only way to reach it.
 *   - Authorization expired / stale — the Action exists but `dispatchBlockReason` refuses
 *     new work against it. Work is not continuing; it is waiting on a fresh authorization.
 *   - Not authorized to proceed — the governance verdict is `requires_approval`, `denied`,
 *     `degraded` or `revoked`. Calling that progress would tell a PM the thing governance
 *     just stopped is happening.
 *
 * None of these is closed either — they are all still open loops — so they are neither
 * counted as progress nor buried with the terminal chains.
 */
export type ChainProgressGroup = "in_progress" | "not_progressing" | "closed";

/**
 * Classifies ONE chain, mirroring `describeChainStatus`'s precedence exactly:
 * terminal stopped, then terminal achieved, then "no action yet", then liveness.
 *
 * Precedence is the whole correctness argument. A rejected Decision that also carries a
 * live-looking branch is stopped, and reading liveness first would have said otherwise.
 */
export function classifyChainProgress(chain: GovernedExecutionChain): ChainProgressGroup {
  // Terminal: the canonical Decision stops here.
  if (chain.decisionStatus === "rejected") return "closed";

  // Terminal: the expected Outcome was achieved. Achieved work is finished work.
  if (chain.branches.some((branch) => branch.boundary.outcomeAchieved)) return "closed";

  // A Decision with no Material Action has nothing under way to report.
  if (chain.branches.length === 0) return "not_progressing";

  if (chain.branches.some((branch) => isBranchLive(branch))) return "in_progress";

  // Terminal: a superseded Outcome is a dead end the contract defines no transition out
  // of, so it is closed rather than blocked — naming it an authorization problem would
  // imply reauthorizing could revive it, which it cannot.
  const superseded = chain.branches.some(
    (branch) => branch.outcome !== null && UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state)
  );
  if (superseded) return "closed";

  // Expired, stale, or refused by governance: open, but not moving.
  return "not_progressing";
}

export type ChainProgressProjection = {
  /** Chains a PM may truthfully be told are under way. */
  inProgress: GovernedExecutionChain[];
  /** Open, but nothing is advancing — the next move is not the machine's. */
  notProgressing: GovernedExecutionChain[];
  /** Terminal: rejected, achieved, or superseded. Preserved, never counted as progress. */
  closed: GovernedExecutionChain[];
};

/** Splits the canonical projection into the three groups, preserving the read model's own
 *  ordering within each so the surface stays deterministic. */
export function projectChainProgress(chains: GovernedExecutionChain[]): ChainProgressProjection {
  const projection: ChainProgressProjection = { inProgress: [], notProgressing: [], closed: [] };
  for (const chain of chains) {
    const group = classifyChainProgress(chain);
    if (group === "in_progress") projection.inProgress.push(chain);
    else if (group === "closed") projection.closed.push(chain);
    else projection.notProgressing.push(chain);
  }
  return projection;
}
