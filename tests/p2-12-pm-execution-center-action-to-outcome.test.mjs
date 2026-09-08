import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * P2-12 — PM Execution Center Action-to-Outcome and Accessibility Gate.
 *
 * The behavioural assertions below run the real P2-12 execution read model and the real Command
 * Center components (rendered through react-dom/server) via `tests/p2-12-execution-center-harness.tsx`.
 * Only assertions that depend on live browser interaction or on a module's dependency direction
 * fall back to reading source, and those are marked as such.
 *
 * P2-12 is integration: it must prove composition invariants, not re-prove P2-06/07/08/09/10.
 */

const runHarness = (file) =>
  JSON.parse(
    execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", file], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }).trim()
  );

const harness = runHarness("tests/p2-12-execution-center-harness.tsx");
/** Runs the REAL `getOperationalSummary` against a stubbed Data API — see the harness. */
const projection = runHarness("tests/p2-12-projection-completeness-harness.ts");
const submissionAttempt = readFileSync("src/modules/workspace/presentation/command-center/submission-attempt.ts", "utf8");

const readModel = readFileSync("src/modules/workspace/presentation/command-center/execution-read-model.ts", "utf8");
const panel = readFileSync("src/modules/workspace/presentation/command-center/execution-chain-panel.tsx", "utf8");
const operationalData = readFileSync("src/modules/workspace/presentation/command-center/operational-data.ts", "utf8");
const layout = readFileSync("src/modules/workspace/screens/command-center/command-center-layout.tsx", "utf8");
const service = readFileSync("src/lib/operational-flow/operational-flow-service.ts", "utf8");
const route = readFileSync("src/app/api/operational-flow/route.ts", "utf8");
const queueSource = readFileSync("src/modules/workspace/presentation/command-center/execution-queue.tsx", "utf8");

const text = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The text of the chain ROWS only, excluding the section's own heading.
 *
 * UX-W2 renamed this surface "In Progress" for the PM. That is a label for the region; it
 * is never a claim about any one chain, and the claims below are about the chains. Reading
 * the whole section would let the region's name answer a question only a chain's own status
 * may answer — so these assertions read the list, which is where a status is stated.
 */
const chainRows = (html) => {
  const start = html.indexOf("<ul");
  return start < 0 ? "" : text(html.slice(start));
};

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── A. Canonical contract fidelity ───────────────────────────────────────────

test("P2-12 A1: eligibility mirrors the server contracts and invents no status", () => {
  assert.deepEqual(harness.contract.actionEligibleStatuses, ["accepted", "modified"]);
  assert.deepEqual(harness.contract.taskEligibleGovernanceStates, ["authorized", "not_required"]);
  assert.deepEqual(harness.contract.executionCommands, ["queue", "start", "block", "fail", "retry", "complete"]);
});

test("P2-12 A2: chain identity derives from the canonical Decision, never minted", () => {
  assert.equal(harness.decidedOnly.id, "governed-chain-dec-1");
});

test("P2-12 A3: non-terminal Decisions authorize nothing downstream", () => {
  // An escalation leaves the Recommendation open; it is not a governed execution chain.
  assert.equal(harness.escalated.chains, 0);
});

// ── B. Decision != Action ────────────────────────────────────────────────────

test("P2-12 B1: a recorded Decision does not create a Material Action", () => {
  assert.equal(harness.decidedOnly.branches, 0);
  assert.equal(harness.decidedOnly.action, null);
  assert.equal(harness.decidedOnly.actionStage.state, "not_started");
  // The stage is offered, but nothing exists until the PM explicitly requests it.
  assert.equal(harness.decidedOnly.actionStage.actionable, true);
});

test("P2-12 B2: the Action stage states plainly that it neither executes nor creates a Task", () => {
  assert.match(harness.decidedOnly.actionStage.effect, /does not execute anything and does not create a Task/i);
});

test("P2-12 B3: a rejected Decision cannot acquire a Material Action", () => {
  assert.equal(harness.rejected.chains, 1, "rejected chains stay visible rather than being hidden");
  assert.equal(harness.rejected.actionStage.actionable, false);
  assert.match(harness.rejected.actionStage.blockedReason, /rejected Decision does not authorize/i);
});

test("P2-12 B4: only the deciding actor may request that Decision's Action", () => {
  assert.equal(harness.foreignActor.actionStage.actionable, false);
  assert.match(harness.foreignActor.actionStage.blockedReason, /only the person who recorded this Decision/i);
});

test("P2-12 B5: a Decision without an evidence snapshot cannot produce an Action", () => {
  assert.equal(harness.noEvidenceLink.actionStage.actionable, false);
  assert.match(harness.noEvidenceLink.actionStage.blockedReason, /no linked evidence snapshot/i);
});

// ── C. Action != Task ────────────────────────────────────────────────────────

test("P2-12 C1: an Action that is not authorized cannot become work", () => {
  assert.equal(harness.requiresApproval.governanceState, "requires_approval");
  assert.equal(harness.requiresApproval.taskStage.actionable, false);
  assert.match(harness.requiresApproval.taskStage.blockedReason, /requires approval/i);
  assert.equal(harness.deniedAction.taskStage.actionable, false);
  assert.match(harness.deniedAction.taskStage.blockedReason, /denied/i);
});

test("P2-12 C2: an authorized Action still creates no Task by itself", () => {
  assert.equal(harness.authorized.task, null);
  assert.equal(harness.authorized.taskStage.state, "not_started");
  assert.equal(harness.authorized.taskStage.actionable, true);
});

test("P2-12 C3: authorization is not execution", () => {
  assert.equal(harness.authorized.canExecute, false);
});

test("P2-12 C4: a Task is attached only by the canonical sourceActionId link", () => {
  // A governed task belonging to another Action must never be adopted by this chain.
  assert.equal(harness.foreignTask.task, null);
  assert.equal(harness.foreignTask.executions, 0);
  // A non-governed task carries no governed link at all, even with a matching id inside.
  assert.equal(harness.ungovernedTask.task, null);
  assert.equal(harness.ungovernedTask.readSourceActionId, null);
});

// ── D. Task completion != Outcome achievement (the P2-12 invariant) ──────────

test("P2-12 D1: completed internal work does not achieve, create or observe an Outcome", () => {
  const boundary = harness.workDoneNoOutcome.boundary;
  assert.equal(boundary.executionCompleted, true);
  assert.equal(boundary.taskCompleted, true);
  assert.equal(boundary.outcomeExists, false);
  assert.equal(boundary.outcomeAchieved, false);
  assert.equal(boundary.observationCount, 0);
  assert.equal(boundary.completedWorkWithoutAchievedOutcome, true);
  assert.equal(harness.workDoneNoOutcome.outcome, null);
  assert.equal(harness.workDoneNoOutcome.observations, 0);
});

test("P2-12 D2: the surface says so in words, not by layout alone", () => {
  assert.match(
    harness.workDoneNoOutcome.boundary.statement,
    /Internal work completed\. No expected Outcome has been defined yet, so nothing has been achieved\./
  );
  assert.match(text(harness.rendered.workDoneNoOutcome), /No expected Outcome has been defined yet, so nothing has been achieved/i);
});

test("P2-12 D3: an Outcome that merely exists is not an achieved Outcome", () => {
  assert.equal(harness.workDoneOutcomeExpected.outcomeState, "expected");
  assert.equal(harness.workDoneOutcomeExpected.boundary.outcomeAchieved, false);
  assert.equal(harness.workDoneOutcomeExpected.boundary.completedWorkWithoutAchievedOutcome, true);
  assert.match(harness.workDoneOutcomeExpected.boundary.statement, /no evidence-backed Observation yet, so achievement is still unknown/i);
});

test("P2-12 D4: achievement is claimed only when the canonical Outcome itself says achieved", () => {
  assert.equal(harness.achieved.boundary.outcomeAchieved, true);
  assert.equal(harness.achieved.boundary.completedWorkWithoutAchievedOutcome, false);
});

test("P2-12 D5: defining an expected Outcome is not claiming it happened", () => {
  assert.match(harness.workDoneNoOutcome.outcomeStage.effect, /Defining it does not claim it happened/i);
});

// ── E. Outcome != Observation, evidence-backed ───────────────────────────────

test("P2-12 E1: an Observation cannot be recorded without an Outcome", () => {
  assert.equal(harness.workDoneNoOutcome.observationStage.actionable, false);
  assert.match(harness.workDoneNoOutcome.observationStage.blockedReason, /No expected Outcome exists to observe/i);
});

test("P2-12 E2: an Observation requires supporting evidence", () => {
  const rendered = text(harness.rendered.noEvidence);
  assert.match(rendered, /No live, provenance-bearing evidence is available for this project yet/i);
  // The Observation write always carries evidence references.
  assert.match(operationalData, /operation:\s*"record_outcome_observation"[\s\S]*evidenceReferenceIds:\s*operation\.evidenceReferenceIds/);
});

// ── F. Missing / disputed / inconclusive stay explicit ───────────────────────

test("P2-12 F1: an inconclusive Observation is never coerced into success", () => {
  assert.equal(harness.inconclusive.observationState, "inconclusive");
  assert.equal(harness.inconclusive.missingDataState, "PARTIAL");
  assert.equal(harness.inconclusive.boundary.outcomeAchieved, false);
  assert.match(harness.inconclusive.boundary.statement, /inconclusive/i);
  assert.match(text(harness.rendered.inconclusive), /inconclusive/i);
});

test("P2-12 F2: correlation is never promoted to causation", () => {
  assert.equal(harness.inconclusive.hasCorrelationOnly, true);
  assert.match(
    text(harness.rendered.inconclusive),
    /Some links are correlation only, so this chain does not establish causation/i
  );
});

test("P2-12 F3: lineage gaps are reported, never synthesised", () => {
  assert.deepEqual(harness.inconclusive.gaps, ["No raw input recorded for this chain"]);
  assert.equal(harness.inconclusive.missingStep, "No raw input recorded for this chain");
  assert.equal(harness.inconclusive.lineageStatus, "inconclusive");
  assert.match(text(harness.rendered.inconclusive), /No raw input recorded for this chain/i);
});

test("P2-12 F4: absent lineage is reported as absent rather than fabricated", () => {
  assert.equal(harness.decidedOnly.lineage, null);
  assert.equal(harness.workDoneNoOutcome.lineage, null);
  assert.equal(harness.workDoneNoOutcome.reviewStage.state, "not_started");
  assert.match(harness.workDoneNoOutcome.reviewStage.blockedReason, /becomes available once an expected Outcome exists/i);
});

