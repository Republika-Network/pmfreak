import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const profile = read("src/lib/workspace/operational-imprint-profile.ts");
const inference = read("src/lib/workspace/imprint-inference.ts");
const confidence = read("src/lib/workspace/imprint-confidence.ts");
const panel = read("src/components/pmfreak/workspace/agent-awakening-panel.tsx");
const shell = read("src/components/pmfreak/workspace/workspace-conversation-shell.tsx");
const workspaceShell = read("src/components/pmfreak/workspace/workspace-shell.tsx");
const imprintSummary = read("src/components/pmfreak/workspace/imprint-summary.tsx");
const opShell = read("src/components/pmfreak/operational-shell.tsx");

// ─── 1. Imprint initializes empty ────────────────────────────────────────────

test("PMOperationalImprint type is exported", () => {
  assert.match(profile, /export type PMOperationalImprint/);
});

test("empty profile has zero observedInteractionCount", () => {
  assert.match(profile, /observedInteractionCount: 0/);
});

test("emptyImprintState is exported", () => {
  assert.match(profile, /export function emptyImprintState/);
});

test("PMImprintState type includes profile and scores", () => {
  assert.match(profile, /profile: PMOperationalImprint/);
  assert.match(profile, /scores: ImprintScores/);
});

// ─── 2. Signals infer deterministic tendencies ────────────────────────────────

test("observeInteraction is exported from inference module", () => {
  assert.match(inference, /export function observeInteraction/);
});

test("diplomatic signals are wired", () => {
  assert.match(inference, /diplomatic/);
  assert.match(inference, /stakeholder buy-in.*diplomatic/s);
});

test("delivery focus signals are wired", () => {
  assert.match(inference, /"dependency".*"delivery"/s);
  assert.match(inference, /"milestone".*"delivery"/s);
});

test("preventive escalation signals are wired", () => {
  assert.match(inference, /"preventive"/);
  assert.match(inference, /early warning.*preventive/s);
});

test("communication pattern inference handles concise messages", () => {
  assert.match(inference, /trimmed\.length < 60/);
  assert.match(inference, /"concise"/);
});

test("communication pattern inference handles context-heavy messages", () => {
  assert.match(inference, /trimmed\.length > 200/);
  assert.match(inference, /"context-heavy"/);
});

test("scores accumulate across observations — mergeScores is defined", () => {
  assert.match(inference, /function mergeScores/);
  assert.match(inference, /merged\[k\] = \(merged\[k\] \?\? 0\) \+ v/);
});

test("leadingCandidate is deterministic — highest score wins", () => {
  assert.match(inference, /function leadingCandidate/);
  assert.match(inference, /if \(score > bestScore\)/);
});

// ─── 3. Imprint persists correctly ───────────────────────────────────────────

test("loadImprintState is exported", () => {
  assert.match(profile, /export function loadImprintState/);
});

test("persistImprintState is exported", () => {
  assert.match(profile, /export function persistImprintState/);
});

test("resetImprintState is exported", () => {
  assert.match(profile, /export function resetImprintState/);
});

test("storage key is scoped by companyId, workspaceId, userId", () => {
  assert.match(profile, /pmfreak\.imprint/);
  assert.match(profile, /companyId.*workspaceId.*userId/s);
});

test("conversation shell loads imprint on mount", () => {
  assert.match(shell, /loadImprintState/);
  assert.match(shell, /IMPRINT_COMPANY_ID/);
  assert.match(shell, /IMPRINT_WORKSPACE_ID/);
  assert.match(shell, /IMPRINT_USER_ID/);
});

test("conversation shell persists imprint after interaction", () => {
  assert.match(shell, /persistImprintState/);
  assert.match(shell, /observeInteraction/);
});

// ─── 4. Clarifying questions adapt by imprint ────────────────────────────────

test("computeAdaptiveClarifyingQuestion is exported", () => {
  assert.match(inference, /export function computeAdaptiveClarifyingQuestion/);
});

test("delivery-focused PM gets execution-first clarifier", () => {
  assert.match(inference, /What dependency is constraining execution first/);
});

test("stakeholder-focused PM gets alignment clarifier", () => {
  assert.match(inference, /Which alignment relationship is creating delivery drag/);
});

test("governance-focused PM gets control boundary clarifier", () => {
  assert.match(inference, /Which control boundary is currently unclear/);
});

test("conversation shell uses adaptive clarifying question", () => {
  assert.match(shell, /computeAdaptiveClarifyingQuestion/);
});

// ─── 5. Prompt starters adapt ────────────────────────────────────────────────

test("computeIgnitionCues is exported", () => {
  assert.match(inference, /export function computeIgnitionCues/);
});

