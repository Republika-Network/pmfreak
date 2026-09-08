import {
  UNOBSERVABLE_OUTCOME_STATES,
  type GovernedActionBranch,
  type GovernedExecutionChain,
} from "./execution-read-model";

/**
 * UX-W4 — the human operating loop, derived from persisted canonical facts.
 *
 *     DECIDE -> DO -> VERIFY -> LEARN
 *
 * This module is PURE. It reads the canonical projection `buildExecutionChains` already
 * produces and adds no request, no clock and no state of its own, so a test can assert
 * what a PM is told without standing up a browser or a database.
 *
 * It renames nothing beneath itself. The canonical chain is still
 *
 *     Decision -> Material Action -> Task -> Execution -> Outcome -> Observation
 *
 * and every phase below is a reading of rows that already exist. Where the canonical model
 * cannot answer a human question, this module says so rather than inventing an answer.
 *
 * ── Three canonical facts the phases rest on ────────────────────────────────
 *
 * 1. A rejected Decision can never carry work. `persist_governed_material_action` selects
 *    its source with `decision_status in ('accepted','modified')`, so a rejected Decision
 *    is INCAPABLE of holding a Material Action. "No follow-through is expected" is
 *    therefore a fact about the contract, not an inference from an empty collection — which
 *    is what lets this surface close such a Decision instead of reporting missing work.
 *
 * 2. An Outcome exists only after work finished. `ensure_canonical_expected_outcome`
 *    requires a `completed` `internal_task_executions` row, so an Outcome row can never
 *    appear under unfinished work.
 *
 * 3. An Outcome row is an EXPECTATION, not a result. It is inserted in state `expected`,
 *    and only `record_canonical_outcome_observation` moves it — to `achieved`,
 *    `partially_achieved`, `not_achieved`, `disputed` or `inconclusive`, from LIVE
 *    evidence. So "an Outcome exists" must never be read as "we know how it went", and
 *    completing work must never be read as success.
 *
 * ── One honest deviation from the naive mapping, and why ────────────────────
 *
 * A reasonable first guess is "Outcome exists + Observation absent -> LEARN pending". This
 * model cannot support that sentence. Because of fact 3, an Outcome with no Observation is
 * precisely the state in which the RESULT IS NOT YET KNOWN — so it is VERIFY, not LEARN.
 * Calling it LEARN would tell a PM the result is in while the canonical state says nothing
 * has been established.
 *
 * The consequence is that in this model the Observation both establishes the result and
 * records the learning: there is no representable state of "we know the result but learned
 * nothing". Manufacturing one would mean synthesising learning from Outcome text, which is
 * exactly what must not happen. LEARN is therefore reached when an Observation exists, and
 * it carries the Observation's own summary, state and data-quality qualifiers.
 */

/** The human loop. Ordered: each phase is strictly later than the one before it. */
export type JourneyPhase = "decide" | "do" | "verify" | "learn";

export const JOURNEY_PHASES: readonly JourneyPhase[] = ["decide", "do", "verify", "learn"];

/** Human labels. Presentation only — never persisted, never sent to a write path. */
export const JOURNEY_PHASE_LABELS: Readonly<Record<JourneyPhase, string>> = Object.freeze({
  decide: "Decide",
  do: "Do",
  verify: "Verify",
  learn: "Learn",
});

/**
 * How one phase reads for one journey.
 *
 * `not_expected` is a first-class answer, not a styling variant: a rejected Decision's DO,
 * VERIFY and LEARN are not "upcoming", they are never going to happen, and saying
 * "upcoming" would leave a closed loop looking permanently unfinished.
 */
export type JourneyPhaseMark = "complete" | "current" | "upcoming" | "not_expected";

/**
 * Why a journey is no longer moving, or that it still is.
 *
 * `no_action_expected` — the canonical Decision forecloses work (fact 1 above).
 * `stopped`            — every branch reached a state the contract defines no exit from.
 * `loop_closed`        — every branch that could run, ran, and was observed.
 */
export type JourneyClosure = "open" | "no_action_expected" | "stopped" | "loop_closed";

/** What the PM may be told about who is carrying the work. */
export type JourneyOwner = {
  /** True when the canonical actor id is this viewer. */
  isYou: boolean;
  /** The persisted canonical actor. Kept for disclosure; never rendered as a name. */
  canonicalActorId: string;
  /** Which canonical row named this actor. */
  source: "execution" | "action" | "decision";
};

