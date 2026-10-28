import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isOnboardingChooserExempt, isWorkspaceChooserPath, shouldRedirectForOnboarding } from "../src/lib/auth/onboarding-gate";
import type { OnboardingState } from "../src/lib/auth/resolve-onboarding-state";

// PD-9 / PD-12 (five-persona QA, Wave 1). Browser coverage lives in the QA harness;
// these pin the decisions the browser journeys depend on.

const ALL_STATES: OnboardingState[] = ["no_workspace", "needs_project", "needs_task", "execution_started", "active", "trial_blocked"];

const layout = readFileSync("src/app/(protected)/layout.tsx", "utf8");
const acceptPage = readFileSync("src/app/(protected)/accept-invite/[token]/page.tsx", "utf8");
const openInvited = readFileSync("src/app/(protected)/accept-invite/[token]/open-invited-workspace.tsx", "utf8");
const teamPage = readFileSync("src/app/(protected)/team/page.tsx", "utf8");
const teamActions = readFileSync("src/app/(protected)/team/actions.ts", "utf8");

// ─── PD-9: the chooser is reachable from an empty selected workspace ─────────

test("PD-9: /workspaces and /workspaces/new are the chooser; the canonical workspace family is not", () => {
  for (const path of ["/workspaces", "/workspaces/", "/workspaces/new", "/workspaces?error=x"]) {
    assert.equal(isWorkspaceChooserPath(path), true, path);
  }
  for (const path of [
    null,
    undefined,
    "",
    "/workspace",
    "/workspacesx",
    "/workspaces/00000000-0000-0000-0000-000000000001",
    "/workspaces/00000000-0000-0000-0000-000000000001/command-center",
    "/workspaces/new/extra",
    "/projects/new",
    "/team",
  ]) {
    assert.equal(isWorkspaceChooserPath(path), false, String(path));
  }
});

test("PD-9: only needs_project exempts the chooser — entitlement and no-workspace still redirect", () => {
  for (const state of ALL_STATES) {
    assert.equal(isOnboardingChooserExempt(state, "/workspaces"), state === "needs_project", state);
    assert.equal(isOnboardingChooserExempt(state, "/workspaces/new"), state === "needs_project", state);
  }
  // The gate itself is unchanged: owners still owe their first project everywhere else.
  assert.equal(shouldRedirectForOnboarding({ state: "needs_project", routedWorkspaceArchived: false }), true);
  for (const path of ["/command-center", "/team", "/dashboard", "/projects", "/settings"]) {
    assert.equal(isOnboardingChooserExempt("needs_project", path), false, path);
  }
});

test("PD-9: the layout keeps its loop guard and applies the chooser exemption to the redirect only", () => {
  assert.match(layout, /if \(currentPath !== dest && !isOnboardingChooserExempt\(onboardingState, currentPath\)\) \{\s*redirect\(dest\);/);
  // The exempt chooser renders in the onboarding frame, never in the operational shell.
  const gateBlock = layout.slice(layout.indexOf("if (shouldRedirectForOnboarding("), layout.indexOf("const capabilityProfile"));
  assert.doesNotMatch(gateBlock, /OperationalShell/);
  assert.match(gateBlock, /href="\/workspaces"/);
});

test("PD-9: invite acceptance selects the invited workspace through the validated switcher", () => {
  assert.doesNotMatch(acceptPage, /redirect\("\/team"\)/);
  // The workspace id comes from the accepted invitation record, never from the request.
  assert.match(acceptPage, /accepted = await acceptWorkspaceInvite\(\{ token, userId: user\.id, userEmail: user\.email \}\)/);
  assert.match(acceptPage, /<OpenInvitedWorkspace workspaceId=\{accepted\.workspaceId\}/);
  // The selection is the POST switcher, which re-validates membership before writing the cookie.
  assert.match(openInvited, /^"use client";/);
  assert.match(openInvited, /action=\{switchWorkspaceAction\}/);
  assert.match(openInvited, /requestSubmit\(\)/);
  const actions = readFileSync("src/app/(protected)/workspaces/actions.ts", "utf8");
  const switcher = actions.slice(actions.indexOf("export async function switchWorkspaceAction"));
  assert.ok(
    switcher.indexOf("resolveCanonicalWorkspace(user.id, workspaceId)") < switcher.indexOf("setPreferredWorkspaceCookie(workspaceId)"),
    "the switcher must validate membership before selecting",
  );
});

// ─── PD-12: /team follows the selected workspace and never substitutes ───────

test("PD-12: /team resolves the selected workspace, not an arbitrary membership", () => {
  assert.doesNotMatch(teamPage, /\.limit\(1\)\s*\.maybeSingle/);
  assert.match(teamPage, /const selectedWorkspaceId = await readPreferredWorkspaceId\(\);/);
  assert.match(teamPage, /resolveCanonicalWorkspace\(user\.id, selectedWorkspaceId\)/);
  assert.match(teamPage, /const workspaceId = resolution\.workspaceId;/);
  assert.match(teamPage, /<input type="hidden" name="workspaceId" value=\{workspaceId\} \/>/);
});

test("PD-12: an unavailable selection fails safe instead of showing another workspace", () => {
  const refusal = teamPage.slice(teamPage.indexOf("if (selectedWorkspaceId && resolution.workspaceId !== selectedWorkspaceId)"));
  assert.ok(refusal.length > 0, "a stale or foreign selection must be refused");
  const refusalBranch = refusal.slice(0, refusal.indexOf("}") + 1);
  assert.match(refusalBranch, /return /);
  assert.doesNotMatch(refusalBranch, /sendInviteAction|workspace_memberships|workspace_invitations/);
  // The refusal is decided before any team data is read.
  assert.ok(teamPage.indexOf("selectedWorkspaceId && resolution.workspaceId !== selectedWorkspaceId") < teamPage.indexOf('.from("workspace_memberships")'));
});

test("PD-12: the invite form is offered to owners and admins only; the server still decides", () => {
  assert.match(teamPage, /const canInvite = resolution\.role === "owner" \|\| resolution\.role === "admin";/);
  assert.match(teamPage, /\{canInvite \? <form action=\{sendInviteAction\}/);
  // Hiding the form is presentation. The action re-authorizes the POSTED workspace itself.
  assert.match(teamActions, /requireWorkspaceRole\(workspaceId, "admin"\)/);
});