test("delivery-adapted ignition cue exists", () => {
  assert.match(inference, /A dependency shift is affecting milestone execution/);
});

test("stakeholder-adapted ignition cue exists", () => {
  assert.match(inference, /A relationship misalignment is slowing delivery/);
});

test("governance-adapted ignition cue exists", () => {
  assert.match(inference, /A scope control boundary needs clarification/);
});

test("conversation shell uses dynamic ignitionCues", () => {
  assert.match(shell, /computeIgnitionCues/);
  assert.match(shell, /ignitionCues\.map/);
});

// ─── 6. Lens prioritization adapts ───────────────────────────────────────────

// These four tests asserted that the imprint profile reordered the navigation "lens" rail
// (stakeholder-heavy → Executive first, delivery-heavy → Command Center first, sorted via
// `lensOrder.indexOf`). W1 retired the lens rail: navigation order is now the fixed product
// hierarchy, which is the point of having one — an order that rearranges itself under the
// user is not a hierarchy they can learn.
//
// No behaviour was lost. The sorted rail was ALREADY inert before W1: the shell computed
// `sortedLensNav` and then rendered `lensNav`, so the imprint ordering never reached a
// screen. These assertions were passing on dead code.
//
// The imprint profile itself is untouched — every other test in this file still exercises
// it. What is asserted here now is that it no longer reorders navigation.

test("navigation order is the fixed product hierarchy, not an imprint-derived one", () => {
  const hierarchy = read("src/lib/workspace/navigation-hierarchy.ts");
  const primary = [...hierarchy.matchAll(/label: "([^"]+)", href: "([^"]+)", tier: "primary"/g)].map((m) => m[1]);
  assert.deepEqual(primary, ["Command Center", "Projects", "Execution", "Portfolio"]);
});

test("the operational shell no longer reorders navigation from the imprint profile", () => {
  assert.doesNotMatch(opShell, /lensOrder/);
  assert.doesNotMatch(opShell, /sortedLensNav/);
  // And the now-unused import went with it rather than lingering as dead code.
  assert.doesNotMatch(opShell, /loadImprintState/);
});

// ─── 7. Confidence progresses correctly ──────────────────────────────────────

test("ImprintConfidence type covers all four levels", () => {
  assert.match(confidence, /"forming"/);
  assert.match(confidence, /"emerging"/);
  assert.match(confidence, /"stable"/);
  assert.match(confidence, /"deep"/);
});

test("confidence thresholds are deterministic and monotonic", () => {
  assert.match(confidence, /forming: 0/);
  assert.match(confidence, /emerging: 3/);
  assert.match(confidence, /stable: 6/);
  assert.match(confidence, /deep: 10/);
});

test("computeImprintConfidence is exported", () => {
  assert.match(confidence, /export function computeImprintConfidence/);
});

test("CONFIDENCE_CHIP_LABELS covers all levels", () => {
  assert.match(confidence, /Pattern forming/);
  assert.match(confidence, /Cadence emerging/);
  assert.match(confidence, /Operational cadence recognized/);
  assert.match(confidence, /Continuity established/);
});

test("deriveImprintReflection is exported", () => {
  assert.match(confidence, /export function deriveImprintReflection/);
});

// ─── 8. Reset clears profile ─────────────────────────────────────────────────

test("reset mechanism removes localStorage entry", () => {
  assert.match(profile, /localStorage\.removeItem/);
});

test("imprint summary has Reset Operational Imprint button", () => {
  assert.match(imprintSummary, /Reset Operational Imprint/);
});

test("conversation shell wires reset to emptyImprintState", () => {
  assert.match(shell, /emptyImprintState/);
  assert.match(shell, /onReset.*setImprintState/s);
});

// ─── 9. Imprint reflection appears only after maturity ───────────────────────

test("agent panel accepts imprintProfile and imprintConfidence props", () => {
  assert.match(panel, /imprintProfile\?: PMOperationalImprint/);
  assert.match(panel, /imprintConfidence\?: ImprintConfidence/);
});

test("agent panel calls deriveImprintReflection", () => {
  assert.match(panel, /deriveImprintReflection/);
});

test("agent panel only renders reflection when non-null", () => {
  assert.match(panel, /reflection \? \(/);
});

test("imprint summary hidden when confidence is forming or emerging", () => {
  assert.match(imprintSummary, /confidence === "forming" \|\| confidence === "emerging"/);
  assert.match(imprintSummary, /return null/);
});

test("workspace shell shows imprint chip only when confidence is not forming", () => {
  assert.match(workspaceShell, /showImprintChip/);
  assert.match(workspaceShell, /CONFIDENCE_CHIP_LABELS/);
});
