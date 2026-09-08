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
import { readFileSync } from "node:fs";
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

test("W4 introduces no migration, no endpoint and no dependency", () => {
  const journey = read("src/modules/workspace/presentation/command-center/decision-journey.ts");
  // The derivation is pure: no fetch, no client, no clock of its own.
  for (const term of ["fetch(", "createClient", "Date.now(", "new Date("]) {
    assert.ok(!journey.includes(term), `the derivation must stay pure, found: ${term}`);
  }
  // No new dependency, and no migration added by this wave.
  const pkg = JSON.parse(read("package.json"));
  assert.ok(!Object.keys(pkg.dependencies ?? {}).some((name) => /state-machine|xstate|timeline/i.test(name)));
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
