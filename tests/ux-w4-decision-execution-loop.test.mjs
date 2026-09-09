/**
 * UX-W4 — decision to execution.
 *
 * W3 made the moment of judgment understandable and stopped there. A PM could decide, and
 * then had no way to learn what their decision had started, whether it finished, what the
 * result was, or what anyone had learned from it. The canonical chain
 *
 *     Decision -> Material Action -> Task -> Execution -> Outcome -> Observation
 *
 * already carried all of that. It was simply never said in a sentence a PM would use.
 *
 * W4's job is one loop: DECIDE -> DO -> VERIFY -> LEARN, derived from persisted rows and
 * never from optimism. Nothing beneath the presentation moves: no migration, no new
 * endpoint, no renamed entity, no new write path.
 *
 * These assertions run against REAL renders through the REAL read models and, for the
 * completeness scenarios, the REAL `getOperationalSummary` against a faithful Data API
 * stub — because whether a PM is being told the truth is a question about what the
 * projection produced and what the DOM says, and source reading cannot answer either.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  JOURNEY_PHASES,
  RESULT_PENDING_OUTCOME_STATES,
} from "../src/modules/workspace/presentation/command-center/decision-journey.ts";
import {
  ACTION_ELIGIBLE_DECISION_STATUSES,
  UNOBSERVABLE_OUTCOME_STATES,
} from "../src/modules/workspace/presentation/command-center/execution-read-model.ts";

const read = (path) => readFileSync(path, "utf8");

const runHarness = (file) =>
  JSON.parse(
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

/** Canonical fixtures through the real chain builder, journey derivation and renders. */
const harness = runHarness("tests/ux-w4-decision-journey-harness.tsx");
/** The real `getOperationalSummary` against a faithful Data API stub. */
const roots = runHarness("tests/ux-w4-execution-root-harness.tsx");
/** The same real service, read across a canonical transition through a per-table snapshot
 *  assignment — one legal interleaving of independent statements around one commit. */
const mvcc = runHarness("tests/ux-w4-execution-root-mvcc-harness.tsx");

const byKey = Object.fromEntries(harness.results.map((entry) => [entry.key, entry]));
const one = (key) => {
  const entry = byKey[key];
  assert.ok(entry, `missing scenario: ${key}`);
  assert.equal(entry.journeys.length, 1, `${key} should produce exactly one journey`);
  return { entry, journey: entry.journeys[0] };
};

// ── A. The W3 boundary ───────────────────────────────────────────────────────
// Unresolved human judgment stays with Needs You. A Decision ROW existing is not the same
// fact as a decision having been reached.

test("A1/A2 — a non-terminal decision produces no execution chain at all", () => {
  for (const key of ["escalatedStaysWithAttention", "needsMoreEvidenceStaysWithAttention"]) {
    const entry = byKey[key];
    assert.equal(entry.chainCount, 0, `${key} must not enter the execution surface`);
    assert.equal(entry.progress.inProgress.length, 0);
    assert.equal(entry.progress.notProgressing.length, 0);
    assert.equal(entry.progress.closed.length, 0);
  }
});

test("A3 — the work-bearing statuses are exactly the ones the contract accepts", () => {
  // `persist_governed_material_action` selects its source with
  // `decision_status in ('accepted','modified')`. If that set ever changes, this fails
  // rather than letting the surface quietly disagree with the database.
  assert.deepEqual([...ACTION_ELIGIBLE_DECISION_STATUSES].sort(), ["accepted", "modified"]);
  const { journey } = one("modifiedCarriesWork");
  assert.equal(journey.phase, "do");
  assert.equal(journey.closure, "open");
});

// ── B. Legitimate no-action closure ──────────────────────────────────────────

test("B1 — a rejected decision is CLOSED, not missing work", () => {
  const { entry, journey } = one("rejectedNoAction");
  assert.equal(journey.closure, "no_action_expected");
  assert.equal(journey.phase, "decide");
  assert.equal(journey.next, null, "a closed loop must not demand a next step");

  // DO / VERIFY / LEARN are NOT "upcoming" — they will never happen.
  assert.equal(journey.marks.decide, "complete");
  for (const phase of ["do", "verify", "learn"]) {
    assert.equal(journey.marks[phase], "not_expected", `${phase} must be not_expected`);
  }

  // It is not filed as unfinished work.
  assert.equal(entry.progress.inProgress.length, 0);
  assert.deepEqual(entry.progress.closed, ["dec-rejected"]);

  // And it is never described as broken.
  const text = entry.queue.text.toLowerCase();
  for (const word of ["missing", "stalled", "blocked", "failed", "overdue"]) {
    assert.ok(!text.includes(word), `rejected decision must not be called "${word}"`);
  }
});

test("B1b — an accepted decision with no action asks for one, and does not report a defect", () => {
  const { entry, journey } = one("acceptedNoActionYet");
  assert.equal(journey.phase, "do");
  assert.equal(journey.closure, "open");
  assert.match(journey.state, /No action has been requested/i);
  assert.ok(journey.next, "the PM's real next move must be stated");
  const text = entry.queue.text.toLowerCase();
  assert.ok(!text.includes("missing"), 'an unrequested action must not be called "missing"');
});

// ── C. DO ────────────────────────────────────────────────────────────────────

test("C1/C2/C3 — work that exists but has not finished is DO", () => {
  for (const key of ["actionNoTask", "executionRunning", "executionBlocked", "modifiedCarriesWork"]) {
    const { journey } = one(key);
    assert.equal(journey.phase, "do", `${key} should be DO`);
    assert.equal(journey.marks.do, "current");
    assert.equal(journey.marks.decide, "complete");
    assert.equal(journey.marks.verify, "upcoming");
    assert.equal(journey.marks.learn, "upcoming");
  }
});

test("C3b — a blocked execution is named as blocked, from the persisted status", () => {
  const { journey } = one("executionBlocked");
  assert.match(journey.state, /blocked/i);
  // And the next step acknowledges it rather than saying "start" as if nothing happened.
  assert.match(journey.next, /blocker/i);
});

