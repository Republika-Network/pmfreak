import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildWorkspaceInviteAcceptPath,
  isWorkspaceInviteAcceptancePath,
  WORKSPACE_INVITE_ACCEPT_PATH_PREFIX,
} from "../src/lib/workspace-team";

/**
 * Regression cover for `D1-INVITE-ACCEPT-LAYOUT-RACE`.
 *
 * `/accept-invite/<token>` is the one protected route whose job is to CREATE the membership
 * the protected layout otherwise demands it already holds. Because layouts and pages render
 * concurrently, the layout's onboarding redirect raced the page's own acceptance and won:
 * the response was `/projects/new` rather than `/team`, it could be returned before the
 * membership committed, every invitee had a personal workspace bootstrapped as a side
 * effect, and a genuine refusal never reached the user.
 *
 * The repair exempts that ONE path family from workspace onboarding — never from
 * authentication. These tests pin both halves of that sentence.
 */

const repoRoot = join(import.meta.dirname, "..");
const layoutSource = readFileSync(join(repoRoot, "src/app/(protected)/layout.tsx"), "utf8");
const invitePageSource = readFileSync(
  join(repoRoot, "src/app/(protected)/accept-invite/[token]/page.tsx"),
  "utf8",
);

const at = (haystack: string, needle: string): number => {
  const index = haystack.indexOf(needle);
  assert.notEqual(index, -1, `expected to find ${JSON.stringify(needle)}`);
  return index;
};

test("invite path: only /accept-invite/<single non-empty token> is workspace invite acceptance", () => {
  assert.equal(isWorkspaceInviteAcceptancePath("/accept-invite/abc123"), true);
  assert.equal(isWorkspaceInviteAcceptancePath(buildWorkspaceInviteAcceptPath("a token/with slash")), true);
  assert.equal(isWorkspaceInviteAcceptancePath("/accept-invite/abc123?utm=x"), true);
  assert.equal(isWorkspaceInviteAcceptancePath("/accept-invite/abc123#frag"), true);
});

test("invite path: the EARLY-ACCESS surface and every other route are not exempted", () => {
  // `/accept-invite?token=` is a different product surface and keeps its existing behaviour.
  for (const path of [
    "/accept-invite",
    "/accept-invite?token=abc",
    "/accept-invite/",
    "/accept-invite/abc/extra",
    "/accept-invitex/abc",
    "/command-center",
    "/team",
    "/projects/new",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isWorkspaceInviteAcceptancePath(path), false, `must not exempt ${JSON.stringify(path)}`);
  }
});

test("invite path: the accept link and the predicate share one spelling", () => {
  const token = "tok-en_value";
  const path = buildWorkspaceInviteAcceptPath(token);
  assert.ok(path.startsWith(WORKSPACE_INVITE_ACCEPT_PATH_PREFIX));
  assert.equal(path, `/accept-invite/${encodeURIComponent(token)}`);
  assert.equal(isWorkspaceInviteAcceptancePath(path), true, "a minted link must satisfy the predicate");
});

test("protected layout: the invite exemption runs AFTER authentication", () => {
  const continuity = at(layoutSource, "assertRuntimeAuthContinuity()");
  const userGuard = at(layoutSource, "if (!user) {");
  const exemption = at(layoutSource, "isWorkspaceInviteAcceptancePath(");
  assert.ok(continuity < exemption, "auth continuity must be established before the exemption");
  assert.ok(userGuard < exemption, "the unauthenticated redirect must precede the exemption");
});

test("protected layout: the invite exemption runs BEFORE any workspace or onboarding resolution", () => {
  const exemption = at(layoutSource, "isWorkspaceInviteAcceptancePath(");
  for (const downstream of [
    "resolveWriteWorkspace(user.id)",
    "resolveOnboardingState(",
    "shouldRedirectForOnboarding(",
    "<OperationalShell",
  ]) {
    assert.ok(
      exemption < at(layoutSource, downstream),
      `${downstream} must not run for an invite acceptance request`,
    );
  }
});

test("protected layout: the exemption returns instead of falling through to onboarding", () => {
  const exemption = at(layoutSource, "isWorkspaceInviteAcceptancePath(");
  const branch = layoutSource.slice(exemption, exemption + 400);
  assert.match(branch, /return \(/, "the exemption must return its own minimal wrapper");
  assert.match(branch, /\{children\}/, "the invite page itself must still render");
  assert.doesNotMatch(branch, /redirect\(/, "the exemption must not introduce a redirect of its own");
});

test("invite page: every server-side control the exemption relies on is still enforced", () => {
  // The layout no longer gates this route, so the page's own controls are load-bearing.
  assert.match(invitePageSource, /requireAuthUser\(\)/, "authentication");
  assert.match(invitePageSource, /scope: "workspace\.invite_accept"/, "per-IP abuse limit");
  assert.match(invitePageSource, /action: "per_token"/, "per-token abuse limit");
  assert.match(invitePageSource, /acceptWorkspaceInvite\(\{ token, userId: user\.id, userEmail: user\.email \}\)/,
    "the token comes from the route and the identity from the session, never from the client");
  assert.match(invitePageSource, /redirect\("\/team"\)/, "canonical success destination");
  // The page never takes workspace, role or invited email from the request.
  assert.doesNotMatch(invitePageSource, /searchParams/, "no client-supplied acceptance inputs");
});