/** One canonical Material Action and the work under it, read as a human step. */
export type BranchJourney = {
  branchId: string;
  actionId: string;
  phase: JourneyPhase;
  /** True when the contract defines no operation that continues this branch. */
  stopped: boolean;
  /** What is happening, in the PM's language. Always derived from persisted rows. */
  state: string;
  /** The real next step, or null when nothing is pending on this branch. */
  next: string | null;
  /** Set when a linked canonical record this branch depends on could not be resolved. */
  partialReason: string | null;
  owner: JourneyOwner | null;
  /** What the canonical Outcome says happened on THIS branch. Null until established. */
  result: string | null;
  /** This branch's Observation summary. Null until one exists. */
  learning: string | null;
};

/**
 * One Decision, read as a human journey.
 *
 * `phase` is the CONSERVATIVE rollup across branches — see `rollUpPhase`. A Decision is not
 * finished because one of its branches is.
 */
export type DecisionJourney = {
  chainId: string;
  decisionId: string;
  decisionStatus: string;
  title: string;
  phase: JourneyPhase;
  closure: JourneyClosure;
  marks: Readonly<Record<JourneyPhase, JourneyPhaseMark>>;
  /** The Decision's own rationale — why this work exists. Null when none was recorded. */
  why: string | null;
  decisionRecordedAt: string | null;
  /** What is happening now, in the PM's language. */
  state: string;
  /** The real next step, or null when nothing is pending. */
  next: string | null;
  /** What the canonical Outcome says happened. Null until a result is established. */
  result: string | null;
  /** What the Observation recorded. Null until one exists. */
  learning: string | null;
  owner: JourneyOwner | null;
  branches: BranchJourney[];
  /** True when a linked canonical record could not be resolved anywhere in the chain. */
  partial: boolean;
  partialReason: string | null;
};

/**
 * Outcome states in which the RESULT IS NOT YET ESTABLISHED.
 *
 * `expected` is what `ensure_canonical_expected_outcome` inserts. `observing` is declared by
 * the P2-09 check constraint; no contract in this repository transitions into it, and it is
 * listed here because if one ever does, "being observed" is plainly not "observed".
 */
export const RESULT_PENDING_OUTCOME_STATES: readonly string[] = ["expected", "observing"];

/** Human phrasing for each canonical Outcome state. Achievement is never implied. */
const OUTCOME_RESULT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  achieved: "The expected result was achieved.",
  partially_achieved: "The expected result was partially achieved.",
  not_achieved: "The expected result was not achieved.",
  disputed: "The result is disputed.",
  inconclusive: "The result was inconclusive.",
});

/** Canonical Decision statuses that can carry work, per `persist_governed_material_action`. */
const WORK_BEARING_DECISION_STATUSES: readonly string[] = ["accepted", "modified"];

function isStopped(branch: GovernedActionBranch): boolean {
  return branch.outcome !== null && UNOBSERVABLE_OUTCOME_STATES.includes(branch.outcome.state);
}

/** Work is finished when the canonical boundary says so — the same two fields
 *  `buildBoundary` reads, in the same order, so the two can never disagree. */
function workFinished(branch: GovernedActionBranch): boolean {
  return branch.boundary.executionCompleted || branch.boundary.taskCompleted;
}

/**
 * True once an evidence-backed Observation has established the result.
 *
 * Exported because the "In Progress" grouping asks the same question. When it answered it
 * differently — excluding only `achieved` — a chain observed as `not_achieved` was filed
 * under the heading "In Progress" while this module called it LEARN, and one of the two was
 * lying to the PM. One predicate, one answer.
 */
export function isResultEstablished(branch: GovernedActionBranch): boolean {
  const state = branch.boundary.outcomeState;
  if (state === null) return false;
  if (RESULT_PENDING_OUTCOME_STATES.includes(state)) return false;
  if (UNOBSERVABLE_OUTCOME_STATES.includes(state)) return false;
  /*
   * A RESOLVED state is the result, and the Observation row is not required to believe it.
   *
   * An earlier cut demanded `observationCount > 0` as well, reasoning that only an
   * Observation can move an Outcome off `expected`. That is true of the contract and the
   * wrong test to apply here: `achieved` is a persisted canonical fact, and treating a
   * chain whose Observation could not be resolved as "result unknown" flipped finished work
   * back into "In Progress" — telling a PM work was under way when it had ended, which is a
   * worse lie than the one it was trying to prevent.
   *
   * The anomaly is real and is still reported, in the place it belongs: `branchPartialReason`
   * names the unresolvable Observation, and `learning` stays null rather than being invented.
   * The result is stated because the database states it; the learning is withheld because
   * nothing recorded it.
   */
  return true;
}