test("C4 — owner is rendered only from a persisted actor, and never invented", () => {
  const mine = one("executionRunning");
  assert.equal(mine.journey.owner.isYou, true);
  assert.match(mine.entry.queue.text, /Owned by you/);

  const theirs = one("ownedByAnother");
  assert.equal(theirs.journey.owner.isYou, false);
  assert.match(theirs.entry.queue.text, /Owned by another workspace member/);

  // No fabricated placeholder anywhere in the section, and no raw actor id leaked as a name.
  for (const entry of harness.results) {
    assert.ok(!/Owner:?\s*Unknown/i.test(entry.queue.text), `${entry.key} shows a fabricated owner`);
    assert.ok(!entry.queue.text.includes("actor-colleague"), `${entry.key} leaks a raw actor id`);
  }
});

test("C4b — a decision with no rationale omits the Why line rather than filling it in", () => {
  const { entry } = one("noRationale");
  assert.ok(!entry.queue.markup.includes('data-testid="cc-journey-why"'), "Why must be absent");
  // The rest of the card still renders.
  assert.ok(entry.queue.markup.includes('data-testid="cc-journey-state"'));
});

test("C5 — several branches on one decision do not collapse to the first row", () => {
  const { entry, journey } = one("multiBranchOneAchievedOneRunning");
  assert.equal(journey.branches.length, 2, "both canonical actions must be projected");
  assert.deepEqual(journey.branches.map((branch) => branch.phase).sort(), ["do", "learn"]);
  // The card says there is more than one.
  assert.match(entry.queue.text, /2 separate actions follow this decision/);
  // And the drawer states each one on its own.
  assert.match(entry.drawer.markup, /data-testid="cc-drawer-journey-branches"/);
});

// ── C5c. The conservative rollup ─────────────────────────────────────────────

test("C5c — one finished branch never closes a decision with work still running", () => {
  const { entry, journey } = one("multiBranchOneAchievedOneRunning");
  assert.equal(journey.phase, "do", "the least advanced live branch decides the phase");
  assert.equal(journey.closure, "open");
  assert.notEqual(journey.marks.learn, "complete");

  // The most damaging version of this bug is not a wrong phase but a wrong RESULT: branch A
  // is achieved, so a surface that reads the first observed branch would announce success
  // while branch B is still running.
  assert.equal(journey.result, null, "no chain-level result while a branch is still running");
  assert.equal(journey.learning, null);
  assert.ok(
    !/expected result was achieved/i.test(entry.queue.text),
    "the card must not claim a result while work continues",
  );

  // It is genuinely still listed as work under way.
  assert.deepEqual(entry.progress.inProgress, ["dec-multi"]);
});

test("C5d — the loop closes only once every branch has been observed", () => {
  const { journey } = one("multiBranchAllObserved");
  assert.equal(journey.closure, "loop_closed");
  for (const phase of JOURNEY_PHASES) assert.equal(journey.marks[phase], "complete");
  // Two branches had DIFFERENT results, so no single chain-level result is stated.
  assert.equal(journey.result, null, "differing branch results must not be generalised");
  assert.deepEqual(journey.branches.map((branch) => branch.result).filter(Boolean).length, 2);
});

// ── D. VERIFY ────────────────────────────────────────────────────────────────

test("D1 — work complete with no expected outcome is VERIFY, and says so plainly", () => {
  const { entry, journey } = one("completeNoOutcome");
  assert.equal(journey.phase, "verify");
  assert.equal(journey.marks.do, "complete");
  assert.equal(journey.marks.verify, "current");
  assert.equal(journey.marks.learn, "upcoming");
  assert.match(journey.state, /work is complete/i);
  assert.ok(journey.next, "VERIFY must name the real next step");
  // It must stop describing finished work as merely in progress.
  assert.ok(!/is under way/i.test(entry.queue.text));
});

/**
 * THE discriminating regression.
 *
 * `ensure_canonical_expected_outcome` inserts state `expected`; only
 * `record_canonical_outcome_observation` moves it. So an Outcome ROW existing means the
 * expectation was recorded, NOT that anyone knows how it went. A surface that maps
 * "Outcome exists" to LEARN tells the PM the result is in while the database says nothing
 * has been established.
 */
test("D2 — an Outcome in state `expected` is still VERIFY, never LEARN", () => {
  const { entry, journey } = one("outcomeExpectedNoObservation");
  assert.equal(journey.phase, "verify", "an unobserved Outcome is not a result");
  assert.equal(journey.marks.learn, "upcoming");
  assert.equal(journey.result, null, "no result may be stated");
  assert.equal(journey.learning, null, "no learning may be stated");
  assert.match(journey.state, /result has not been established/i);

  // The card must not imply success, failure, or that anything was learned.
  const text = entry.queue.text.toLowerCase();
  for (const phrase of ["achieved", "what we learned", "success"]) {
    assert.ok(!text.includes(phrase), `an expected Outcome must not mention "${phrase}"`);
  }
  assert.deepEqual([...RESULT_PENDING_OUTCOME_STATES].sort(), ["expected", "observing"]);
});

test("D3 — completing work never becomes a claim of success", () => {
  for (const key of ["completeNoOutcome", "outcomeExpectedNoObservation"]) {
    const { entry, journey } = one(key);
    assert.equal(journey.result, null);
    assert.ok(!/succeed|successful/i.test(entry.queue.text), `${key} implies success`);
  }
});

// ── E. LEARN ─────────────────────────────────────────────────────────────────

test("E1/E2 — an observed Outcome carries BOTH the result and the observation's own words", () => {
  const { entry, journey } = one("outcomeAchievedObserved");
  assert.equal(journey.phase, "learn");
  assert.equal(journey.closure, "loop_closed");
  assert.match(journey.result, /achieved/i);
  assert.equal(journey.learning, "Queue contention was the real bottleneck.");
  // Both are rendered in the drawer, under headings a PM would use.
  assert.match(entry.drawer.markup, /data-testid="cc-drawer-journey-result"/);
  assert.match(entry.drawer.markup, /data-testid="cc-drawer-journey-learning"/);
  assert.match(entry.drawer.text, /What we learned Queue contention was the real bottleneck\./);
});

