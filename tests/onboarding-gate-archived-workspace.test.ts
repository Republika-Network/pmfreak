import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldRedirectForOnboarding } from "../src/lib/auth/onboarding-gate";
import { hasWorkspaceAccess } from "../src/lib/auth/onboarding-route-map";
import type { OnboardingState } from "../src/lib/auth/resolve-onboarding-state";

const ALL_STATES: OnboardingState[] = [
  "no_workspace",
  "needs_project",
  "needs_task",
  "execution_started",
  "active",
  "trial_blocked",
];

const layout = readFileSync("src/app/(protected)/layout.tsx", "utf8");
const canonicalRoute = readFileSync("src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx", "utf8");

// ─── The interaction the source-text tests could not see ──────────────────
//
// Two individually-correct changes composed into a defect: the layout began
// deriving workspace context from the canonical route, and an archived workspace
// with no non-archived projects derives "needs_project" — which redirected to
// /projects/new, so the archived read-only page never rendered. 3892 focused
// tests and a 14010-test suite all passed. These assert the composed behaviour.

test("an archived routed workspace with no projects is NOT redirected away", () => {
  // The exact defect. Before the exemption this returned true and the archived
  // Command Center was unreachable.
  assert.equal(
    shouldRedirectForOnboarding({ state: "needs_project", routedWorkspaceArchived: true }),
    false,
  );
});

test("the zero-project archived case the page writes copy for is reachable", () => {
  // The page renders "This workspace had no projects when it was archived" for
  // exactly the state that used to trigger the redirect, so that string was
  // dead code. Assert both halves together: the copy exists AND the gate lets
  // the render happen.
  assert.match(canonicalRoute, /This workspace had no projects when it was archived/);
  assert.equal(shouldRedirectForOnboarding({ state: "needs_project", routedWorkspaceArchived: true }), false);
});

test("an ACTIVE workspace needing a project still redirects, exactly as before", () => {
  assert.equal(
    shouldRedirectForOnboarding({ state: "needs_project", routedWorkspaceArchived: false }),
    true,
  );
});

test("archival never bypasses the trial entitlement gate", () => {
  // The exemption must not become a billing bypass: an archived URL is a
  // read-only viewing affordance, not an entitlement.
  assert.equal(shouldRedirectForOnboarding({ state: "trial_blocked", routedWorkspaceArchived: true }), true);
  assert.equal(shouldRedirectForOnboarding({ state: "trial_blocked", routedWorkspaceArchived: false }), true);
});

test("archival never invents access where no workspace resolved", () => {
  assert.equal(shouldRedirectForOnboarding({ state: "no_workspace", routedWorkspaceArchived: true }), true);
});

test("for every NON-archived render the gate is identical to the previous rule", () => {
  // "Active workspace onboarding behavior must remain unchanged", asserted
  // exhaustively rather than by inspection: for every state, the new function
  // agrees with the hasWorkspaceAccess test it replaced.
  for (const state of ALL_STATES) {
    assert.equal(
      shouldRedirectForOnboarding({ state, routedWorkspaceArchived: false }),
      !hasWorkspaceAccess(state),
      `non-archived behaviour changed for "${state}"`,
    );
  }
});

test("the exemption applies to exactly one state, and no other", () => {
  // Anything broader would be exempting states nobody analysed.
  const exempted = ALL_STATES.filter(
    (state) =>
      shouldRedirectForOnboarding({ state, routedWorkspaceArchived: true }) !==
      shouldRedirectForOnboarding({ state, routedWorkspaceArchived: false }),
  );
  assert.deepEqual(exempted, ["needs_project"]);
});

// ─── Skipping the gate must not enable anything ───────────────────────────

test("skipping the gate enables no mutation affordance on the archived page", () => {
  // The archived branch withholds mutations on its own, independently of how the
  // request reached it — so the exemption changes reachability, not capability.
  const archivedBlock = canonicalRoute.slice(
    canonicalRoute.indexOf("if (isArchived)"),
    canonicalRoute.indexOf("if ((projects ?? []).length === 0)"),
  );
  assert.ok(archivedBlock.length > 0);
  assert.doesNotMatch(archivedBlock, /CommandCenterClient/);
  assert.doesNotMatch(archivedBlock, /activateContextAction/);
  assert.doesNotMatch(archivedBlock, /<form/);
});

test("the archived read-only render is driven by authorization, not by the gate", () => {
  // isArchived comes from resolveRoutedWorkspace, so a request that skipped the
  // onboarding redirect still cannot render the writable screen.
  assert.match(canonicalRoute, /const isArchived = workspaceAccess\.access === "archived"/);
  assert.match(canonicalRoute, /if \(isArchived\)/);
});

// ─── The layout actually uses it ──────────────────────────────────────────

test("the layout gates through the pure function, not the bare access test", () => {
  assert.match(layout, /shouldRedirectForOnboarding\(\{ state: onboardingState, routedWorkspaceArchived, routedProjectArchived \}\)/);
  assert.match(layout, /const routedWorkspaceArchived = routedAccess\?\.access === "archived"/);
});

test("archival is only ever derived from an AUTHORIZED routed workspace", () => {
  // routedAccess is resolveRoutedWorkspace's output, so a URL naming someone
  // else's archived workspace resolves to "denied" and never sets this flag.
  assert.match(layout, /resolveRoutedWorkspace\(user\.id, routedWorkspaceId\)/);
  const flagLine = layout.split("\n").find((l) => l.includes("routedWorkspaceArchived ="));
  assert.ok(flagLine && flagLine.includes("routedAccess"), "the flag must derive from the authorized resolution");
});