export function branchPhase(branch: GovernedActionBranch): JourneyPhase {
  if (!workFinished(branch)) return "do";
  if (!isResultEstablished(branch)) return "verify";
  return "learn";
}

function ownerOf(branch: GovernedActionBranch, actorUserId: string | null): JourneyOwner | null {
  const dispatched = branch.latestExecution?.dispatchedBy ?? null;
  if (dispatched) {
    return { isYou: dispatched === actorUserId, canonicalActorId: dispatched, source: "execution" };
  }
  const proposed = branch.action.proposedBy;
  if (proposed) {
    return { isYou: proposed === actorUserId, canonicalActorId: proposed, source: "action" };
  }
  return null;
}

/**
 * What is happening on this branch, said the way a PM would say it.
 *
 * Every sentence is a reading of persisted state. Where governance has withheld something,
 * the reason comes from `describeBranch`'s own vocabulary rather than a second opinion, so
 * the card and the canonical disclosure cannot tell different stories.
 */
function branchState(branch: GovernedActionBranch): string {
  if (isStopped(branch)) return "This work was superseded and is no longer being observed.";

  if (!branch.task) {
    if (branch.action.dispatchable) return "The action is authorised. The work has not been created yet.";
    if (branch.action.revoked) return "The authorisation for this action was revoked.";
    if (branch.action.expired) return "The authorisation for this action expired before work started.";
    if (branch.action.evaluationStale) return "The authorisation for this action is no longer current.";
    if (!branch.action.hasEvaluation) return "The action has been requested and is awaiting a governance check.";
    return "Governance has not authorised this action to become work.";
  }

  if (!workFinished(branch)) {
    const status = String(branch.latestExecution?.status ?? "not started").replaceAll("_", " ");
    if (status === "running") return "The work is under way.";
    if (status === "queued") return "The work is queued and has not started.";
    if (status === "blocked") return "The work is blocked.";
    if (status === "failed") return "The last attempt at this work failed.";
    return "The work has been created and has not started.";
  }

  if (!branch.boundary.outcomeExists) {
    return "The work is complete. What it was meant to achieve has not been recorded yet.";
  }
  if (!isResultEstablished(branch)) {
    return "The work is complete. The result has not been established yet.";
  }
  return OUTCOME_RESULT_LABELS[String(branch.boundary.outcomeState)] ?? "The result has been recorded.";
}

/**
 * The next real step on this branch.
 *
 * `offeredCommands` is what `p2_08_validate_execution_governance` would accept from THIS
 * actor right now, computed by the read model against the same gates the RPC applies. This
 * function only puts a human sentence on it — it never re-derives eligibility, so a PM is
 * never shown a step the server would refuse, and never told they are stuck when they are
 * not. Where the actor may not act, the sentence says who must, not what they should click.
 */
function branchNext(branch: GovernedActionBranch): string | null {
  if (isStopped(branch)) return null;

  if (!branch.task) {
    if (branch.action.dispatchable) return "Create the work for this action.";
    if (branch.action.expired || branch.action.evaluationStale) {
      return "This action needs a fresh authorisation before work can start.";
    }
    if (!branch.action.hasEvaluation) return "This action is waiting on a governance check.";
    return "This action cannot become work until governance authorises it.";
  }

  if (!workFinished(branch)) {
    const commands = branch.offeredCommands;
    const status = branch.latestExecution?.status ?? null;
    // `blocked` and `failed` are persisted statuses, and the canonical command that leaves
    // them is still `start`/`retry`. Naming the state is what stops "Start the work" from
    // reading as though nothing had gone wrong.
    if (status === "blocked" && commands.includes("start")) return "Resolve the blocker, then resume the work.";
    if (status === "failed" && commands.includes("retry")) return "Retry the work, or record that it failed.";
    if (commands.includes("start")) return "Start the work.";
    if (commands.includes("queue")) return "Queue the work to begin it.";
    if (commands.includes("retry")) return "Retry the work.";
    if (commands.includes("complete")) return "Record that the work finished.";
    return "The work cannot be advanced by you right now.";
  }

  if (!branch.boundary.outcomeExists) return "Record what this work was meant to achieve.";
  if (!isResultEstablished(branch)) return "Record what actually happened, with evidence.";
  return null;

}