// ── G. Authority is server-derived and fails closed ──────────────────────────

test("P2-12 G1: a read-only actor can advance nothing", () => {
  assert.equal(harness.viewer.anyActionable, false);
  for (const stage of harness.viewer.stages) {
    assert.equal(stage.actionable, false, `${stage.key} must not be actionable for a read-only actor`);
    assert.ok(stage.blockedReason, `${stage.key} must explain why in text`);
  }
});

test("P2-12 G2: the denial is conveyed as text, not colour", () => {
  assert.match(text(harness.rendered.viewer), /Your role cannot record governed operations in this project/i);
});

test("P2-12 G3: gating never infers authority from a client-side role name", () => {
  const code = stripComments(readModel);
  assert.doesNotMatch(code, /===\s*["'](pm|owner|admin|viewer)["']/);
  assert.doesNotMatch(stripComments(panel), /===\s*["'](pm|owner|admin|viewer)["']/);
  // It reads the server-provided capability instead.
  assert.match(code, /summary\.actor\?\.canCreateEvidence === true/);
});

// ── H. Scope: integration only, no second aggregate ──────────────────────────

test("P2-12 H1: no new aggregate, endpoint, migration or status is introduced", () => {
  const code = stripComments(readModel) + stripComments(panel) + stripComments(operationalData);
  assert.doesNotMatch(code, /crypto\.randomUUID\(\)\s*(as|,)?\s*(actionId|taskId|outcomeId|observationId|decisionId)/);
  // Canonical writes go to operations that already existed, each backed by a service
  // function P2-12 did not author.
  const reused = {
    propose_material_action: "proposeGovernedMaterialAction",
    dispatch_material_action_to_task: "dispatchGovernedMaterialActionToTask",
    ensure_expected_outcome: "ensureExpectedOutcome",
    record_outcome_observation: "recordOutcomeObservation",
  };
  for (const [operation, serviceFunction] of Object.entries(reused)) {
    assert.match(operationalData, new RegExp(`operation:\\s*"${operation}"`), `${operation} must be reused`);
    assert.match(service, new RegExp(`export async function ${serviceFunction}\\b`), `${serviceFunction} must already exist server-side`);
  }
});

/**
 * Resolves the merge-base against the first base ref this checkout actually has.
 *
 * `.github/workflows/ci-governance.yml` uses `actions/checkout@v4` with the default
 * fetch-depth, so CI runs against a shallow clone with no `origin/main` ref. These two
 * assertions are history-dependent by nature; where the history is absent they skip
 * honestly rather than failing on a ref the checkout never fetched. Everything they
 * guard is also covered without git by H1 (reuse) and by the staged-diff review (scope).
 */
function resolveBaseCommit() {
  for (const ref of ["origin/main", "main"]) {
    try {
      return execFileSync("git", ["merge-base", "HEAD", ref], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // ref not present in this checkout — try the next one
    }
  }
  return null;
}

test("P2-12 H4: the canonical operations predate P2-12 rather than being added by it", (t) => {
  // Reuse is proven against the branch point, so "integration" cannot quietly become
  // "new backend lifecycle".
  const base = resolveBaseCommit();
  if (!base) return t.skip("no base ref in this checkout (shallow CI clone); H1 covers reuse without git");
  const baseService = execFileSync("git", ["show", `${base}:src/lib/operational-flow/operational-flow-service.ts`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const serviceFunction of [
    "proposeGovernedMaterialAction",
    "dispatchGovernedMaterialActionToTask",
    "ensureExpectedOutcome",
    "recordOutcomeObservation",
  ]) {
    assert.match(baseService, new RegExp(`export async function ${serviceFunction}\\b`), `${serviceFunction} must predate P2-12`);
  }
});

test("P2-12 H5: P2-12 introduced no migration and no new API route, and no LATER migration or route is unreviewed", (t) => {
  const base = resolveBaseCommit();
  if (!base) return t.skip("no base ref in this checkout (shallow CI clone); scope is enforced at staging review");
  const list = (...args) =>
    execFileSync("git", ["diff", "--name-only", ...args, `${base}...HEAD`], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  const changed = list();
  const added = list("--diff-filter=A");

  // P2-12 itself introduced NO migration. But the base here is
  // `merge-base HEAD origin/main`, so this measures whatever branch it runs on — not P2-12
  // in isolation — exactly like the added-operations guard below. A later verified
  // increment that legitimately ships a migration must therefore be NAMED, or this
  // assertion would forbid every future migration rather than every unreviewed one.
  //
  // P2-14 ships exactly one: a forward-only hardening of the two canonical intake
  // contracts, closing the review finding that a caller-selected `sourceKey` could mint a
  // Source under the other lineage's reserved identity. It is additive — `create or replace
  // function`, `revoke`, `grant`, `comment on` only — with no schema, RLS, policy, data or
  // signature change, and it carries its own acceptance in
  // tests/p2-14-intake-source-boundary.test.mjs and scripts/check-p2-14-db.mjs.
  //
  // UX-W3 / CODEX-P2-02 ships exactly one: a forward-only `create or replace` of
  // `get_operational_assurance_summary` that adds ONE key, `openRecommendationIds`,
  // computed with exactly the predicates the existing `openRecommendations` count already
  // uses and inside the SAME `select jsonb_build_object(...)` — so membership and the count
  // come from one statement snapshot. `asOf` is `now()`, a wall-clock reading rather than a
  // token of MVCC visibility, so timestamps could not decide snapshot membership and equal
  // cardinality could not prove it. No schema, RLS, policy, trigger, data, signature,
  // decision or authorization change; same `stable security invoker` and pinned
  // `search_path`, with the PUBLIC revoke and `authenticated` grant re-issued. It carries
  // its own acceptance in tests/ux-w3-needs-you-interaction-quality.test.mjs.
  //
  // Exact full paths only: no wildcard, no timestamp prefix, no directory grant. Anything
  // not named here still fails this assertion, which is the protection P2-12 actually needs.
  const REVIEWED_LATER_MIGRATIONS = new Set([
    "supabase/migrations/20260907000000_p2_14_intake_source_classification_hardening.sql",
    "supabase/migrations/20260908000000_p2_02_attention_membership_snapshot.sql",
  ]);
  const unreviewedMigrations = changed
    .filter((file) => file.startsWith("supabase/migrations/"))
    .filter((file) => !REVIEWED_LATER_MIGRATIONS.has(file));
  assert.deepEqual(unreviewedMigrations, [], "no UNREVIEWED migration may be introduced");

  // No NEW API route. An EXISTING route may be modified: closing N5 required removing
  // `createdAt`/`evaluationTime`/`expiresAt` from the operational-flow handler so a
  // browser clock could no longer define a governance window. That is a removal of client
  // authority at an existing boundary, not new API surface.
  assert.deepEqual(added.filter((file) => /^src\/app\/api\/.*route\.ts$/.test(file)), []);

  // …and the surface area of the existing routes must not grow WITHOUT REVIEW: no
  // operation branch may appear that a verified increment did not deliberately introduce.
  // This is stricter than a file-level check, which could not tell a removal from a new
  // endpoint hidden inside an existing file.
  //
  // The base here is `merge-base HEAD origin/main`, so this measures whatever branch it
  // runs on — not P2-12 in isolation. A later increment that legitimately extends this
  // boundary must therefore be named, or this guard would forbid every future operation
  // rather than every unreviewed one.
  //
  // P2-14 adds exactly one: `capture_live_input`, the narrow LIVE intake exposure that
  // delegates wholesale to the already-verified P2-09 `capture_live_operational_input`
  // contract on this EXISTING route. It carries its own acceptance in
  // tests/p2-14-live-intake-exposure.test.mjs, which independently asserts that no new
  // route file exists, that the service reimplements none of the RPC, and that the browser
  // supplies no identity or authority. Naming it keeps this assertion failing for any
  // OTHER added operation, which is the protection P2-12 actually needs.
  const REVIEWED_ADDED_OPERATIONS = new Set(["capture_live_input"]);
  const routeDiff = execFileSync("git", ["diff", `${base}...HEAD`, "--", "src/app/api"], { encoding: "utf8" });
  const addedOperations = routeDiff
    .split("\n")
    .filter((line) => line.startsWith("+") && /operation === "/.test(line))
    .map((line) => line.match(/operation === "([^"]+)"/)?.[1] ?? line.trim())
    .filter((operation) => !REVIEWED_ADDED_OPERATIONS.has(operation));
  assert.deepEqual(addedOperations, [], "no UNREVIEWED operation may be added to an existing route");
});

test("P2-12 H2: the read model owns no records and stays framework-free", () => {
  assert.doesNotMatch(readModel, /from "react"/);
  assert.doesNotMatch(readModel, /useState|useEffect|fetch\(/);
});

test("P2-12 H3: canonical ids are rendered from persisted rows, never generated in the panel", () => {
  assert.doesNotMatch(stripComments(panel), /randomUUID|Math\.random/);
});

// ── L. Idempotency, correlation and epistemic honesty ────────────────────────

test("P2-12 L1: an Observation retry reconciles instead of creating a second one", () => {
  // P2-09 makes (workspace, project, idempotency_key) unique and replays identical
  // content as `existing`, so the key must be a function of content, not of time.
  assert.equal(harness.idempotency.stable, true, "identical submission => identical key");
  assert.equal(harness.idempotency.reorderedEvidence, true, "reordered evidence ids => identical key");
  assert.equal(harness.idempotency.whitespaceNormalised, true, "trimmed summary => identical key");
  assert.doesNotMatch(operationalData, /idempotencyKey:.*Date\.now\(\)/);
  assert.doesNotMatch(operationalData, /idempotencyKey:.*randomUUID/);
});

test("P2-12 L2: a genuinely different observation gets a different identity", () => {
  assert.equal(harness.idempotency.differsOnState, true);
  assert.equal(harness.idempotency.differsOnSummary, true);
  assert.equal(harness.idempotency.differsOnEvidence, true);
  assert.equal(harness.idempotency.differsOnOutcome, true);
});

test("P2-12 L1b: a later identical observation is a DISTINCT canonical event", () => {
  // Canonical Observations are a temporal stream: the same Outcome may legitimately be
  // observed twice with an identical state, summary and evidence set. Content-only
  // identity would collapse the second into the first and silently lose it.
  assert.equal(harness.idempotency.differsOnAttempt, true,
    "different submission attempt + identical content => different idempotency key");
});

test("P2-12 L1c: the attempt identity survives a remount and is retired only once it lands", () => {
  // The lost-response case: the row is committed, the response never arrives, and the PM
  // closes the drawer / navigates / refreshes before retrying. A per-mount token would
  // arrive with a fresh nonce and insert a SECOND canonical Observation.
  const lifecycle = harness.idempotency.lifecycle;
  assert.equal(lifecycle.retryReusesAttempt, true, "a retry after remount resolves the same identity");
  assert.equal(lifecycle.retainedAfterFailure, true, "a failed submission retains its identity");
  assert.equal(lifecycle.clearedAfterReconcile, null, "persisted state proving the write landed retires it");
  assert.equal(lifecycle.nextSubmissionIsNew, true, "a later genuine observation takes a new identity");
  assert.equal(lifecycle.survivesUnrelatedKey, true, "an unrelated persisted key must not retire a pending attempt");
  assert.equal(lifecycle.newIdentityAfterWindow, true, "past its window, the next submission is genuinely new");
});

test("P2-12 L1c2: the attempt outlives the component and holds nothing canonical or secret", () => {
  // Identity lives in a module keyed by canonical scope, not in a component ref, so a
  // remount cannot lose it. It is not a canonical id, and no secret is written.
  assert.doesNotMatch(stripComments(panel), /useRef|createAttemptTracker/);
  assert.match(submissionAttempt, /globalThis\.localStorage/);
  assert.match(submissionAttempt, /const fallback = new Map<string, SubmissionAttempt>\(\)/);
  // Storage is never allowed to throw, and only the nonce + its timestamps are stored.
  assert.match(submissionAttempt, /catch \{/);
  for (const forbidden of [/token/i, /secret/i, /apiKey/i, /serviceRole/i]) {
    assert.doesNotMatch(
      submissionAttempt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
      new RegExp(`(setItem|JSON\\.stringify)\\([^)]*${forbidden.source}`, "i")
    );
  }
  // Reconciliation is driven by the server's own persisted idempotency key.
  assert.deepEqual(harness.observationReconciliation.persistedKeys, ["p2-12:observation:out-1:landed"]);
  assert.match(layout, /reconcileExecutionAttempts\(workspaceId, selectedProject\?\.id \?\? "", executionChains\)/);
});

test("P2-12 L1d: a conflict does not rotate the attempt — it stays visible and fails closed", () => {
  // A conflict is surfaced as a thrown error (the route answers 409), so the identity is
  // retained rather than silently rotating into a second write. Since N1 the attempt is
  // not retired on the response at all — only persisted state retires it — so a conflict
  // and a lost response are handled by the same rule.
  assert.match(operationalData, /idempotencyKey,\n  \}\);[\s\S]{0,400}markSubmissionAcknowledged\(attemptKey\)/);
  assert.doesNotMatch(stripComments(operationalData), /catch[\s\S]{0,200}clearSubmissionAttempt/);
  assert.doesNotMatch(stripComments(operationalData), /catch[\s\S]{0,200}markSubmissionAcknowledged/);
  assert.match(panel, /catch \(caught\) \{[\s\S]{0,200}setError\(/);
});

test("P2-12 L2b: the digest is a full, untruncated SHA-256 from the platform primitive", () => {
  // `canonical_outcome_observations.idempotency_key` is unbounded `text`, so the whole
  // hex digest is stored — no truncation, and no added dependency.
  assert.equal(harness.idempotency.knownAnswer, true, "sha256Hex must match the SHA-256 known answer for 'abc'");
  assert.match(harness.idempotency.digest, /^[0-9a-f]{64}$/, "a full 64-hex-character digest");
  assert.match(harness.idempotency.sample, /^p2-12:observation:out-1:[0-9a-f]{64}$/);
  assert.match(readModel, /crypto\.subtle\.digest\("SHA-256"/);
  // FNV-1a is gone; it is not collision-resistant enough for a durable canonical identity.
  assert.doesNotMatch(readModel, /0x811c9dc5|FNV/i);
});

test("P2-12 L2c: the hashed payload is canonically and unambiguously serialized", () => {
  // A JSON array, so a summary containing the delimiter cannot collide with a different
  // submission, and evidence is compared as a set rather than a sequence. The attempt
  // token is the final element; `observedAt` is deliberately absent — it is the fact
  // being recorded, and including it would break retry stability.
  // Since N3 the persisted epistemic fields participate too: P2-09 stores both NOT NULL
  // while its replay check ignores them, so leaving them out let a quality-only retry be
  // acknowledged as a replay with the corrected values discarded.
  assert.equal(
    harness.idempotency.canonicalPayload,
    '["out-1","inconclusive","The client replied.",["ev-1","ev-2"],"0.4000","PARTIAL","attempt-A"]'
  );
  assert.doesNotMatch(readModel, /observedAt[\s\S]{0,80}canonicalObservationPayload/);
});

test("P2-12 L3: Outcome and Observation reuse the chain's persisted correlation", () => {
  assert.equal(harness.correlation.actionCorrelationId, "corr-1");
  // No stage mints a fresh correlation id.
  assert.doesNotMatch(stripComments(operationalData), /correlationId:\s*crypto\.randomUUID\(\)/);
  assert.match(operationalData, /correlationId:\s*operation\.correlationId/);
  // It is read from the persisted Action, which P2-08 also copies onto the Execution.
  assert.match(panel, /branch\.action\.correlationId/);
});

test("P2-12 L4: observation confidence and missing-data are supplied, never assumed", () => {
  assert.doesNotMatch(operationalData, /confidenceScore:\s*1\b/);
  assert.doesNotMatch(operationalData, /missingDataState:\s*"COMPLETE"/);
  assert.match(operationalData, /confidenceScore:\s*operation\.quality\.confidenceScore/);
  assert.match(operationalData, /missingDataState:\s*operation\.quality\.missingDataState/);
  assert.deepEqual(harness.contract.missingDataStates, ["COMPLETE", "PARTIAL", "UNKNOWN"]);
  const rendered = text(harness.rendered.inconclusive);
  assert.match(rendered, /How confident is this observation\? 0 to 1 \(required\)/i);
  assert.match(rendered, /Was any needed data missing\? \(required\)/i);
  assert.match(rendered, /needs a summary, supporting evidence, a confidence value and a missing-data state/i);
});

test("P2-12 L4b: only evidence P2-09 accepts is offered as the basis of an Observation", () => {
  // The RPC refuses anything that is not canonical, provenance-bearing LIVE evidence
  // (`observation_evidence_scope_invalid`), so offering it would be a control that always fails.
  const e = harness.evidenceEligibility;
  assert.equal(e.live, true);
  assert.equal(e.fixture, false, "demo fixture evidence cannot promote an outcome");
  assert.equal(e.noProvenance, false);
  assert.equal(e.degraded, false);
  assert.equal(e.rejected, false);
  assert.equal(e.stale, false);
  assert.equal(e.notCurrent, false);
  assert.equal(e.notRecorded, false);
  assert.equal(e.unevaluated, false);
  assert.match(operationalData, /filter\(\(row\) => isObservationEligibleEvidence\(row, now\)\)/);
});

test("P2-12 L4c: when no eligible evidence exists the surface says so", () => {
  assert.match(
    text(harness.rendered.noEvidence),
    /No live, provenance-bearing evidence is available for this project yet/i
  );
  assert.match(text(harness.rendered.noEvidence), /Demo or fixture evidence cannot promote an outcome/i);
});

test("P2-12 L5: material action classification is supplied by the human, not invented", () => {
  // materiality — and therefore the governance state — derives from these four, so none
  // may be hardcoded on the PM's behalf.
  for (const field of ["actionClass", "risk", "reversibility", "sideEffect"]) {
    assert.match(operationalData, new RegExp(`${field}:\\s*operation\\.draft\\.${field}`), `${field} must come from the human`);
  }
  assert.doesNotMatch(operationalData, /actionClass:\s*"external_write"/);
  assert.doesNotMatch(operationalData, /risk:\s*"high"/);
  assert.doesNotMatch(operationalData, /targetResourceType:\s*"project_schedule"/);
  assert.deepEqual(harness.contract.materialActionClasses, [
    "ordinary_business_write",
    "external_write",
    "authority_mutation",
    "material_agent_action",
    "knowledge_elevation",
    "policy_classified",
  ]);
  assert.deepEqual(harness.contract.materialActionRisks, ["low", "medium", "high", "critical", "unknown"]);
});

test("P2-12 L6: the remaining action fields have an honest source", () => {
  // The Decision's own recorded rationale justifies acting.
  assert.match(operationalData, /justification:\s*operation\.justification/);
  assert.match(panel, /justification: chain\.rationale/);
  // Factual rather than assumed: P2-06 persists an inert authorization scoped to this project.
  assert.match(operationalData, /intendedOperation:\s*"propose_only"/);
  assert.match(operationalData, /targetResourceType:\s*"project"/);
  assert.match(operationalData, /targetResourceId:\s*projectId/);
});

test("P2-12 L7: the action stage says governance depends on the human's answers", () => {
  assert.match(
    text(harness.rendered.decidedOnlyActionForm),
    /Governance classifies this action from what you state below/i
  );
});

// ── I. Persistence and reconciliation ────────────────────────────────────────

test("P2-12 I1: every stage awaits the server write before revalidating", () => {
  // The write is still awaited before any revalidation. Since N1 the revalidation is a
  // separately guarded step, so its failure cannot be reported as a write failure.
  assert.match(layout, /await runExecutionOperation\([\s\S]{0,140}\);\s*\n\s*setStaleSinceGeneration\(null\);\s*\n\s*try \{\s*\n\s*await mutateFlow\(\);/);
});

test("P2-12 I2: a denied execution disposition is treated as failure, not success", () => {
  assert.match(operationalData, /disposition === "denied" \|\| result\.disposition === "conflict"/);
});

test("P2-12 I3: retrying a Material Action reconciles instead of duplicating", () => {
  // P2-06 folds `createdAt` and `expiresAt` into the proposal digest and compares that
  // digest against the row already stored under this idempotency key. A retry that mints
  // fresh timestamps is therefore NOT a replay — it is `material_action_idempotency_conflict`.
  // One submission attempt must carry one identity AND one wall-clock reading.
  const attempt = harness.idempotency.materialActionAttempt;
  assert.equal(attempt.retryKeepsIdentity, true, "a retry reuses the attempt's idempotency identity");
  assert.equal(attempt.retryKeepsTimestamp, true, "a retry re-sends the same createdAt, so the digest matches");
  // The key is attempt-scoped, and both digest-bearing timestamps come from the attempt.
  assert.match(operationalData, /idempotencyKey = `p2-12:material-action:\$\{operation\.decisionId\}:\$\{attempt\.attemptId\}`/);
  // Since N5 the timestamps are server-owned, and the server reuses the PERSISTED window
  // on a retry — so the digest still matches without the client supplying wall time.
  assert.doesNotMatch(stripComments(operationalData), /createdAt:|evaluationTime:|expiresAt:/);
  assert.match(service, /\.select\("created_at,expires_at"\)/);
  // The persisted-row lookup is tenant AND project scoped, so no other project's window
  // can be read into this proposal.
  assert.match(
    service,
    /\.select\("created_at,expires_at"\)\s*\n\s*\.eq\("workspace_id", scope\.workspaceId\)\s*\n\s*\.eq\("project_id", scope\.projectId\)\s*\n\s*\.eq\("idempotency_key", input\.idempotencyKey\)/
  );
  assert.match(service, /return \{ createdAt: persistedCreatedAt, evaluationTime: now, expiresAt: persistedExpiresAt \};/);
  // No timestamp is read at request time on the client, which is what made the retry diverge.
  assert.doesNotMatch(stripComments(operationalData), /createdAt: now\.toISOString\(\)/);
});

test("P2-12 I4: the open drawer is resolved fresh so it reconciles after each write", () => {
  assert.match(layout, /executionChains\.find\(\(entry\) => entry\.decisionId === openChainId\)/);
});

// ── J. Surface composition ───────────────────────────────────────────────────

test("P2-12 J1: the continuation is reachable from the Command Center at every breakpoint", () => {
  // Before UX-W2 this was rendered twice — the desktop rail and a copy inside the mobile
  // overlay — because the rail did not exist on a phone. It is now one section of the main
  // attention canvas, laid out into the right column on a wide screen by CSS rather than by
  // a second DOM. Mounted once, reachable everywhere, and never behind an overlay.
  assert.equal((layout.match(/<ExecutionQueue/g) ?? []).length, 0, "the screen composes the canvas, not the queue directly");
  const canvas = readFileSync("src/modules/workspace/presentation/command-center/command-center-canvas.tsx", "utf8");
  assert.equal((canvas.match(/<ExecutionQueue/g) ?? []).length, 1);
  assert.match(layout, /<CommandCenterCanvas/);
  assert.match(layout, /chains=\{executionChains\}/);
});

test("P2-12 J2: the queue reports real stage progress and an honest empty state", () => {
  const populated = text(harness.rendered.queuePopulated);
  // UX-W2 renamed this surface for the PM ("In Progress") and kept its post-decision
  // meaning stated in the section itself. The canonical semantics below are untouched.
  assert.match(populated, /In Progress/i);
  assert.match(populated, /after your decisions/i);
  assert.match(populated, /Work completed — no expected outcome yet/i);
  assert.match(chainRows(harness.rendered.queuePopulated), /In progress/i);
  assert.doesNotMatch(populated, /Action authorized/i);
  assert.doesNotMatch(populated, /Outcome achieved/i);
  assert.match(text(harness.rendered.queueEmpty), /Nothing is in progress yet/i);
  assert.match(text(harness.rendered.queueEmpty), /Once you record a decision/i);
});

test("P2-12 J3: chain lookup is scoped to this project's persisted decisions", () => {
  assert.equal(harness.lookup.found, true);
  assert.equal(harness.lookup.foreign, false);
});

// ── K. Accessibility semantics ───────────────────────────────────────────────

test("P2-12 K1: stage controls carry labels, status and alert semantics", () => {
  assert.match(panel, /role="status"\s+aria-live="polite"/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /<label htmlFor=\{expectedId\}/);
  assert.match(panel, /<label htmlFor=\{summaryId\}/);
  assert.match(panel, /<label htmlFor=\{stateId\}/);
  assert.match(panel, /aria-labelledby=\{headingId\}/);
});

test("P2-12 K2: stage state is available as text, not colour alone", () => {
  const rendered = text(harness.rendered.workDoneNoOutcome);
  for (const label of ["Governed material action", "Canonical internal task", "Internal execution", "Expected outcome"]) {
    assert.match(rendered, new RegExp(label, "i"));
  }
  assert.match(rendered, /Not started|Recorded|Complete/);
});

test("P2-12 K3: required input is explained rather than silently disabling the control", () => {
  assert.match(text(harness.rendered.workDoneNoOutcome), /Describe the expected outcome to continue/i);
});

// ── M. Review closure: findings raised against the first P2-12 implementation ─────────
//
// Each test below pins the behaviour of a specific canonical server rule that the surface
// previously did not mirror, so a control could be offered that the contract must reject —
// or, worse, so a truncated projection could be read as canonical absence.

test("P2-12 M1: one Material Action submission keeps one payload across a retry", () => {
  // `persist_governed_material_action` compares the stored proposal digest for the fixed
  // idempotency key, and `canonicalProposal` folds `createdAt`/`expiresAt` into it.
  const attempt = harness.idempotency.materialActionAttempt;
  assert.equal(attempt.retryKeepsIdentity, true);
  assert.equal(attempt.retryKeepsTimestamp, true);
  // Once the submission is accepted, a later proposal is a genuinely new one.
  assert.equal(attempt.replacementIsNewIdentity, true);
  // The attempt is scoped to workspace + project + Decision + the stated classification,
  // never global.
  assert.match(attempt.scopedKey, /^pmfreak\.p2-12\.attempt\.material-action\.ws-1\.proj-1\.dec-1\.[a-f0-9]{64}$/);
  // Correcting a mis-stated answer is a new submission, not a conflicting retry: P2-06
  // compares the proposal digest under the key and would otherwise answer
  // `material_action_idempotency_conflict` until the attempt aged out.
  assert.equal(attempt.correctedDraftIsNewSubmission, true);
  assert.notEqual(attempt.correctedDraftAttemptId, attempt.firstDraftAttemptId);
  // The retry window matches the authorization window it describes.
  assert.equal(attempt.windowMs, 60 * 60 * 1000);
});

test("P2-12 M2: an expired authorization has a governed recovery path", () => {
  // `dispatch_governed_action_to_internal_task` denies a past-`expires_at` Action with
  // failureClass `expired`, and P2-07's unique index means that Action can never become a
  // Task. Without a replacement path the chain would be permanently stuck.
  const chain = harness.expiredNoTask;
  assert.equal(chain.expired, true);
  assert.equal(chain.dispatchable, false);
  assert.equal(chain.taskStage.actionable, false);
  assert.match(chain.taskStage.blockedReason, /authorization has expired/i);
  assert.match(chain.taskStage.blockedReason, /request a replacement authorization/i);
  // The recovery is a NEW governed proposal, evaluated on its own terms.
  assert.equal(chain.proposalStage.actionable, true);
  assert.match(chain.proposalStage.label, /replacement/i);
  assert.match(chain.proposalStage.effect, /earlier Action and its audit trail are preserved unchanged/i);
  assert.match(text(chain.rendered), /Request replacement governed material action/i);
  // Never presented as ordinary progress.
  assert.equal(chain.status.label, "Authorization expired");
  assert.equal(chain.status.tone, "danger");
});

test("P2-12 M2b: the expired Action is preserved, never mutated into an active one", () => {
  const chain = harness.expiredPlusReplacement;
  assert.equal(chain.branches, 2, "both canonical Actions stay reachable");
  assert.deepEqual(chain.actionIds, ["act-2", "act-1"], "newest first; the superseded one remains");
  assert.deepEqual(chain.expiredFlags, [false, true], "the expired Action is still reported as expired");
  assert.deepEqual(chain.dispatchableFlags, [true, false]);
  // A live branch exists, so the surface stops offering further replacements.
  assert.equal(chain.proposalStage.actionable, false);
  assert.match(chain.proposalStage.blockedReason, /still authorized to proceed/i);
  const rendered = text(chain.rendered);
  assert.match(rendered, /act-1/);
  assert.match(rendered, /act-2/);
});

test("P2-12 M3: execution controls follow the canonical P2-08 transition table", () => {
  // Read from `transition_internal_task_execution` and `dispatch_internal_task_execution`.
  assert.deepEqual(harness.contract.executionTransitions, {
    none: ["queue"],
    queued: ["start", "block", "fail"],
    running: ["block", "fail", "complete"],
    blocked: ["start", "fail"],
    failed: ["retry"],
    completed: [],
  });

  const states = harness.executionStates;
  // `queue` is offered only from a `not_started` Task
  // (`new_internal_execution_requires_not_started_task`).
  assert.deepEqual(states.none_not_started.commands, ["queue"]);
  assert.equal(states.none_not_started.stage.actionable, true);
  assert.deepEqual(states.none_in_progress.commands, []);
  assert.match(states.none_in_progress.stage.blockedReason, /new internal execution cannot be opened/i);

  assert.deepEqual(states.queued.commands, ["start", "block", "fail"]);
  assert.deepEqual(states.running.commands, ["block", "fail", "complete"]);
  // A failed execution is recoverable — with `retry`, which the first implementation never offered.
  assert.deepEqual(states.failed.commands, ["retry"]);
  assert.equal(states.failed.stage.actionable, true);
  assert.match(text(states.failed.rendered), /Retry/);
  // A blocked execution has its own recovery.
  assert.deepEqual(states.blocked.commands, ["start", "fail"]);
  // A completed execution is offered no illegal transition at all.
  assert.deepEqual(states.completed.commands, []);
  assert.equal(states.completed.stage.actionable, false);
  assert.match(states.completed.stage.blockedReason, /no further transition available/i);

  // The old fixed triple is gone: nothing offers `complete` from a queued execution.
  assert.doesNotMatch(stripComments(panel), /\["queue", "start", "complete"\]/);
  // The list the panel renders is resolved by the read model — see M3e.
  assert.match(panel, /const commands = branch\.offeredCommands/);
  for (const state of ["queued", "running", "blocked", "failed"]) {
    const rendered = text(states[state].rendered);
    for (const command of states[state].commands) {
      assert.ok(rendered.length > 0, `${state} renders`);
      assert.ok(harness.contract.executionCommands.includes(command), `${command} is canonical`);
    }
  }
});

test("P2-12 M3b: only the dispatching actor is offered execution transitions", () => {
  // `transition_internal_task_execution` answers `internal_execution_actor_mismatch`.
  assert.equal(harness.foreignExecutionActor.dispatchedBy, "actor-someone-else");
  assert.equal(harness.foreignExecutionActor.stage.actionable, false);
  assert.match(harness.foreignExecutionActor.stage.blockedReason, /only the person who dispatched/i);
});

test("P2-12 M5: an expected Outcome is gated on completed work, both prerequisites", () => {
  // `ensure_expected_task_outcome` requires `execution_tasks.status = 'completed'` AND a
  // completed `internal_task_executions` row, raising `canonical_task_not_completed` /
  // `completed_internal_execution_required` otherwise.
  const gate = harness.outcomeGate;
  for (const blocked of [
    "task_not_started_exec_queued",
    "task_in_progress_exec_running",
    "task_blocked_exec_blocked",
    "task_in_progress_exec_failed",
    "task_completed_exec_running",
    "task_completed_exec_failed",
  ]) {
    assert.equal(gate[blocked].actionable, false, `${blocked} must not offer the Outcome control`);
    assert.ok(gate[blocked].blockedReason, `${blocked} must explain why in text`);
  }
  assert.match(gate.task_in_progress_exec_running.blockedReason, /only be defined once the Task is completed/i);
  assert.match(gate.task_completed_exec_running.blockedReason, /no completed internal execution yet/i);
  assert.equal(gate.task_completed_exec_completed.actionable, true);

  // The gate governs only WHEN an expected Outcome may be defined. It never marks it achieved.
  assert.equal(harness.workDoneOutcomeExpected.boundary.outcomeAchieved, false);
  assert.equal(harness.workDoneNoOutcome.boundary.completedWorkWithoutAchievedOutcome, true);
});

test("P2-12 M6: task dispatch is offered only to the Action's own proposer", () => {
  // `dispatch_governed_action_to_internal_task` requires
  // `material_action_proposals.proposed_by = auth.uid()` (`governed_action_actor_mismatch`).
  const other = harness.otherWritableMember;
  assert.equal(other.canWrite, true, "the negative case is a member who CAN write");
  assert.equal(other.governanceState, "authorized", "and whose Action IS authorized");
  assert.equal(other.proposedBy, "actor-someone-else");
  assert.equal(other.taskStage.actionable, false);
  assert.match(other.taskStage.blockedReason, /only the person who proposed this Material Action/i);
  assert.match(text(other.rendered), /Only the person who proposed this Material Action/i);
  // Positive case: the proposer themselves.
  assert.equal(harness.ownerCanDispatch.taskStage.actionable, true);
  // Ownership is read from the persisted actor, never inferred from a role name.
  assert.match(readModel, /input\.action\.proposedBy !== input\.actorUserId/);
});

test("P2-12 M7: a truncated projection is never read as canonical absence", () => {
  // Proof the regression bites: every one of the old chain's linked rows falls outside the
  // newest-30 project-wide window once 35 newer unrelated rows exist.
  for (const [table, present] of Object.entries(projection.windowedOnlyContainsOldRow)) {
    assert.equal(present, false, `${table}'s project-wide window must exclude the old row`);
  }
  // And proof the fix holds: the summary still carries every one of them.
  for (const [node, present] of Object.entries(projection.summaryCarries)) {
    assert.equal(present, true, `${node} must survive the window via its persisted reference`);
  }
  // So the chain states what is true instead of claiming absence.
  const chain = projection.chainResolves;
  assert.equal(chain.found, true);
  assert.equal(chain.branches, 1);
  assert.equal(chain.actionId, "act-old");
  assert.equal(chain.taskId, "task-old");
  assert.equal(chain.executionId, "exec-old");
  assert.equal(chain.outcomeId, "out-old");
  assert.equal(chain.observationCount, 1);
  assert.equal(chain.outcomeAchieved, true);
  assert.match(chain.statement, /an evidence-backed Observation supports the expected Outcome/i);
});

test("P2-12 M7b: linked rows are fetched by exact persisted reference, not a widened window", () => {
  // A bounded root set, then id-scoped completion at every level. No unbounded
  // project-wide read is introduced, and nothing is joined by timestamp or title.
  assert.deepEqual(projection.linkedByIdQueries, [
    "decision_evidence_links:in:decision_record_id",
    "material_action_proposals:in:source_decision_id",
    "material_action_governance_evaluations:in:action_id",
    "execution_tasks:in:source_payload->>sourceActionId",
    "internal_task_executions:in:task_id",
    "canonical_task_outcomes:in:task_id",
    "canonical_outcome_observations:in:outcome_id",
    // UX-W3 extends the same discipline UPSTREAM. The attention surface was reading
    // "does this Recommendation's Evidence exist?" and "which authority does it need?" out
    // of independently truncated windows, so an out-of-window row read as canonical
    // absence — the exact defect this test exists to prevent, on the other side of the
    // Decision. It is completed the same way: a bounded root set (the recommendation
    // window) and exact-id reads through the same helper.
    //
    // The Recommendation the recent Decision points at, so a drawer opened on an old
    // attention root still resolves after the Decision removes it from the open set.
    "recommended_actions:in:id",
    // Decision history for the attention roots is rooted on open UNION reconciled
    // Recommendations (CODEX-P2-03), so a reconciled root's own history is fetched here —
    // and its frozen evidence snapshots with it.
    "operational_decision_records:in:recommendation_id",
    "decision_evidence_links:in:decision_record_id",
    // Only `governance_events` follows because this fixture's Recommendation carries no
    // `risk_issue_id`, so the risk / signal / evidence id sets stay empty — `linkedRows`
    // returning early on an empty id set is the bound working.
    "governance_events:in:id",
    // The probe run that proves the windows alone would have dropped the chain.
    "decision_evidence_links:in:decision_record_id",
  ]);
  // Every upstream completion is an exact-id read, never a widened window or a fuzzy join.
  for (const table of ["governance_events", "risk_issue_records", "operational_signals", "evidence_items", "recommended_actions", "operational_decision_records"]) {
    // The id column varies (`id`, or `recommendation_id` for the attention Decision read);
    // what must hold is that every completion goes through the chunked/paged helper.
    assert.match(service, new RegExp(`linkedRows\\(\\s*"${table}",\\s*"(id|recommendation_id)"`), `${table} is completed by exact reference`);
  }
  // The by-id reads union with the windowed ones rather than replacing them, so no
  // existing surface loses a row it used to see.
  assert.match(service, /const unionById = \(orderColumn: string, \.\.\.groups/);
  assert.match(service, /materialActions: allMaterialActions/);
});

test("P2-12 M8: a rejected Decision reads as stopped, not as unfinished work", () => {
  assert.equal(harness.rejected.status.label, "Decision rejected");
  assert.equal(harness.rejected.status.tone, "danger");
  assert.match(harness.rejected.status.detail, /no governed action follows/i);
  const queue = chainRows(harness.rejected.queue);
  assert.match(queue, /Decision rejected/);
  assert.doesNotMatch(queue, /In progress/i);
  // Rejected is what the canonical Decision says; it is never relabelled as failed.
  assert.doesNotMatch(queue, /failed/i);
});

test("P2-12 M9: every Material Action linked to a Decision stays reachable", () => {
  // `source_decision_id` carries no unique constraint — the schema's only uniqueness is
  // `(workspace_id, idempotency_key)` — so one Decision may hold several Actions.
  const chain = harness.twoActionsTwoTasks;
  assert.equal(chain.branches, 2);
  assert.deepEqual(chain.actionIds, ["act-2", "act-1"]);
  // Each Action keeps its OWN downstream chain; none is collapsed into the other.
  assert.deepEqual(chain.taskIds, ["task-2", "task-1"]);
  assert.deepEqual(chain.executionIds, ["exec-2", "exec-1"]);
  assert.deepEqual(chain.outcomeIds, [null, "out-1"]);
  assert.deepEqual(chain.observationCounts, [0, 1]);
  const rendered = text(chain.rendered);
  assert.match(rendered, /Material action 1 of 2/);
  assert.match(rendered, /Material action 2 of 2/);
  assert.match(rendered, /task-1/);
  assert.match(rendered, /task-2/);
  // Branch identity comes from the canonical Action, so the two never collide.
  assert.deepEqual(harness.expiredPlusReplacement.branchIds, ["governed-branch-act-2", "governed-branch-act-1"]);
  // No client-side uniqueness invariant is fabricated.
  assert.doesNotMatch(stripComments(readModel), /actionsByDecision\.has\(/);
});

test("P2-12 M9b: the counts hold for none, one and two Actions", () => {
  assert.equal(harness.decidedOnly.branches, 0);
  assert.equal(harness.decidedOnly.status.label, "No action yet");
  assert.equal(harness.expiredNoTask.branches, 1);
  assert.equal(harness.twoActionsTwoTasks.branches, 2);
  assert.equal(harness.expiredPlusReplacement.branches, 2);
});

test("P2-12 M10: the queue reports the persisted governance state, never a positive reading", () => {
  const labels = harness.governanceLabels;
  // "Authorized" is reserved for the states P2-07 will actually dispatch.
  assert.equal(labels.authorized, "Action authorized");
  assert.match(labels.requiresApproval, /requires approval/i);
  assert.match(labels.denied, /denied/i);
  assert.match(labels.degraded, /degraded/i);
  assert.match(labels.unavailable, /unavailable/i);
  assert.match(labels.revoked, /revoked/i);
  // An unrecognised state is named, not guessed at.
  assert.match(labels.unknownState, /some future state/);
  for (const key of ["requiresApproval", "denied", "degraded", "unavailable", "revoked"]) {
    assert.doesNotMatch(labels[key], /authorized/i, `${key} must not read as authorized`);
  }

  const queues = harness.governanceQueues;
  assert.equal(queues.authorized.detail, "Action authorized — no task yet");
  assert.equal(queues.authorized.badge, "In progress");
  for (const key of ["requiresApproval", "denied", "degraded", "unavailable", "revoked", "expired"]) {
    assert.doesNotMatch(queues[key].detail, /Action authorized —/, `${key} must not claim authorization`);
    assert.equal(queues[key].tone, "danger", `${key} must not read as ordinary progress`);
  }
  assert.match(queues.requiresApproval.detail, /requires approval/i);
  assert.match(queues.expired.detail, /authorization expired/i);
  // The old blanket string is gone.
  assert.doesNotMatch(stripComments(readFileSync("src/modules/workspace/presentation/command-center/execution-queue.tsx", "utf8")), /Action authorized — no task yet/);
});

test("P2-12 M6b: an eligible governance state alone does not make an Action dispatchable", () => {
  // `dispatch_governed_action_to_internal_task` denies on FIVE grounds this surface holds
  // data for, not two. Offering the control on the strength of `governance_state` alone
  // would put a button in front of the PM that the contract must reject.
  const gates = harness.dispatchGates;

  // Positive control: every gate satisfied.
  assert.equal(gates.authorized.dispatchable, true);
  assert.equal(gates.authorized.blockReason, null);
  assert.equal(gates.authorized.taskStage.actionable, true);

  // `governance_evaluation_stale` — the evaluation's own `valid_until` has passed, even
  // though the Action's `expires_at` has not.
  assert.equal(gates.stale_evaluation.governanceState, "authorized");
  assert.equal(gates.stale_evaluation.evaluationStale, true);
  assert.equal(gates.stale_evaluation.dispatchable, false);
  assert.match(gates.stale_evaluation.blockReason, /governance evaluation is no longer valid/i);

  // `governed_action_not_dispatchable` — the server requires `can_commit_action` as well
  // as an eligible state.
  assert.equal(gates.cannot_commit.governanceState, "authorized");
  assert.equal(gates.cannot_commit.canCommitAction, false);
  assert.equal(gates.cannot_commit.dispatchable, false);
  assert.match(gates.cannot_commit.blockReason, /without permitting it to be committed/i);

  // `policy_or_grant_reference_missing` — authorized material work must retain the
  // policy decision and grant evidence that made it allowable.
  assert.equal(gates.missing_grant_evidence.governanceState, "authorized");
  assert.equal(gates.missing_grant_evidence.authorizationEvidenceComplete, false);
  assert.equal(gates.missing_grant_evidence.dispatchable, false);
  assert.match(gates.missing_grant_evidence.blockReason, /policy decision and grant references/i);

  // `governance_evaluation_missing` — an unevaluated proposal authorizes nothing, and
  // "proposed" is this surface's word for that, never a canonical evaluation result.
  assert.equal(gates.unevaluated.hasEvaluation, false);
  assert.equal(gates.unevaluated.dispatchable, false);
  assert.match(gates.unevaluated.blockReason, /no persisted governance evaluation/i);

  for (const key of ["stale_evaluation", "cannot_commit", "missing_grant_evidence", "unevaluated", "expired"]) {
    assert.equal(gates[key].taskStage.actionable, false, `${key} must not offer task dispatch`);
    assert.equal(gates[key].taskStage.blockedReason, gates[key].blockReason,
      `${key}: the reason shown must be the same predicate the control is gated on`);
    assert.match(text(gates[key].rendered), /cannot become work|no longer valid|has expired/i);
  }
});

test("P2-12 M6c: a branch that cannot carry the chain does not block the recovery path", () => {
  // This is F2 seen through the other gates. A stale or non-committable Action can never
  // become a Task, so treating it as "still live" would leave the chain permanently stuck
  // exactly as an expired one did.
  const gates = harness.dispatchGates;
  for (const key of ["stale_evaluation", "cannot_commit", "missing_grant_evidence", "unevaluated", "expired"]) {
    assert.equal(gates[key].proposalStage.actionable, true, `${key} must still allow a replacement proposal`);
    assert.match(gates[key].proposalStage.label, /replacement/i);
  }
  // And the live one correctly does block it, so a replacement is never offered while an
  // Action can still legitimately proceed.
  assert.equal(gates.authorized.proposalStage.actionable, false);
});

test("P2-12 M6d: a lapsed authorization is never summarised as authorized", () => {
  const gates = harness.dispatchGates;
  assert.equal(gates.stale_evaluation.status.label, "Authorization stale");
  assert.equal(gates.stale_evaluation.status.tone, "danger");
  for (const key of ["stale_evaluation", "cannot_commit", "missing_grant_evidence", "unevaluated", "expired"]) {
    assert.doesNotMatch(gates[key].status.detail, /Action authorized —/,
      `${key} must not read as an authorization the server did not grant`);
    assert.equal(gates[key].status.tone, "danger", `${key} must not read as ordinary progress`);
  }
});

test("P2-12 M6e: the offered control and the stated reason come from one predicate", () => {
  // `dispatchable` is derived from `dispatchBlockReason`, and the task stage calls the
  // same function, so the two cannot drift into disagreeing about the same Action.
  assert.match(readModel, /dispatchable: dispatchBlockReason\(view\) === null/);
  assert.match(readModel, /else taskBlocked = dispatchBlockReason\(input\.action\);/);
  // The partial copy that checked only state, expiry and revocation is gone.
  assert.doesNotMatch(
    stripComments(readModel),
    /dispatchable:\s*isDispatchableGovernanceState\(governanceState\)/
  );
});

test("P2-12 M3c: new work revalidates governance; recording that work stopped does not", () => {
  // `dispatch_internal_task_execution` and the start/retry arms of
  // `transition_internal_task_execution` both call `p2_08_validate_execution_governance`,
  // which repeats the entire P2-07 gate. `block`, `fail` and `complete` do not.
  assert.deepEqual(harness.contract.governanceRevalidatedCommands, ["queue", "start", "retry"]);

  const lapsed = harness.lapsedMidFlight;
  for (const status of ["queued", "running", "blocked", "failed"]) {
    assert.equal(lapsed[status].actionExpired, true);
    const withheld = lapsed[status].transitionTable.filter((c) =>
      harness.contract.governanceRevalidatedCommands.includes(c));
    const kept = lapsed[status].transitionTable.filter((c) =>
      !harness.contract.governanceRevalidatedCommands.includes(c));
    for (const command of withheld) {
      assert.ok(!lapsed[status].offeredCommands.includes(command),
        `${status}: ${command} authorizes new work and must be withheld once the authorization lapsed`);
    }
    // The critical half: a PM whose grant expired mid-flight must still be able to record
    // that the work stopped, or the canonical execution is stranded.
    assert.deepEqual(lapsed[status].offeredCommands, kept,
      `${status}: every non-revalidating transition stays available`);
  }
  assert.deepEqual(lapsed.queued.offeredCommands, ["block", "fail"]);
  assert.deepEqual(lapsed.running.offeredCommands, ["block", "fail", "complete"]);
  assert.deepEqual(lapsed.blocked.offeredCommands, ["fail"]);
  // `failed` offers only `retry`, which revalidates — so nothing remains, and the reason
  // given must be the recoverable governance one, not "no further transition".
  assert.deepEqual(lapsed.failed.offeredCommands, []);
  assert.equal(lapsed.failed.stage.actionable, false);
  assert.match(lapsed.failed.stage.blockedReason, /authorization has expired/i);
  assert.doesNotMatch(lapsed.failed.stage.blockedReason, /no further transition/i);
});

test("P2-12 M3d: opening execution checks the Action's proposer, not just the dispatcher", () => {
  // `p2_08_validate_execution_governance` denies `governed_action_actor_mismatch` on the
  // ACTION's `proposed_by`. With no execution row yet there is no dispatcher to compare,
  // so a proposer check that only looked at `dispatched_by` would offer `queue` to anyone.
  const gate = harness.foreignProposerQueue;
  assert.equal(gate.proposedBy, "actor-someone-else");
  assert.equal(gate.taskStatus, "not_started");
  assert.deepEqual(gate.transitionTable, ["queue"], "the transition table alone would allow queue");
  assert.deepEqual(gate.offeredCommands, [], "but the actor gate withholds it");
  assert.equal(gate.stage.actionable, false);
  assert.match(gate.stage.blockedReason, /only the person who proposed this Material Action/i);
});

test("P2-12 M3e: the panel renders the read model's command list rather than its own", () => {
  assert.match(panel, /const commands = branch\.offeredCommands/);
  assert.doesNotMatch(stripComments(panel), /offeredExecutionCommands\(/);
  assert.match(readModel, /offeredCommands = offeredExecutionCommands\(\{ action, task, latestExecution, actorUserId \}\)/);
});

test("P2-12 M7c: completing by id must not change what a collection means", () => {
  // The windowed `execution_tasks` read is filtered to `source = 'governed_action'`, and
  // the service documents the collection as governed tasks only. A RAID task carrying the
  // same `sourceActionId` must therefore stay out of it, even though it matches the id.
  assert.equal(projection.governedTasksOnly.governedPresent, true);
  assert.equal(projection.governedTasksOnly.ungovernedExcluded, true,
    "an ungoverned task must not enter the summary through the by-id completion");
  assert.match(service, /linkedRows\("execution_tasks", "source_payload->>sourceActionId", actionIds, \["source_payload->>source", "governed_action"\]\)/);
});

test("P2-12 M7d: the union preserves the window's ordering, so 'newest' still means newest", () => {
  // Consumers read these collections as newest-first — the Material Action panel folds
  // evaluations into a map expecting the newest to win. Appending by-id rows in arbitrary
  // order would leave the shape identical while changing which governance state resolves
  // as current, which is a false statement about authority.
  assert.deepEqual(projection.evaluationOrder, ["eval-old-superseding", "eval-old"],
    "the later evaluation must lead, whatever order the Data API returned");
  assert.match(service, /const unionById = \(orderColumn: string/);
  assert.match(service, /unionById\("recorded_at", materialActionEvaluations\.data/);
  assert.match(service, /unionById\(\s*"persisted_at",\s*materialActions\.data/);
});

// ── N. Second review closure: findings raised against the review-closure head ─────────

test("P2-12 N1: a failed post-write refresh is not reported as a failed write", () => {
  // CANONICAL WRITE SUCCESS != POST-WRITE READ REFRESH SUCCESS.
  // The refresh is a separate request against a summary the write already committed to.
  assert.match(layout, /await runExecutionOperation\([^)]*\);\s*\n\s*setStaleSinceGeneration\(null\);\s*\n\s*try \{\s*\n\s*await mutateFlow\(\);\s*\n\s*\} catch \{\s*\n\s*setStaleSinceGeneration\(successGeneration\);/);
  // Only the write's own rejection propagates to the panel.
  assert.doesNotMatch(stripComments(layout), /await runExecutionOperation\([^)]*\);\s*\n\s*await mutateFlow\(\);/);
  // The condition is surfaced as a read-side status, never as an error role.
  assert.match(panel, /refreshFailedAfterWrite && \([\s\S]{0,200}role="status"/);
  assert.match(panel, /does not mean the operation failed/i);
});

test("P2-12 N1b: an acknowledged write does NOT retire the durable attempt", () => {
  // Retiring on the POST response alone would let a retry after a failed refresh mint a
  // fresh nonce and append a duplicate canonical row. Only persisted state retires it.
  assert.match(operationalData, /markSubmissionAcknowledged\(attemptKey\)/);
  assert.equal(
    (stripComments(operationalData).match(/clearSubmissionAttempt\(attemptKey\)/g) ?? []).length,
    0,
    "no code path may clear an attempt on the POST response alone"
  );
  assert.match(submissionAttempt, /export function markSubmissionAcknowledged/);
  // Both governed submissions behave the same way.
  assert.equal((operationalData.match(/markSubmissionAcknowledged\(attemptKey\)/g) ?? []).length, 2,
    "Material Action and Observation both acknowledge rather than retire");
  // Persisted state is still what retires them.
  assert.match(operationalData, /reconcileSubmissionAttemptsByKey\(ATTEMPT_KEY_PREFIX, actionKeys\)/);
  assert.match(operationalData, /reconcileSubmissionAttempt\(observationAttemptKey/);
});

test("P2-12 N2: eligible Evidence is selected by server predicate, not a recency window", () => {
  // Proof the regression bites: the 20-row recency window contains none of the eligible row.
  const e = projection.evidenceEligibility;
  assert.equal(e.recencyWindowHasEligible, false, "the older eligible row is outside the recency window");
  assert.equal(e.recencyWindowIds.length, 20, "and that window is full of newer ineligible rows");
  // And the fix holds: eligibility is applied server-side BEFORE the limit.
  assert.deepEqual(e.eligibleIds, ["ev-old"]);
  assert.deepEqual(e.optionIds, ["ev-old"], "so the PM can still cite it");
  // The surface must not read the presentation window for this.
  assert.match(operationalData, /data\?\.observationEligibleEvidence \?\? \[\]/);
  assert.doesNotMatch(stripComments(operationalData), /deriveEvidenceOptions[\s\S]{0,200}data\?\.evidence \?\? \[\]/);
  // Tenant/project scoping is still enforced on the eligibility query.
  assert.match(service, /from\("evidence_items"\)\.select\("\*"\)\s*\n\s*\.eq\("workspace_id", workspaceId\)\.eq\("project_id", projectId\)/);
});

test("P2-12 N3: Observation quality is part of submission identity", () => {
  // P2-09 persists confidence_score and missing_data_state NOT NULL, but its replay check
  // compares only outcome/state/summary/evidence — so a quality-only retry would be
  // acknowledged as a replay while the corrected values were silently dropped.
  const i = harness.idempotency;
  assert.equal(i.differsOnConfidence, true, "changed confidence is a new submission identity");
  assert.equal(i.differsOnMissingData, true, "changed missing-data state is a new submission identity");
  // But a numerically identical confidence is the same value, not a new identity.
  assert.equal(i.confidenceFormatStable, true, "0.4 and 0.4000 are one value");
  // Established normalizations are unchanged.
  assert.equal(i.stable, true);
  assert.equal(i.reorderedEvidence, true, "evidence order alone does not change identity");
  assert.equal(i.whitespaceNormalised, true);
  // observedAt/evaluatedAt must NOT be in identity — they move every attempt.
  assert.doesNotMatch(stripComments(readModel), /canonicalObservationPayload[\s\S]{0,400}observedAt/);
  assert.match(operationalData, /confidenceScore: operation\.quality\.confidenceScore,\n\s*missingDataState: operation\.quality\.missingDataState,\n\s*attemptNonce/);
});

test("P2-12 N4: opening one drawer clears the others", () => {
  // `activeDrawer` resolves openChainId first, so any handler leaving it set would mask
  // the newest click and the drawer would look unresponsive.
  assert.match(layout, /const selectDrawer = \(next: \{ chainId\?[\s\S]{0,320}setOpenChainId\(next\.chainId \?\? null\);\s*\n\s*setOpenAttentionId\(next\.attentionId \?\? null\);\s*\n\s*setDrawerContent\(next\.content \?\? null\);/);
  // Every selection path goes through it — no handler sets these directly any more.
  const body = stripComments(layout).replace(/const selectDrawer[\s\S]*?\n  \};/, "");
  for (const setter of ["setOpenChainId", "setOpenAttentionId", "setDrawerContent"]) {
    const direct = (body.match(new RegExp(`${setter}\\(`, "g")) ?? []).length;
    assert.equal(direct, 0, `${setter} must only be called inside selectDrawer`);
  }
  for (const handler of ["handleNeedsYouSelect", "handleChainSelect", "handleAgentSelect", "handleSourceClick", "handleTopBarSourceClick", "closeDrawer"]) {
    assert.match(layout, new RegExp(`${handler}[\\s\\S]{0,260}selectDrawer\\(`), `${handler} must route through selectDrawer`);
  }
});

test("P2-12 N5: the governance window is server time, never the browser clock", () => {
  // `expires_at` is enforced against database now(). A device two hours behind would
  // persist already-expired authorizations; one two hours ahead would extend the grant.
  assert.doesNotMatch(stripComments(operationalData), /createdAt:|evaluationTime:|expiresAt:/);
  assert.doesNotMatch(stripComments(route), /createdAt: String\(body\.createdAt/);
  assert.doesNotMatch(stripComments(route), /expiresAt: String\(body\.expiresAt/);
  assert.doesNotMatch(stripComments(route), /evaluationTime: String\(body\.evaluationTime[\s\S]{0,80}proposeGoverned/);
  // The server owns the window and its length.
  assert.match(service, /export const MATERIAL_ACTION_WINDOW_MS = 60 \* 60 \* 1000;/);
  assert.match(service, /async function resolveMaterialActionWindow/);
  assert.match(service, /expiresAt: new Date\(now\.getTime\(\) \+ MATERIAL_ACTION_WINDOW_MS\)/);
  // F1 is preserved: a retry reuses the PERSISTED window so the digest still matches.
  assert.match(service, /\.from\("material_action_proposals"\)\s*\n\s*\.select\("created_at,expires_at"\)/);
  assert.match(service, /return \{ createdAt: persistedCreatedAt, evaluationTime: now, expiresAt: persistedExpiresAt \};/);
  // The client constant that remains is a retry window, not authority.
  assert.match(readModel, /MATERIAL_ACTION_ATTEMPT_WINDOW_MS/);
  assert.match(readModel, /carries no governance authority/i);
});

test("P2-12 N5b: the server derives the window, and a retry reuses the persisted one", () => {
  // Runs the REAL proposeGovernedMaterialAction. Browser clock skew cannot reach the
  // window at all, because the client sends no timestamp for it to skew — the structural
  // proof is N5's assertions above; this proves what the server then does.
  const w = projection.materialActionWindow;
  assert.equal(w.createdAtWithinServerCall, true, "createdAt is the server clock at call time");
  assert.equal(w.windowMs, 60 * 60 * 1000, "exactly the one-hour grant, whatever any client thinks");
  // F1 preserved: a retry reuses the PERSISTED window verbatim, so the digest matches and
  // the replay reconciles instead of raising material_action_idempotency_conflict.
  assert.equal(w.replayReusesPersistedWindow, true);
  assert.equal(w.replayCreatedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(w.replayExpiresAt, "2026-03-01T01:00:00.000Z");
  assert.match(w.replayDigest, /^[a-f0-9]{64}$/);
});

test("P2-12 N6: a superseded Outcome is not observable", () => {
  // `record_canonical_outcome_observation` raises `canonical_outcome_superseded`.
  const s = harness.supersededOutcome;
  assert.equal(s.outcomeState, "superseded");
  assert.equal(s.observationStage.actionable, false);
  assert.match(s.observationStage.blockedReason, /superseded/i);
  // History is preserved, not deleted.
  assert.equal(s.existingObservations, 1);
  assert.match(text(s.rendered), /no longer the current Outcome to observe/i);

  // It is the ONLY refused state; every other canonical state stays observable.
  const states = harness.observableOutcomeStates;
  for (const state of ["expected", "observing", "achieved", "partially_achieved", "not_achieved", "disputed", "inconclusive"]) {
    assert.equal(states[state].actionable, true, `${state} must remain observable`);
    assert.equal(states[state].blockedReason, null);
  }
  assert.equal(states.superseded.actionable, false);
});

test("P2-12 N7: a stranded Task does not block replacement authorization", () => {
  // Liveness is reachability of a completed execution over the canonical matrix, not
  // `task != null`. With authorization lapsed, queue/start/retry are withdrawn.
  const b = harness.strandedBranches;

  for (const state of ["no_execution_not_started", "queued", "blocked", "failed"]) {
    assert.equal(b[state].taskExists, true, `${state}: a Task exists`);
    assert.equal(b[state].actionExpired, true);
    assert.equal(b[state].live, false, `${state}: cannot reach a completed execution, so it is stranded`);
    assert.equal(b[state].proposalActionable, true, `${state}: replacement authorization must open`);
    assert.match(b[state].proposalLabel, /replacement/i);
  }
  // A running execution can still `complete`; a completed one already opens the Outcome
  // path. Neither is stranded merely because the Action authorization expired.
  for (const state of ["running", "completed"]) {
    assert.equal(b[state].live, true, `${state}: still has a canonical way forward`);
    assert.equal(b[state].proposalActionable, false, `${state}: no replacement needed`);
  }
  // `block`/`fail` survive revalidation but do not make a branch live.
  assert.deepEqual(b.queued.offeredCommands, ["block", "fail"]);
  assert.deepEqual(b.blocked.offeredCommands, ["fail"]);
  assert.deepEqual(b.failed.offeredCommands, []);
  assert.deepEqual(b.running.offeredCommands, ["block", "fail", "complete"]);

  // With authorization VALID, none of those states is stranded and no replacement opens.
  for (const state of ["queued", "blocked", "failed"]) {
    assert.equal(harness.liveBranches[state].live, true, `${state} with valid auth is live`);
    assert.equal(harness.liveBranches[state].proposalActionable, false,
      `${state} with valid auth must not offer a duplicate replacement`);
  }
  // History is never rewritten to recover.
  assert.doesNotMatch(stripComments(readModel), /governanceState = "authorized"/);

  // The underlying matrix walk, independent of any fixture.
  const r = harness.reachability;
  for (const state of ["none", "queued", "running", "blocked", "failed", "completed"]) {
    assert.equal(r[`${state}_auth_valid`], true, `${state}: with authorization, completed is reachable`);
  }
  assert.deepEqual(
    ["none", "queued", "running", "blocked", "failed", "completed"].map((s) => r[`${s}_auth_invalid`]),
    [false, false, true, false, false, true],
    "without authorization only running and completed can still reach a completed execution"
  );
});

test("P2-12 N8: simultaneous ExecutionQueue instances have distinct heading ids", () => {
  const html = harness.duplicateQueueRender;
  const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
  const labelled = [...html.matchAll(/<section aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2, "both instances render a heading");
  assert.equal(new Set(ids).size, 2, "and their ids are distinct");
  assert.deepEqual(labelled, ids, "each section points at its own heading, in order");
  assert.doesNotMatch(html, /execution-chain-heading/);
  assert.match(queueSource, /const headingId = useId\(\)/);
});

// ── T. Third review closure ──────────────────────────────────────────────────────────

test("P2-12 T1: a superseded Outcome is terminal, not 'in progress', not reauthorizable", () => {
  // The schema makes supersession a dead end, not a hand-off:
  // `canonical_task_outcomes_one_per_task` is UNIQUE (workspace, project, task), so no
  // replacement Outcome for the Task can exist. And NO code path in any migration or in
  // src/ ever writes state='superseded' — it appears only in the CHECK enum and in the
  // observation guard. There is therefore no canonical transition out of it.
  const s = harness.supersededTerminal;
  assert.equal(s.live, false, "no operation can advance the branch, so it is not live");
  assert.equal(s.observationStage.actionable, false);
  assert.equal(s.status.label, "Outcome superseded");
  assert.match(s.status.detail, /no governed operation continues from it/i);
  assert.notEqual(s.status.label, "In progress");
  const queue = chainRows(s.queue);
  assert.match(queue, /Outcome superseded/);
  assert.doesNotMatch(queue, /In progress/i);

  // Crucially: NOT treated as a stranded authorization. Reauthorizing cannot revive a
  // dead-ended Outcome, and the contract defines no superseded -> Material Action step.
  assert.equal(s.proposalStage.actionable, false, "replacement authorization must NOT open");
  assert.match(s.proposalStage.blockedReason, /terminal state for the Outcome/i);
  // History is preserved.
  assert.equal(s.observationsPreserved, 1);

  // A current Outcome is unaffected.
  assert.equal(harness.activeOutcomeLive.live, true);
  assert.notEqual(harness.activeOutcomeLive.status.label, "Outcome superseded");
});

test("P2-12 T2: evaluation selection matches the server's two-column ordering", () => {
  // `order by evaluated_at desc, recorded_at desc`. Collapsing that to one column made
  // tied evaluation instants compare equal, so iteration order decided — and since the
  // summary arrives newest-first, the OLDER row won.
  const e = harness.evaluationTieBreak;
  assert.equal(e.tied, "revoked", "same evaluated_at: the later recorded_at wins");
  assert.equal(e.tiedReversed, "revoked", "and the answer does not depend on arrival order");
  assert.equal(e.distinct, "authorized", "different evaluated_at: the primary key decides");
  // The consequence that mattered: a newer revocation is not projected as authorization.
  assert.equal(e.tiedDispatchable, false);
  assert.match(readModel, /function compareEvaluations/);
  assert.match(readModel, /if \(aEvaluated !== bEvaluated\) return aEvaluated - bEvaluated;/);
  assert.match(readModel, /compareEvaluations\(evaluation, previous\) > 0/);
});

test("P2-12 T3: an edited expected-Outcome retry conflicts instead of reporting success", () => {
  // `ensure_expected_task_outcome` returns the persisted Outcome for ANY request against
  // that Task, comparing nothing, and the route maps that to HTTP 200. Discarding the body
  // made an edited retry look successful while storage kept the original wording.
  assert.match(operationalData, /assertExpectedOutcomeReconciles\(result, \{/);
  assert.match(operationalData, /const result = await postOperationalFlow\(workspaceId, projectId, \{\s*\n\s*operation: "ensure_expected_outcome"/);
  // Only persisted, contract-defined fields are compared.
  for (const field of ["task_id", "expected_result", "success_criteria", "correlation_id"]) {
    assert.match(operationalData, new RegExp(`outcome\\.${field}`), `${field} participates in reconciliation`);
  }
  // Nothing is overwritten — P2-09 defines no supersession operation for an Outcome.
  assert.doesNotMatch(stripComments(operationalData), /update_expected_outcome|overwriteOutcome/);
  assert.match(operationalData, /It was not changed — an Outcome cannot be rewritten once persisted/);
});

test("P2-12 T4: the stale-refresh warning clears on a confirmed later revalidation", () => {
  // SWR's interval and focus revalidation recover on their own; a warning that outlives
  // the problem is its own inaccuracy. It must not clear on a mere re-render, so the
  // signal is SWR's onSuccess, not isValidating or a data identity check.
  assert.match(operationalData, /onSuccess: \(\) => \{\s*\n\s*setSuccessGeneration\(\(generation\) => generation \+ 1\);/);
  assert.match(operationalData, /return \{ \.\.\.result, successGeneration \};/);
  assert.match(layout, /const refreshFailedAfterWrite = staleSinceGeneration !== null && successGeneration <= staleSinceGeneration;/);
  // Recorded at the moment of failure, so only a LATER success retires it.
  assert.match(layout, /catch \{\s*\n\s*setStaleSinceGeneration\(successGeneration\);/);
  assert.doesNotMatch(stripComments(layout), /isValidating/);
});

test("P2-12 T5: a concurrent retry of the same submission replays instead of conflicting", () => {
  // The advisory lock lives inside the RPC, so two requests can both miss the pre-flight
  // window lookup, derive different `now` values, and produce different digests.
  const c = projection.concurrency;
  assert.equal(c.firstDisposition, "created");
  assert.equal(c.concurrentRetryDisposition, "replay", "the loser of the race reconciles, not conflicts");
  assert.equal(c.rowUnchangedByRecovery, true, "recovery never rewrites the committed row");
  // Idempotency conflict semantics are NOT weakened.
  assert.equal(c.differentIntentDisposition, "conflict",
    "same key + genuinely different intent must still conflict");
  // Recovery compares the contract's own digest with only the server timestamps normalized.
  assert.match(service, /if \(reconciled\.deterministicDigest === row\.proposal_digest\)/);
  assert.match(service, /\.eq\("workspace_id", scope\.workspaceId\)\s*\n\s*\.eq\("project_id", scope\.projectId\)\s*\n\s*\.eq\("idempotency_key", input\.idempotencyKey\)/);
  // Bounded: exactly one recovery attempt, never a loop.
  assert.doesNotMatch(stripComments(service), /while[\s\S]{0,120}persist_governed_material_action/);
  assert.equal((stripComments(service).match(/^\s*data = await persist\(/gm) ?? []).length, 1,
    "exactly one recovery attempt");
  assert.match(service, /Exactly one recovery attempt, never a loop/);
});

test("P2-12 T6: deadline-driven gates recompute without any row changing", () => {
  // Action expiry, evaluation staleness and Evidence stale_at are clock-driven; nothing in
  // the database moves when one passes, and SWR keeps the previous object on a deep-equal
  // refetch, so memos keyed only on flowData never rerun.
  assert.match(operationalData, /export function nextProjectionDeadline/);
  assert.match(operationalData, /consider\(branch\.action\.expiresAt\);/);
  assert.match(operationalData, /consider\(branch\.action\.validUntil\);/);
  assert.match(operationalData, /consider\(typeof row\.stale_at === "string" \? row\.stale_at : null\);/);
  // One wake-up per deadline — not a polling loop.
  assert.match(layout, /const timer = setTimeout\(\(\) => setProjectionFloor\(next \+ 1000\), delay\);/);
  assert.match(layout, /if \(next === null\) return;/);
  assert.doesNotMatch(stripComments(layout), /setInterval/);
  // The projections take that clock.
  assert.match(layout, /deriveExecutionChains\(flowData, projectionNow\)/);
  assert.match(layout, /deriveEvidenceOptions\(flowData, projectionNow\)/);
  // Anchored on SERVER time, and explicitly not authorization authority.
  assert.match(service, /generatedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(layout, /Date\.parse\(flowData\.generatedAt\)/);
  // The projection adopts the SERVER-side deadline instant; the local clock only decides
  // when to recompute. Render itself reads no clock.
  assert.match(layout, /never what it concludes/);
  assert.match(layout, /No clock is read during render/);
});

test("P2-12 T7: linked reads are chunked and paged, and reconstruct the whole chain", () => {
  // The 30-Decision root window bounds Decisions, not the rows beneath them:
  // `source_decision_id` has no unique constraint, which is F9's own premise.
  const f = projection.largeFanout;
  assert.equal(f.fanout, 120);
  assert.ok(f.maxIdsInOneFilter <= 50, `no single .in() may carry the fan-out (was ${f.maxIdsInOneFilter})`);
  assert.ok(f.idFilteredRequestCount > 6, "the fan-out genuinely required multiple bounded requests");
  // Nothing is lost and nothing is duplicated.
  for (const level of ["actions", "evaluations", "tasks", "executions", "outcomes"]) {
    assert.equal(f[level], 120, `${level}: every linked row survives chunking`);
  }
  assert.equal(f.uniqueActions, 120, "no duplication across chunks");
  // Paged, so a PostgREST row cap cannot silently truncate — the false absence F7 fixed.
  assert.match(service, /\.range\(offset, offset \+ ROW_PAGE_SIZE - 1\)/);
  assert.match(service, /if \(page\.length < ROW_PAGE_SIZE\) break;/);
  // Tenant, project and domain filters survive chunking.
  assert.match(service, /\.eq\("workspace_id", workspaceId\)\.eq\("project_id", projectId\);/);
  assert.match(service, /match \? scoped\.eq\(match\[0\], match\[1\]\) : scoped/);
});
