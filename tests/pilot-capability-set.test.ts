/**
 * Pilot Gate Sprint 01 — Task 7 (pilot capability set).
 *
 * Pins the curated pilot surface: hidden modules stay out of the pilot
 * navigation rail at every reveal stage/plan, while the founder profile
 * keeps full visibility. See docs/release/pilot-capability-set.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PILOT_HIDDEN_HREFS,
  isHiddenForProfile,
  resolveCapabilityProfile,
} from "../src/lib/workspace/pilot-capability-set";
import {
  computeCapabilityRevealState,
  computeNavigationRail,
} from "../src/features/runtime/capability-reveal/capability-reveal-selectors";
import { NAVIGATION_HIERARCHY } from "../src/lib/workspace/navigation-hierarchy";

// The most permissive reveal state achievable: pmo plan, owner role, full
// evidence/continuity — every domain unlocks.
const MAX_REVEAL_INPUT = {
  planTier: "pmo",
  role: "owner",
  onboardingCompleted: true,
  hasProject: true,
  firstRun: false,
  evidenceSignals: 10,
  operationalMemorySignals: 10,
  continuitySignals: 10,
  canUseAdvancedAi: true,
  canUsePortfolioMemory: true,
  canUseGovernanceDirectives: true,
} as never;

test("pilot profile hides every curated href even at maximum unlock", () => {
  const state = computeCapabilityRevealState(MAX_REVEAL_INPUT);
  const hrefs = computeNavigationRail(state, "pilot").map((item) => item.href);
  for (const hidden of PILOT_HIDDEN_HREFS) {
    assert.ok(!hrefs.includes(hidden), `pilot navigation exposes hidden surface: ${hidden}`);
  }
});

test("pilot profile keeps the real product surface visible", () => {
  const state = computeCapabilityRevealState(MAX_REVEAL_INPUT);
  const hrefs = computeNavigationRail(state, "pilot").map((item) => item.href);
  // /chat and /dashboard left this list with W1: they are navigation-hidden for EVERY
  // profile as duplicate product surfaces (chat is the copilot layer, /dashboard a second
  // home competing with Command Center), not hidden by the pilot capability set. Asserting
  // them here would make this test pass for a reason it does not own.
  for (const required of ["/workspaces", "/pmos", "/command-center", "/projects", "/execution", "/portfolio", "/upload", "/operational-memory", "/follow-up-dashboard"]) {
    assert.ok(hrefs.includes(required), `pilot navigation lost a real surface: ${required}`);
  }
});

test("the navigation-hidden duplicates are hidden by the hierarchy, not by the pilot profile", () => {
  // Proves the mechanism, so a later change cannot quietly re-expose them by flipping a
  // profile: they are absent from the hierarchy entirely, for founder and pilot alike.
  const allHrefs = NAVIGATION_HIERARCHY.map((node) => node.href);
  for (const hidden of ["/chat", "/dashboard", "/projects/new"]) {
    assert.ok(!allHrefs.includes(hidden), `${hidden} must not be a navigation destination`);
    assert.equal(isHiddenForProfile(hidden, "pilot"), false, `${hidden} is not a pilot-profile concern`);
  }
});

test("founder profile retains full navigation", () => {
  const state = computeCapabilityRevealState(MAX_REVEAL_INPUT);
  const hrefs = computeNavigationRail(state, "founder").map((item) => item.href);
  for (const hidden of ["/governance", "/policies", "/audit"]) {
    assert.ok(hrefs.includes(hidden), `founder navigation must keep: ${hidden}`);
  }
});

test("default profile is pilot (safe default when no profile is passed)", () => {
  const state = computeCapabilityRevealState(MAX_REVEAL_INPUT);
  const defaultHrefs = computeNavigationRail(state).map((item) => item.href);
  assert.ok(!defaultHrefs.includes("/governance"), "omitting the profile must not expose hidden surfaces");
});

test("profile resolution: founder/internal user → founder; partner → pilot; env override wins", () => {
  assert.equal(resolveCapabilityProfile({ isFounderOrInternal: true, env: {} as NodeJS.ProcessEnv }), "founder");
  assert.equal(resolveCapabilityProfile({ isFounderOrInternal: false, env: {} as NodeJS.ProcessEnv }), "pilot");
  assert.equal(
    resolveCapabilityProfile({ isFounderOrInternal: false, env: { PMFREAK_CAPABILITY_PROFILE: "founder" } as unknown as NodeJS.ProcessEnv }),
    "founder",
  );
});

test("every hidden href exists in the navigation hierarchy (no dead entries in the hidden list)", () => {
  const allHrefs = NAVIGATION_HIERARCHY.map((node) => node.href);
  for (const hidden of PILOT_HIDDEN_HREFS) {
    assert.ok(allHrefs.includes(hidden), `PILOT_HIDDEN_HREFS entry not in NAVIGATION_HIERARCHY: ${hidden}`);
  }
});

test("isHiddenForProfile: founder sees everything", () => {
  for (const hidden of PILOT_HIDDEN_HREFS) {
    assert.equal(isHiddenForProfile(hidden, "founder"), false);
    assert.equal(isHiddenForProfile(hidden, "pilot"), true);
  }
});