test("E3 — learning is the Observation's summary, never the Outcome's expected result", () => {
  const { entry } = one("outcomeAchievedObserved");
  // The Outcome's `expected_result` text must not be presented as what was learned.
  assert.ok(
    !/What we learned Change request reviewed/i.test(entry.drawer.text),
    "the expected result must never be relabelled as learning",
  );
});

// ── F. Result truth — the model's real vocabulary ────────────────────────────

test("F — achieved, not achieved and inconclusive stay three different answers", () => {
  const achieved = one("outcomeAchievedObserved").journey;
  const failed = one("outcomeNotAchieved").journey;
  const inconclusive = one("outcomeInconclusive").journey;

  assert.match(achieved.result, /was achieved/i);
  assert.match(failed.result, /was not achieved/i);
  assert.match(inconclusive.result, /inconclusive/i);
  assert.equal(new Set([achieved.result, failed.result, inconclusive.result]).size, 3);

  // A recorded negative result is a CLOSED loop, not unfinished work and not a system fault.
  for (const key of ["outcomeNotAchieved", "outcomeInconclusive"]) {
    const { entry, journey } = one(key);
    assert.equal(journey.closure, "loop_closed");
    assert.deepEqual(entry.progress.inProgress, [], `${key} must not be listed as in progress`);
    assert.ok(entry.progress.closed.length === 1, `${key} belongs with the closed chains`);
    assert.ok(!/error|fault|broken/i.test(entry.queue.text), `${key} reads as a system failure`);
  }
});

test("F2 — a superseded Outcome is stopped, and is not blamed on authorisation", () => {
  const { entry, journey } = one("outcomeSuperseded");
  assert.equal(journey.closure, "stopped");
  assert.equal(journey.next, null, "the contract defines no operation that continues it");
  assert.match(journey.state, /superseded/i);
  assert.ok(!/expired|not authorised|not authorized/i.test(entry.queue.text));
  assert.deepEqual([...UNOBSERVABLE_OUTCOME_STATES], ["superseded"]);
});

test("W4-R9 — a stopped journey implies no future progress, and claims no success", () => {
  const { entry, journey } = one("outcomeSuperseded");
  assert.equal(journey.closure, "stopped");
  assert.equal(journey.next, null);

  // A phase the contract forecloses must not read as pending. `marksFor` used to fall
  // through to the ordinary case here, so the indicator said "Verify: current step,
  // Learn: not started" on a journey with no next step at all.
  for (const phase of JOURNEY_PHASES) {
    assert.notEqual(journey.marks[phase], "current", `${phase} cannot be current on a stopped journey`);
    assert.notEqual(journey.marks[phase], "upcoming", `${phase} cannot be upcoming on a stopped journey`);
  }

  // Nor may it be dressed up as success: the work was superseded, so the phase it stopped
  // in and everything after it is `not_expected`, while the phases that really happened
  // stay `complete`. DECIDE is complete because a Decision is what made any of this exist.
  assert.equal(journey.marks.decide, "complete");
  assert.equal(journey.marks.do, "complete", "the work did finish before it was superseded");
  assert.equal(journey.marks.verify, "not_expected");
  assert.equal(journey.marks.learn, "not_expected");
  assert.equal(journey.result, null, "a superseded branch established no result");
  assert.equal(journey.learning, null);

  // The screen reader hears the same thing the styling shows.
  assert.match(entry.queue.text, /Verify: not expected/);
  assert.match(entry.queue.text, /Learn: not expected/);
  assert.ok(!/Verify: current step/.test(entry.queue.text));
  assert.ok(!/Learn: not started/.test(entry.queue.text));
  assert.ok(!/Learn: done/.test(entry.queue.text), "a stopped journey never closed its loop");
  assert.ok(!/aria-current="step"/.test(entry.queue.markup), "nothing is the current step");
});

// ── G. Authorization ─────────────────────────────────────────────────────────

test("G1 — a viewer who is not the proposer is never offered a step the server would refuse", () => {
  const { entry, journey } = one("readOnlyViewer");
  // They still see the real state.
  assert.ok(journey.state.length > 0);
  assert.equal(journey.phase, "do");
  // `offeredExecutionCommands` withholds new-work commands from a non-proposer, exactly as
  // `p2_08_validate_execution_governance` does, so the surface must not tell them to start.
  assert.ok(!/^Start the work/i.test(journey.next ?? ""), "must not offer a refused command");
  assert.match(journey.next, /cannot be advanced by you/i);
  assert.equal(journey.owner.isYou, false);
  // And the RENDERED card says the same thing — the refusal is not merely in the model.
  assert.match(entry.queue.text, /cannot be advanced by you/i);
  assert.ok(!/\bStart the work\b/.test(entry.queue.text), "the card must not offer a refused step");
});

