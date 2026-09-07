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
 *
 * A Decision may hold SEVERAL branches, and the grouping is a statement about the whole
 * chain. One achieved branch does not close a Decision that still has work running under
 * another — see `classifyChainProgress` below.
 */
export type ChainProgressGroup = "in_progress" | "not_progressing" | "closed";

/**
 * Is THIS branch still moving?
 *
 * `isBranchLive` answers "can a canonical operation still be run here", and it is true for
 * an achieved Outcome — the Observation path stays open after achievement. That is correct
 * for its own question and wrong for this one, so achievement and supersession are excluded
 * first, using the same two facts `describeChainStatus` uses: `boundary.outcomeAchieved`
 * and `UNOBSERVABLE_OUTCOME_STATES`.
 *
 * Everything here is a canonical fact about the branch. No parallel lifecycle is invented.
 */
function isBranchProgressing(branch: GovernedExecutionChain["branches"][number]): boolean {
  // Achieved is finished work, not work in flight.
  if (branch.boundary.outcomeAchieved) return false;
  // Superseded is a dead end the contract defines no transition out of.
  if (branch.outcome !== null && UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state)) return false;
  return isBranchLive(branch);
}

/**
 * Classifies ONE chain.
 *
 * `material_action_proposals.source_decision_id` carries no unique constraint, so a single
 * Decision may legitimately fan out into several Action -> Task -> Execution -> Outcome
 * branches. The first cut of this selector asked "does ANY branch have an achieved
 * Outcome?" before it asked whether any OTHER branch was still running, and answered
 * `closed` for a Decision with live work under it:
 *
 *     D1 ├── A1 -> T1 -> O1 achieved
 *        └── A2 -> T2 -> E2 running        <- still real work, filed under "Closed"
 *
 * A chain is a whole; one finished branch does not finish it. So liveness is now decided
 * across ALL branches before any terminal reading, and a terminal reading is only reached
 * once nothing is moving anywhere in the chain.
 *
 * Precedence, and why each step comes where it does:
 *
 *   1. A rejected Decision stops the chain regardless of anything beneath it — there is no
 *      branch it could legitimately have.
 *   2. No Action requested: a Decision is not work.
 *   3. ANY branch still progressing: the chain is progressing. This is the fix.
 *   4. Nothing progressing, and something achieved or superseded: terminal.
 *   5. Otherwise: expired, stale, or refused by governance — open, but not moving.
 */
export function classifyChainProgress(chain: GovernedExecutionChain): ChainProgressGroup {
  // Terminal: the canonical Decision stops here.
  if (chain.decisionStatus === "rejected") return "closed";

  // A Decision with no Material Action has nothing under way to report.
  if (chain.branches.length === 0) return "not_progressing";

  // Whole-chain liveness, decided BEFORE any terminal reading.
  if (chain.branches.some(isBranchProgressing)) return "in_progress";

  // Nothing is moving. Now the terminal readings apply, in `describeChainStatus`'s order:
  // achievement first, then supersession.
  if (chain.branches.some((branch) => branch.boundary.outcomeAchieved)) return "closed";
  if (
    chain.branches.some(
      (branch) => branch.outcome !== null && UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state)
    )
  ) {
    return "closed";
  }

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
