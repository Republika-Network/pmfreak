import {
  ACTION_ELIGIBLE_DECISION_STATUSES,
  isBranchLive,
  UNOBSERVABLE_OUTCOME_STATES,
  type GovernedExecutionChain,
} from "./execution-read-model";
import { isLearningProven, isResultEstablished } from "./decision-journey";

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
 *   - Result recorded, Observation unresolvable — the work finished and the database
 *     states the result, but the Observation that established it cannot be resolved, so
 *     nothing proves what was learned. Neither running nor closed.
 *   - One branch terminal, another still open — a Decision fans out, and a superseded or
 *     observed branch says nothing about a sibling whose authorisation lapsed. The chain is
 *     as open as its least finished branch.
 *
 * None of these is closed either — they are all still open loops — so they are neither
 * counted as progress nor buried with the terminal chains.
 *
 * A Decision may hold SEVERAL branches, and the grouping is a statement about the whole
 * chain. One achieved branch does not close a Decision that still has work running under
 * another — see `classifyChainProgress` below.
 */
export type ChainProgressGroup = "in_progress" | "not_progressing" | "closed";

/** A dead end the contract defines no transition out of. One definition, because both
 *  questions below ask it and they must never answer it differently. */
function isBranchSuperseded(branch: GovernedExecutionChain["branches"][number]): boolean {
  return branch.outcome !== null && UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state);
}

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
  /*
   * W4: a RESULT — not only an achieved one — is finished work.
   *
   * This asked `boundary.outcomeAchieved`, which is true for exactly one canonical state.
   * A branch observed as `not_achieved`, `partially_achieved`, `disputed` or `inconclusive`
   * therefore stayed "progressing" and was listed under the heading "In Progress", even
   * though its work had finished and its result had been recorded from live evidence. A
   * negative result is a completed loop, not unfinished work, and filing it as progress
   * both overstates activity and hides that the PM already has their answer.
   *
   * An Outcome carrying a resolved state whose Observation cannot be resolved is NOT
   * running work either: the database states the result, and calling it "in progress" would
   * tell a PM work was continuing after it had ended. `isResultEstablished` is therefore
   * the right predicate here, and it deliberately does not require the Observation row.
   * Whether the LOOP closed is a different question, asked once below with
   * `isLearningProven` — the same predicate `deriveDecisionJourney` uses, so the two
   * surfaces cannot call one chain closed and open.
   */
  if (isResultEstablished(branch)) return false;
  // Superseded is a dead end the contract defines no transition out of.
  if (isBranchSuperseded(branch)) return false;
  return isBranchLive(branch);
}

/**
 * Is THIS branch at a canonical END?
 *
 * Exactly two routes reach one, and they are the same two `deriveDecisionJourney` uses to
 * decide `loop_closed` and `stopped`:
 *
 *   - `isLearningProven` — it ran, it produced a result, and an Observation established it.
 *     Achievement is not required: a negative or inconclusive result is a completed loop.
 *   - superseded — a dead end the contract defines no transition out of.
 *
 * A resolved Outcome whose Observation cannot be resolved is deliberately NOT terminal. The
 * result is known and the learning is not, so the loop never closed.
 */
function isBranchTerminal(branch: GovernedExecutionChain["branches"][number]): boolean {
  return isLearningProven(branch) || isBranchSuperseded(branch);
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
 * A chain is a whole; one finished branch does not finish it. That holds in BOTH directions,
 * and the second one was missed for a while: liveness is decided across all branches before
 * any terminal reading, AND the terminal reading itself is over all branches, because a
 * superseded or observed branch says nothing about a sibling whose authorisation lapsed.
 *
 * Precedence, and why each step comes where it does:
 *
 *   1. A Decision that cannot carry work stops the chain regardless of anything beneath it
 *      — there is no branch it could legitimately have.
 *   2. No Action requested: a Decision is not work.
 *   3. ANY branch still progressing: the chain is progressing.
 *   4. EVERY branch terminal — learning-proven or canonically stopped: the chain is closed.
 *      `every`, not `some`: one finished branch does not finish a Decision, whichever way
 *      it finished.
 *   5. Otherwise at least one branch is open and none is moving — expired, stale, refused
 *      by governance, or a result whose Observation cannot be resolved.
 */
export function classifyChainProgress(chain: GovernedExecutionChain): ChainProgressGroup {
  /*
   * Terminal: the canonical Decision cannot carry work at all.
   *
   * Read from the SAME exported constant `persist_governed_material_action` is pinned to,
   * rather than naming `rejected` here, so this cannot drift away from the set
   * `deriveDecisionJourney` uses to decide `no_action_expected`.
   */
  if (!ACTION_ELIGIBLE_DECISION_STATUSES.includes(chain.decisionStatus)) return "closed";

  // A Decision with no Material Action has nothing under way to report.
  if (chain.branches.length === 0) return "not_progressing";

  // Whole-chain liveness, decided BEFORE any terminal reading.
  if (chain.branches.some(isBranchProgressing)) return "in_progress";

  /*
   * Nothing is moving. "Closed" is a WHOLE-CHAIN property, so it needs EVERY branch.
   *
   * This asked `some(isResultEstablished)` and then `some(superseded)`, and either one
   * closed the chain on its own. That is the multi-branch mistake again, one group along:
   *
   *     D ├── A1 -> T1 -> E1 completed -> O1 superseded        <- terminal
   *       └── A2  authorisation expired, no Task ever created  <- OPEN, and needs the PM
   *
   * Nothing is progressing, so the old code fell to `some(superseded)` and filed the whole
   * Decision under "Closed" — while `deriveDecisionJourney` reported `closure = "open"` and
   * the server-side root named it as open work. One terminal branch cannot close another
   * branch that is still waiting on a human. The same held for `some(isResultEstablished)`:
   * an observed result is no more entitled to close the chain than a superseded one.
   *
   * So terminal grouping is now the exact whole-chain condition the journey model uses:
   * every branch is either learning-proven or canonically stopped. Anything short of that
   * leaves at least one branch open, and an open branch that is not moving is precisely
   * what "Not progressing" means. A resolved result whose Observation cannot be resolved is
   * not terminal either, which keeps the previous remediation's answer without needing a
   * special case for it.
   */
  if (chain.branches.every(isBranchTerminal)) return "closed";

  // At least one branch is open and none is advancing: expired, stale, refused by
  // governance, or a result whose Observation cannot be resolved. The next move is the
  // PM's, and the row says which.
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