test("G3 — eligibility is read from the projection, never re-derived from a role name", () => {
  const source = read("src/modules/workspace/presentation/command-center/decision-journey.ts");
  // The derivation must reach its verdict through `offeredCommands`, which the read model
  // computes against the server's own gates.
  assert.match(source, /offeredCommands/);
  // And must not invent authority from a role string.
  assert.ok(!/role\s*===\s*["'](owner|admin|manager|sponsor)/.test(source), "role-name authority");
});

// ── I. Exact-reference completeness, and the execution ROOT ──────────────────

test("I1 — a running chain outside the recent decision window is still found", () => {
  const scenario = roots.falseClear;
  // The window genuinely excludes it — otherwise this test proves nothing.
  assert.equal(scenario.windowDecisionIds.length, 30);
  assert.ok(
    !scenario.windowDecisionIds.includes("dec-old"),
    "fixture is not discriminating: the working decision is inside the window",
  );
  // The execution root recovered it by canonical reference.
  assert.deepEqual(scenario.rootDecisionIds, ["dec-old"]);
  assert.ok(scenario.chainDecisionIds.includes("dec-old"));
  // And it is reported as work under way, not as an empty section.
  assert.deepEqual(scenario.inProgressDecisionIds, ["dec-old"]);
  const journey = scenario.journeys.find((entry) => entry.decisionId === "dec-old");
  assert.equal(journey.phase, "do");
  assert.match(scenario.queue.text, /work is under way/i);
});

test("I2 — an unobserved Outcome outside the window reports VERIFY, not a false absence", () => {
  const scenario = roots.pendingResult;
  assert.ok(!scenario.windowDecisionIds.includes("dec-old"));
  const journey = scenario.journeys.find((entry) => entry.decisionId === "dec-old");
  assert.equal(journey.phase, "verify");
  assert.match(journey.state, /result has not been established/i);
});

test("I3 — the root proves its own completeness, and overflow is UNPROVEN not truncated", () => {
  assert.equal(roots.falseClear.rootComplete, true);
  assert.equal(roots.pendingResult.rootComplete, true);
  // More open chains than the ceiling: the honest answer is that this is not the whole set.
  assert.equal(roots.ceilingOverflow.rootComplete, false);
});

test("I4 — an unproven section withholds its count and its empty-state claim", () => {
  // Known items are still shown; what is withheld is the claim that they are all of them.
  const overflow = roots.ceilingOverflow;
  assert.ok(overflow.inProgressDecisionIds.length > 0, "known work must still be listed");
  assert.match(overflow.queue.text, /may not be complete/i);

  const { provenEmpty, unprovenEmpty } = harness.emptyStates;
  assert.match(provenEmpty.text, /Nothing is in progress yet/);
  assert.ok(
    !/Nothing is in progress yet/.test(unprovenEmpty.text),
    'an unproven read must never claim "Nothing is in progress yet."',
  );
  assert.match(unprovenEmpty.text, /cannot confirm/i);
});

// ── O. The authoritative execution root ──────────────────────────────────────
//
// The root and the presentation model must describe the SAME universe. Every canonical
// state `deriveDecisionJourney` calls `closure === "open"` must be discoverable by the
// server-side membership predicate even when its Decision is older than every history
// window — otherwise the surface silently loses a journey it would have called open.

test("W4-R10 — one terminal branch cannot close a sibling that is still open", () => {
  /*
   * BLOCKER 05, counterexample A. A Decision fans out; branch A1 finished and was
   * superseded, branch A2's authorisation lapsed before any work was created.
   *
   * Nothing is progressing, so the classifier reached its terminal readings — and those
   * asked `some(superseded)`, which one branch satisfied on its own. The whole Decision was
   * filed under "Closed" while `deriveDecisionJourney` said `open` and the server-side root
   * named it as open work. "Closed" is a claim about the CHAIN, so it needs every branch.
   */
  const { entry, journey } = one("multiBranchSupersededPlusExpired");
  assert.equal(journey.branches.length, 2, "the fixture must actually fan out");
  assert.equal(journey.closure, "open");
  assert.deepEqual(entry.serverOpenDecisionIds, [journey.decisionId], "the server names it open");

  // One branch superseded, one branch open with no Task.
  const stopped = journey.branches.filter((branch) => branch.stopped);
  assert.equal(stopped.length, 1, "exactly one branch is canonically stopped");
  const open = journey.branches.find((branch) => !branch.stopped);
  assert.match(open.state, /expired/i, "the open branch is blocked on a lapsed authorisation");
  assert.match(open.next, /fresh authorisation/i, "and its next move is the PM's");

  assert.deepEqual(entry.progress.closed, [], "a chain with an open branch is not closed");
  assert.deepEqual(entry.progress.inProgress, [], "and nothing is advancing on its own");
  assert.deepEqual(entry.progress.notProgressing, [journey.decisionId]);
});

test("W4-R11 — an OBSERVED branch cannot close a sibling that is still open either", () => {
  /*
   * BLOCKER 05, counterexample B. Same shape, but branch A1 is terminal by the other route:
   * completed, resolved Outcome, real Observation. The old `some(isResultEstablished)`
   * closed the chain on it. An observed result is no more entitled to close a Decision than
   * a superseded branch is.
   */
  const { entry, journey } = one("multiBranchObservedPlusExpired");
  assert.equal(journey.branches.length, 2);
  assert.equal(journey.closure, "open");
  assert.deepEqual(entry.serverOpenDecisionIds, [journey.decisionId]);

  // The finished branch really is finished — otherwise this would pass for the wrong reason.
  const observed = journey.branches.find((branch) => branch.learningProven);
  assert.ok(observed, "one branch must be genuinely learning-proven");
  assert.notEqual(observed.result, null);
  assert.equal(observed.learning, "Branch A landed as expected.");

  assert.deepEqual(entry.progress.closed, []);
  assert.deepEqual(entry.progress.inProgress, []);
  assert.deepEqual(entry.progress.notProgressing, [journey.decisionId]);
});

test("W4-R12 — the whole-chain terminal rule, and the controls that keep it honest", () => {
  /*
   * `closed` requires EVERY branch to be terminal, by exactly two routes: learning-proven,
   * or canonically stopped. Without these controls the fix above could simply be "never
   * close a multi-branch chain", which is a different lie told to the same PM.
   */
  const expected = {
    // Mixed terminal + open: open, and nothing is advancing.
    multiBranchSupersededPlusExpired: "not_progressing",
    multiBranchObservedPlusExpired: "not_progressing",
    // A result whose Observation cannot be resolved is not terminal either.
    multiBranchPartialPlusSuperseded: "not_progressing",
    // Every branch terminal, by each route and by both at once.
    multiBranchAllSuperseded: "closed",
    multiBranchObservedPlusSuperseded: "closed",
    multiBranchAllObserved: "closed",
    // Liveness still wins over any terminal sibling.
    multiBranchRunningPlusSuperseded: "in_progress",
    multiBranchOneAchievedOneRunning: "in_progress",
    // Single-branch behaviour is unchanged.
    outcomeSuperseded: "closed",
    outcomeAchievedObserved: "closed",
    outcomeNotAchieved: "closed",
    partialChainMissingObservation: "not_progressing",
    rejectedNoAction: "closed",
    acceptedNoActionYet: "not_progressing",
  };
  for (const [key, group] of Object.entries(expected)) {
    const { entry } = one(key);
    assert.equal(entry.chainProgress.length, 1, `${key} should produce exactly one chain`);
    assert.equal(entry.chainProgress[0].group, group, `${key} must classify as ${group}`);
  }

  /*
   * The rule is `every`, not `some`, and it is the ONLY route to "closed" for a Decision
   * that can carry work.
   *
   * The behaviour above already fails if either terminal reading returns as a `some(...)`,
   * but that would be a silent structural regression the scenarios only catch by luck of
   * coverage. So the shape is pinned too: exactly one `some` over branches (liveness),
   * exactly one `every` (terminal), and exactly two ways to reach "closed" — a Decision
   * that cannot carry work at all, and a chain whose every branch has ended.
   */
  const source = read("src/modules/workspace/presentation/command-center/in-progress-read-model.ts");
  assert.equal((source.match(/chain\.branches\.some\(/g) ?? []).length, 1, "one liveness check");
  assert.match(source, /chain\.branches\.some\(isBranchProgressing\)/);
  assert.equal((source.match(/chain\.branches\.every\(/g) ?? []).length, 1, "one terminal check");
  assert.match(source, /chain\.branches\.every\(isBranchTerminal\)/);
  assert.equal((source.match(/return "closed"/g) ?? []).length, 2, "exactly two routes to closed");
});

test("the progress grouping cannot disagree with journey closure", () => {
  /*
   * The second half of the architecture proof.
   *
   * The first half pins the SERVER's open set to the derivation's open set. This pins the
   * GROUPING to the same derivation, so all three descriptions of a chain — what the
   * database offers as open work, what the journey calls the chain, and which heading the
   * PM reads it under — cannot drift apart:
   *
   *     closure open   + something progressing  -> in_progress
   *     closure open   + nothing progressing    -> not_progressing
   *     closure closed (loop_closed / stopped / no_action_expected) -> closed
   *
   * Run over the real derivation and the real classifier across the whole fixture matrix,
   * not asserted about the source.
   */
  const TERMINAL_CLOSURES = ["loop_closed", "stopped", "no_action_expected"];
  let openChains = 0;
  let terminalChains = 0;
  let mixedMultiBranch = 0;

  for (const entry of harness.results) {
    for (const chain of entry.chainProgress) {
      if (TERMINAL_CLOSURES.includes(chain.closure)) {
        terminalChains += 1;
        assert.equal(
          chain.group,
          "closed",
          `${entry.key}/${chain.decisionId}: closure ${chain.closure} must group as closed`,
        );
        continue;
      }
      assert.equal(chain.closure, "open", `${entry.key}: unexpected closure ${chain.closure}`);
      openChains += 1;
      // An open chain is never closed, whatever else is true of it.
      assert.notEqual(
        chain.group,
        "closed",
        `${entry.key}/${chain.decisionId}: an OPEN journey must never be grouped as closed`,
      );
      // ...and which of the two open groups it lands in is decided by liveness alone.
      const progressing = entry.progress.inProgress.includes(chain.decisionId);
      assert.equal(chain.group, progressing ? "in_progress" : "not_progressing");
      if (chain.branchCount > 1 && !progressing) mixedMultiBranch += 1;
    }
  }

  // The matrix must actually contain both sides, or the equalities above are vacuous.
  assert.ok(openChains >= 12, "the fixture set must exercise many open chains");
  assert.ok(terminalChains >= 6, "the fixture set must exercise many terminal chains");
  assert.ok(
    mixedMultiBranch >= 2,
    "the fixture set must include multi-branch chains that are open and not progressing",
  );
});

test("the authoritative root and the presentation model describe the SAME universe", () => {
  /*
   * The architecture audit, as an assertion rather than a claim.
   *
   * `deriveDecisionJourney` decides `closure === "open"` from canonical rows. The server
   * decides membership of the execution root from the same rows, in SQL. If the two ever
   * disagree, a journey the surface calls open is one the root does not offer it — and the
   * Decision vanishes the moment it falls out of every recent-history window. That is
   * exactly how an accepted Decision with no Action, and completed work with no Outcome,
   * were both lost.
   *
   * So every canonical scenario in the fixture set is checked BOTH ways, and the two sets
   * must be equal. A new open state added to the derivation without a matching predicate
   * in the migration fails here rather than in production.
   */
  let openStatesCovered = 0;
  for (const entry of harness.results) {
    assert.deepEqual(
      [...entry.serverOpenDecisionIds].sort(),
      [...entry.journeyOpenDecisionIds].sort(),
      `${entry.key}: the server root and the journey model disagree about what is open`,
    );
    if (entry.journeyOpenDecisionIds.length > 0) openStatesCovered += 1;
  }
  // The fixture set must actually contain open journeys, or the equality above is vacuous.
  assert.ok(openStatesCovered >= 10, "the scenario set must exercise many open journeys");

  // And it must contain the CLOSED ones too, or "everything is open" would also pass.
  const closedKeys = ["rejectedNoAction", "outcomeAchievedObserved", "outcomeSuperseded", "multiBranchAllObserved"];
  for (const key of closedKeys) {
    const entry = harness.results.find((candidate) => candidate.key === key);
    assert.deepEqual(entry.serverOpenDecisionIds, [], `${key} must not be named as open work`);
    assert.deepEqual(entry.journeyOpenDecisionIds, [], `${key} must not be named as open work`);
  }

  /*
   * The one journey that is deliberately NOT part of the recurring In Progress root, stated
   * explicitly: a journey the contract forecloses or has closed is unreachable from the
   * root by design, and stays reachable through `decisions` — the newest-30 recent-history
   * window — and through the drawer the post-decision handoff opens. That distinction is
   * what keeps "In Progress" a truthful heading without losing anything.
   */
  const superseded = harness.results.find((entry) => entry.key === "outcomeSuperseded");
  assert.equal(superseded.chainCount, 1, "a stopped chain is still projected and reachable");
  assert.deepEqual(superseded.progress.closed, ["dec-super"]);
});

test("W4-R1 — an accepted decision with NO action, outside the window, is still reachable", () => {
  const scenario = roots.acceptedNoAction;
  // The fixture is only discriminating if the window really cannot reach it.
  assert.equal(scenario.windowDecisionIds.length, 30);
  assert.ok(!scenario.windowDecisionIds.includes("dec-bare"), "fixture is inside the window");

  // Nothing beneath it is work-shaped: no Action, no Task, no Execution, no Outcome. The
  // three-predicate root saw literally nothing here and the Decision disappeared.
  assert.deepEqual(scenario.frozenMembershipIds, ["dec-bare"]);
  assert.ok(scenario.rootDecisionIds.includes("dec-bare"));
  assert.ok(scenario.chainDecisionIds.includes("dec-bare"));

  const journey = scenario.journeys.find((entry) => entry.decisionId === "dec-bare");
  assert.equal(journey.phase, "do");
  assert.equal(journey.closure, "open");
  assert.match(journey.next, /Request the action/i);

  // A decision is not work, so it is not counted as progress — but it is on the surface,
  // un-collapsed, because requesting the first Action is the PM's move.
  assert.ok(scenario.notProgressingDecisionIds.includes("dec-bare"));
  assert.match(scenario.queue.text, /No action has been requested from it yet/i);
  assert.equal(scenario.rootComplete, true);
});

test("W4-R2 — completed work with no Outcome and a lapsed authorisation is still reachable", () => {
  const scenario = roots.completedNoOutcome;
  assert.ok(!scenario.windowDecisionIds.includes("dec-verify"), "fixture is inside the window");

  // Every predicate of the discarded root misses this: the Execution is `completed`, no
  // Outcome exists, and `expires_at` is in the past.
  assert.deepEqual(scenario.frozenMembershipIds, ["dec-verify"]);
  assert.ok(scenario.rootDecisionIds.includes("dec-verify"));

  const journey = scenario.journeys.find((entry) => entry.decisionId === "dec-verify");
  assert.equal(journey.phase, "verify");
  assert.equal(journey.closure, "open");
  assert.match(journey.state, /has not been recorded yet/i);
  assert.equal(scenario.rootComplete, true);
});

test("W4-R3 — a transition committing between two statements cannot empty the root", () => {
  const { interleaved, interleavedLateSnapshot, consistent } = mvcc;

  // The Decision is outside the history window, so the root is the only way to it.
  assert.ok(!interleaved.windowDecisionIds.includes("dec-mvcc"));

  // The DISCARDED proof, evaluated over the same interleave: pending Outcomes read before
  // the completion commits, active Executions after it, the Action already expired. All
  // three come back empty, and every one is far below its ceiling — so the old code would
  // have reported this answer COMPLETE while having lost the chain entirely.
  assert.deepEqual(interleaved.legacyThreeStatementRoot.decisionIds, []);
  assert.equal(interleaved.legacyThreeStatementRoot.withinCeiling, true);

  // And it is the INTERLEAVE, not the fixture: read from one world the same three
  // predicates find it. Without this the test above would pass on unreachable data.
  assert.deepEqual(consistent.legacyThreeStatementRoot.decisionIds, ["dec-mvcc"]);

  // One statement is one snapshot, and the Decision is open on BOTH sides of the commit,
  // so the membership names it whichever instant the projection was taken at.
  for (const scenario of [interleaved, interleavedLateSnapshot, consistent]) {
    assert.deepEqual(scenario.frozenMembershipIds, ["dec-mvcc"]);
    assert.equal(scenario.recovered, true, "the journey must survive the interleave");
    assert.equal(scenario.journey.closure, "open");
    assert.equal(scenario.rootComplete, true);
  }
});

test("W4-R4 — no membership projection means UNPROVEN, never complete", () => {
  // A database that has not applied the W4 migration. PostgREST answers an unknown function
  // with an error, and the read must degrade to "we cannot confirm" — not to a failed page,
  // and under no circumstances to "complete".
  const scenario = roots.membershipAbsent;
  assert.equal(scenario.rootComplete, false);
  assert.match(scenario.queue.text, /may not be complete/i);
  // The window is still read and still rendered: what is withheld is the CLAIM.
  assert.equal(scenario.windowDecisionIds.length, 30);
  assert.ok(scenario.chainDecisionIds.length > 0, "known chains must still be shown");
});

test("W4-R5 — a frozen member that cannot be resolved makes the answer incomplete", () => {
  const scenario = roots.memberUnresolvable;
  assert.equal(scenario.rootComplete, false);
  assert.deepEqual(scenario.rootDecisionIds, [], "an unresolvable member cannot be invented");
  assert.match(scenario.queue.text, /may not be complete/i);
});

test("W4-R6 — a late nonmember cannot substitute for a missing frozen member", () => {
  const scenario = roots.lateNonmember;
  // The snapshot named one member; a DIFFERENT open Decision, newer than the projection,
  // is sitting at the top of the window. Cardinality would balance. Identity does not.
  assert.equal(scenario.rootComplete, false);
  assert.ok(
    !scenario.rootDecisionIds.includes("dec-late"),
    "a Decision the snapshot never named must not enter the authoritative root",
  );
  assert.deepEqual(scenario.rootDecisionIds, []);
});

test("a transport duplicate is deduped by canonical id and never pads the proof", () => {
  const scenario = roots.duplicateMember;
  // Two copies of one id against a count of two. Deduping collapses them to one member,
  // which then disagrees with the count the same statement produced — so nothing is proven.
  assert.equal(scenario.rootComplete, false);
  assert.deepEqual(scenario.rootDecisionIds, ["dec-old"], "one canonical id, listed once");
});

test("the membership projection is one statement, security invoker, and pins its search_path", () => {
  const migration = read(
    "supabase/migrations/20260909000000_ux_w4_governed_execution_root_membership.sql",
  );
  assert.match(migration, /create or replace function public\.get_governed_execution_root\(p_workspace_id uuid, p_project_id uuid\)/);
  assert.match(migration, /stable security invoker set search_path = public/);
  // Authorization is the existing check, not a reimplementation of it.
  assert.match(migration, /if not public\.can_access_operational_project\(p_workspace_id, p_project_id\) then/);
  assert.ok(!/role\s*=\s*'(owner|admin|manager|sponsor)'/.test(migration), "no role-name authority");
  /*
   * ONE statement, and one scan inside it: `count(*)` and `jsonb_agg(...)` are aggregates
   * over the SAME derived table, so the count and the membership cannot come from
   * different snapshots — or from different predicates.
   */
  assert.equal((migration.match(/\binto result\b/g) ?? []).length, 1, "exactly one statement");
  assert.match(migration, /'openExecutionDecisions', count\(\*\)/);
  assert.match(migration, /coalesce\(jsonb_agg\(open_journeys\.id order by/);
  assert.match(migration, /\) as open_journeys;/);
  assert.match(migration, /'openExecutionDecisionIds'/);
  assert.match(migration, /'openExecutionDecisions'/);
  // The id set is NOT capped in SQL; the ceiling belongs to the consumer, where exceeding
  // it means UNPROVEN rather than a truncated set presented as authoritative.
  assert.ok(
    !/jsonb_agg[\s\S]{0,200}limit\s+\d/.test(migration),
    "a silent SQL cap would truncate authoritative membership",
  );
  // Read-only projection, forward-only, no policy or write semantics.
  for (const forbidden of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i, /\bdrop\s+/i, /create\s+policy/i, /alter\s+policy/i]) {
    assert.ok(!forbidden.test(migration), `migration must not ${forbidden}`);
  }
  assert.match(migration, /revoke all on function public\.get_governed_execution_root\(uuid, uuid\) from public;/);
  assert.match(migration, /grant execute on function public\.get_governed_execution_root\(uuid, uuid\) to authenticated;/);
});

test("the root is asked as ONE statement, and its absence is never fatal", () => {
  const source = read("src/lib/operational-flow/operational-flow-service.ts");
  // Exactly one membership call, and the three discarded root reads are gone.
  assert.equal((source.match(/client\.rpc\("get_governed_execution_root"/g) ?? []).length, 1);
  assert.ok(!source.includes("EXECUTION_ROOT_CEILING"), "the three-statement root must be gone");
  assert.ok(!source.includes("activeExecutionRoots"), "the three-statement root must be gone");
  assert.ok(!source.includes("pendingOutcomeRoots"), "the three-statement root must be gone");
  assert.ok(!source.includes("openActionRoots"), "the three-statement root must be gone");
  // The membership RPC must NOT be in the list of reads that throw: an older database has
  // to degrade to UNPROVEN rather than failing the whole page.
  assert.ok(
    !/executionRootResult\.error\)\s*throw/.test(source),
    "an absent projection must be UNPROVEN, not fatal",
  );
});

// ── L. Partial chains ────────────────────────────────────────────────────────

test("L — an unresolvable linked record keeps the known facts and claims no completion", () => {
  const { entry, journey } = one("partialChainMissingObservation");

  // P2-09 moves an Outcome off `expected` only through an Observation, so a resolved state
  // with NO Observation is a data-integrity anomaly. The honest reading splits the two
  // facts rather than discarding both: the database states the result, so the result is
  // shown; nothing recorded the learning, so no learning is claimed.
  assert.equal(journey.result, "The expected result was achieved.", "a persisted result is still a result");
  assert.equal(journey.learning, null, "learning must never be invented from the result");

  // The anomaly is named rather than hidden.
  assert.equal(journey.partial, true);
  assert.match(journey.partialReason, /observation behind it cannot be resolved/i);
  assert.match(entry.queue.markup, /data-testid="cc-journey-partial"/);

  // And the grouping agrees with the journey: the work has ended, so it is not listed as
  // still under way. The earlier cut forced this back into "In Progress", which told the
  // PM work was continuing when it had finished — a worse error than the one it prevented.
  assert.deepEqual(entry.progress.inProgress, [], "finished work must not be shown as in progress");
});

test("W4-R7 — a result without its observation is unresolved, and is never called loop_closed", () => {
  const { entry, journey } = one("partialChainMissingObservation");

  // The truthful reading of these rows, field by field:
  //   result known · work not running · learning NOT proven · chain NOT complete
  assert.notEqual(journey.result, null, "the database states the result");
  assert.equal(journey.learning, null, "nothing recorded what was learned");
  assert.equal(journey.partial, true);

  // The contradiction this fixes: the journey used to report `loop_closed` with every
  // phase complete while `learning` was null and `partial` was true — four fields, and one
  // of them disagreeing with the other three.
  assert.notEqual(journey.closure, "loop_closed", "an unproven loop is not a closed one");
  assert.notEqual(journey.marks.learn, "complete", "LEARN cannot be done with nothing learned");

  // And a screen reader must not hear the claim either.
  assert.ok(
    !/Learn: done/.test(entry.queue.text),
    'the loop indicator must not announce "Learn: done" over a missing observation',
  );

  // Neither running nor closed. Finished work does NOT go back under "In Progress", and an
  // unproven loop does not get filed away as terminal.
  assert.deepEqual(entry.progress.inProgress, []);
  assert.deepEqual(entry.progress.closed, []);
  assert.deepEqual(entry.progress.notProgressing, [journey.decisionId]);
});

test("W4-R8 — control: a resolved Outcome WITH its Observation still closes the loop", () => {
  // Without this the fix above could have been "never close any loop", which would be a
  // different lie told to the same PM.
  const { entry, journey } = one("outcomeAchievedObserved");
  assert.equal(journey.closure, "loop_closed");
  assert.equal(journey.marks.learn, "complete");
  assert.equal(journey.learning, "Queue contention was the real bottleneck.");
  assert.notEqual(journey.result, null);
  assert.equal(journey.partial, false);
  assert.match(entry.queue.text, /Learn: done/);
  assert.deepEqual(entry.progress.closed, [journey.decisionId]);
  assert.deepEqual(entry.progress.notProgressing, []);
});

test("L2 — a resolved result with its observation present claims no anomaly", () => {
  // The control for L: same shape, Observation resolvable. Without this, L could pass
  // against a journey that flagged every observed chain as partial.
  const { journey } = one("outcomeAchievedObserved");
  assert.equal(journey.partial, false);
  assert.equal(journey.partialReason, null);
  assert.ok(journey.learning, "an observed chain carries its learning");
});

// ── M / N. One tree, and phase without colour ────────────────────────────────

test("N1 — every phase is announced in words, not by colour or a glyph alone", () => {
  const { entry } = one("executionRunning");
  const markup = entry.queue.markup;
  assert.match(markup, /data-testid="cc-journey-track"/);
  // Each phase carries a screen-reader sentence describing its state.
  for (const phase of JOURNEY_PHASES) {
    assert.match(markup, new RegExp(`data-testid="cc-journey-phase-${phase}"`));
  }
  assert.match(markup, /Decide: done/);
  assert.match(markup, /Do: current step/);
  assert.match(markup, /Verify: not started/);
  assert.match(markup, /Learn: not started/);
  // The current phase is also marked for assistive technology.
  assert.match(markup, /aria-current="step"/);
});

test("N2 — a foreclosed phase is announced as such, not as merely not started", () => {
  const { entry } = one("rejectedNoAction");
  assert.match(entry.queue.markup, /Do: not expected/);
  assert.ok(!/Do: not started/.test(entry.queue.markup));
});

test("N3 — the loop indicator is an ordered list, and never nested inside a button", () => {
  const { entry } = one("executionRunning");
  const markup = entry.queue.markup;
  assert.match(markup, /<ol[^>]*data-testid="cc-journey-track"/);
  // A <button> may not contain an <ol>. If the card ever wraps the whole row in a button
  // again this catches it, because the list would then be inside one.
  const buttons = markup.match(/<button[\s\S]*?<\/button>/g) ?? [];
  for (const button of buttons) {
    assert.ok(!button.includes("<ol"), "an ordered list may not be nested inside a button");
  }
});

test("M — the queue renders one tree, so no second divergent truth exists", () => {
  const source = read("src/modules/workspace/presentation/command-center/command-center-canvas.tsx");
  // One ExecutionQueue in the composition; the layout places it responsively rather than
  // rendering a separate mobile copy with its own props.
  assert.equal((source.match(/<ExecutionQueue/g) ?? []).length, 1);
});

// ── Customer language ────────────────────────────────────────────────────────

test("the card speaks the PM's language and keeps canonical vocabulary in the drawer", () => {
  const forbidden = [
    "Material Action",
    "GovernanceEvent",
    "Canonical Recommendation Root",
    "Execution boundary",
    "internal_task_executions",
    "canonical_task_outcomes",
  ];
  for (const entry of harness.results) {
    for (const term of forbidden) {
      assert.ok(
        !entry.queue.text.includes(term),
        `${entry.key}: "${term}" is canonical vocabulary and must not lead the card`,
      );
    }
  }
  // It remains reachable: the drawer still carries the canonical chain rows.
  const { entry } = one("executionRunning");
  assert.match(entry.drawer.text, /Decision/);
});

test("PMFreak never claims to recommend or expect anything the model does not hold", () => {
  for (const entry of harness.results) {
    assert.ok(
      !/PMFreak recommends/i.test(entry.queue.text),
      `${entry.key}: the execution card states facts, never advice`,
    );
    assert.ok(!/expects? this to succeed/i.test(entry.queue.text), `${entry.key}: predicts an outcome`);
  }
});

// ── Scope boundaries ─────────────────────────────────────────────────────────

test("W4 introduces no endpoint and no dependency, and exactly one read-only migration", () => {
  const journey = read("src/modules/workspace/presentation/command-center/decision-journey.ts");
  // The derivation is pure: no fetch, no client, no clock of its own.
  for (const term of ["fetch(", "createClient", "Date.now(", "new Date("]) {
    assert.ok(!journey.includes(term), `the derivation must stay pure, found: ${term}`);
  }
  // No new dependency.
  const pkg = JSON.parse(read("package.json"));
  assert.ok(!Object.keys(pkg.dependencies ?? {}).some((name) => /state-machine|xstate|timeline/i.test(name)));

  /*
   * W4 originally shipped with no migration at all, and that was the wrong constraint to
   * hold: authoritative membership cannot be assembled from independent statements. So
   * remediation adds ONE forward-only, read-only projection — and exactly one.
   *
   * Pinned by CONTENT rather than by a git range, so the assertion holds in a checkout
   * with no remote and cannot be satisfied by a second file quietly redefining the same
   * function later in the ordering.
   */
  const migrationDir = "supabase/migrations";
  const declaring = readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => read(`${migrationDir}/${name}`).includes("function public.get_governed_execution_root"));
  assert.deepEqual(declaring, ["20260909000000_ux_w4_governed_execution_root_membership.sql"]);

  // No new endpoint: the surface is still fed by the existing operational-flow route, and
  // the membership projection is reached through the data client like every other read.
  const service = read("src/lib/operational-flow/operational-flow-service.ts");
  assert.match(service, /client\.rpc\("get_governed_execution_root"/);
  assert.ok(!service.includes("/api/"), "the service must not reach a new endpoint");
});

test("the human phase is never persisted or sent to a write path", () => {
  const journey = read("src/modules/workspace/presentation/command-center/decision-journey.ts");
  const track = read("src/modules/workspace/presentation/command-center/journey-track.tsx");
  for (const source of [journey, track]) {
    assert.ok(!/\.from\(/.test(source), "presentation must not touch the data client");
    assert.ok(!/rpc\(/.test(source), "presentation must not call an RPC");
  }
});

test("W3's frozen contracts survive: attention stays the primary surface", () => {
  const canvas = read("src/modules/workspace/presentation/command-center/command-center-canvas.tsx");
  assert.match(canvas, /data-primary-surface="NEEDS_YOU"/);
  assert.match(canvas, /data-chat-role="COPILOT"/);
  // Needs You is still first in the document, ahead of In Progress.
  assert.ok(
    canvas.indexOf("<NeedsYouQueue") < canvas.indexOf("<ExecutionQueue"),
    "attention must remain ahead of execution in DOM order",
  );
});

test("the post-decision handoff follows persisted state, and only terminal decisions", () => {
  const layout = read("src/modules/workspace/screens/command-center/command-center-layout.tsx");
  // The chain is opened from the REFRESHED payload, not from the submission.
  assert.match(layout, /followDecidedRecommendationId/);
  assert.match(layout, /TERMINAL_DECISION_STATUSES\.includes/);
  // It is RESOLVED in `activeDrawer`, not copied into other state by an effect: the follow
  // id is a selector like `openChainId`, and converting one piece of state into another
  // after render is the cascading-render pattern React rejects.
  assert.match(layout, /entry\.recommendationId === followDecidedRecommendationId/);
  assert.ok(
    !/useEffect\([\s\S]{0,400}setOpenChainId\(/.test(layout),
    "the handoff must not setState inside an effect",
  );
});