/**
 * A linked canonical record this branch depends on that could not be resolved.
 *
 * The summary completes every downstream collection by EXACT canonical reference, so an
 * absence here is a genuine gap in the data rather than a truncated window — which is what
 * makes it safe to name. Nothing is fabricated to fill it and no completion is claimed
 * over it.
 */
function branchPartialReason(branch: GovernedActionBranch): string | null {
  if (isResultEstablished(branch) && branch.boundary.observationCount === 0) {
    // P2-09 moves an Outcome off `expected` only through an Observation, so a resolved
    // state with no Observation is a data-integrity anomaly rather than an ordinary gap.
    // The result is still shown; what is withheld is any claim about what was learned.
    return "The result is recorded, but the observation behind it cannot be resolved.";
  }
  if (branch.task && branch.task.sourceActionId !== null && branch.task.sourceActionId !== branch.action.actionId) {
    return "The work references a different action than the one it is filed under.";
  }
  return null;
}

export function buildBranchJourney(branch: GovernedActionBranch, actorUserId: string | null): BranchJourney {
  return {
    branchId: branch.id,
    actionId: branch.action.actionId,
    phase: branchPhase(branch),
    stopped: isStopped(branch),
    state: branchState(branch),
    next: branchNext(branch),
    partialReason: branchPartialReason(branch),
    owner: ownerOf(branch, actorUserId),
    result: isResultEstablished(branch)
      ? (OUTCOME_RESULT_LABELS[String(branch.boundary.outcomeState)] ?? null)
      : null,
    // Present only when an Observation actually recorded it. Never derived from the result.
    learning: branch.observations[0]?.summary ?? null,
  };
}

/**
 * The conservative rollup.
 *
 * `material_action_proposals.source_decision_id` carries no unique constraint, so one
 * Decision may fan out into several branches. A Decision is only as far along as its LEAST
 * advanced live branch:
 *
 *     D1 |-- A1 -> T1 -> E1 complete -> O1 achieved -> observed     (learn)
 *        \-- A2 -> T2 -> E2 running                                 (do)
 *
 * The journey is DO. Reporting LEARN because one branch finished would tell a PM the loop
 * is closed while real work is still running under the same decision.
 *
 * Stopped branches are excluded before the minimum is taken: a superseded branch is not
 * "still in DO", and letting it hold the rollup down would strand a Decision whose live
 * work genuinely finished.
 */
function rollUpPhase(branches: BranchJourney[]): JourneyPhase {
  const live = branches.filter((branch) => !branch.stopped);
  const considered = live.length > 0 ? live : branches;
  let index = JOURNEY_PHASES.length - 1;
  for (const branch of considered) {
    index = Math.min(index, JOURNEY_PHASES.indexOf(branch.phase));
  }
  return JOURNEY_PHASES[index] ?? "do";
}

function marksFor(phase: JourneyPhase, closure: JourneyClosure): Record<JourneyPhase, JourneyPhaseMark> {
  // A recorded terminal Decision is what makes any of this exist, so DECIDE is complete in
  // every journey this module produces.
  if (closure === "no_action_expected") {
    return { decide: "complete", do: "not_expected", verify: "not_expected", learn: "not_expected" };
  }
  if (closure === "loop_closed") {
    return { decide: "complete", do: "complete", verify: "complete", learn: "complete" };
  }
  const current = JOURNEY_PHASES.indexOf(phase);
  const marks = {} as Record<JourneyPhase, JourneyPhaseMark>;
  for (const [index, key] of JOURNEY_PHASES.entries()) {
    marks[key] = index < current ? "complete" : index === current ? "current" : "upcoming";
  }
  marks.decide = "complete";
  return marks;
}

/**
 * Reads ONE canonical chain as a human journey.
 *
 * `actorUserId` is only ever used to answer "is this mine?". It grants nothing: every
 * control this surface offers is gated by `offeredCommands`, which the read model derives
 * from the server's own rules, and every write is independently authorised by the RPC.
 */
export function deriveDecisionJourney(
  chain: GovernedExecutionChain,
  actorUserId: string | null = null
): DecisionJourney {
  const branches = chain.branches.map((branch) => buildBranchJourney(branch, actorUserId));

  const base = {
    chainId: chain.id,
    decisionId: chain.decisionId,
    decisionStatus: chain.decisionStatus,
    title: chain.title,
    why: chain.rationale,
    decisionRecordedAt: chain.decisionRecordedAt,
    branches,
  };

  const partialBranch = branches.find((branch) => branch.partialReason !== null) ?? null;
  const partial = partialBranch !== null;
  const partialReason = partialBranch?.partialReason ?? null;

  // 1. The canonical Decision forecloses work. Not a gap — a completed judgment.
  if (!WORK_BEARING_DECISION_STATUSES.includes(chain.decisionStatus)) {
    return {
      ...base,
      phase: "decide",
      closure: "no_action_expected",
      marks: marksFor("decide", "no_action_expected"),
      state: "This recommendation was rejected. The decision is complete.",
      next: null,
      result: null,
      learning: null,
      owner: null,
      partial,
      partialReason,
    };
  }

  // 2. Eligible to carry work, but none has been requested. This is a real next step, not
  //    a defect: the contract permits an Action here and the PM has not asked for one.
  if (branches.length === 0) {
    return {
      ...base,
      phase: "do",
      closure: "open",
      marks: marksFor("do", "open"),
      state: "The decision is recorded. No action has been requested from it yet.",
      next: "Request the action that should follow this decision.",
      result: null,
      learning: null,
      owner: null,
      partial,
      partialReason,
    };
  }

  const live = branches.filter((branch) => !branch.stopped);
  const phase = rollUpPhase(branches);

  const closure: JourneyClosure =
    live.length === 0
      ? "stopped"
      : live.every((branch) => branch.phase === "learn")
        ? "loop_closed"
        : "open";

  // The branch the summary speaks for: the least advanced live one, because that is what
  // still needs the PM. Falls back to the first branch when everything has stopped.
  const leading =
    live.find((branch) => branch.phase === phase) ?? live[0] ?? branches[0];
  const leadingChainBranch =
    chain.branches.find((branch) => branch.id === leading.branchId) ?? chain.branches[0];

  /*
   * A chain-level result is only honest when it is UNAMBIGUOUS.
   *
   * The first cut reported the first observed branch's result at chain level, and a
   * Decision with one achieved branch and one still running then read "Result: the expected
   * result was achieved" while work continued underneath it. That is the multi-branch
   * mistake in its most damaging form: not a wrong phase, a wrong outcome.
   *
   * So the chain speaks for a result only when the loop is closed AND exactly one branch
   * carries one. Everything else keeps its result on the branch, where the drawer renders
   * it per action and nothing is generalised across branches that did different things.
   */
  const observedBranches = branches.filter((branch) => branch.result !== null);
  const resultBranch =
    closure === "loop_closed" && observedBranches.length === 1 ? observedBranches[0] : null;

  const state =
    closure === "stopped"
      ? "This work was superseded and is no longer being observed."
      : live.length > 1 && phase !== "learn"
        ? `${leading.state} ${live.length} separate actions follow this decision.`
        : leading.state;

  return {
    ...base,
    phase,
    closure,
    marks: marksFor(phase, closure),
    state,
    next: closure === "stopped" ? null : leading.next,
    result: resultBranch?.result ?? null,
    learning: resultBranch?.learning ?? null,
    owner: leading.owner ?? ownerOf(leadingChainBranch, actorUserId),
    partial,
    partialReason,
  };
}

export function deriveDecisionJourneys(
  chains: GovernedExecutionChain[],
  actorUserId: string | null = null
): DecisionJourney[] {
  return chains.map((chain) => deriveDecisionJourney(chain, actorUserId));
}

/** Looks one journey up by its canonical Decision id. */
export function findDecisionJourney(
  journeys: DecisionJourney[],
  decisionId: string | null
): DecisionJourney | null {
  if (!decisionId) return null;
  return journeys.find((journey) => journey.decisionId === decisionId) ?? null;
}

/**
 * How the loop indicator should read this phase, in words.
 *
 * Phase is never communicated by colour or a glyph alone — this string is what a screen
 * reader announces and what a monochrome display shows.
 */
export function describePhaseMark(phase: JourneyPhase, mark: JourneyPhaseMark): string {
  const label = JOURNEY_PHASE_LABELS[phase];
  if (mark === "complete") return `${label}: done`;
  if (mark === "current") return `${label}: current step`;
  if (mark === "not_expected") return `${label}: not expected`;
  return `${label}: not started`;
}
