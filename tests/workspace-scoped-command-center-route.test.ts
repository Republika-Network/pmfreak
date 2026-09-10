import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMMAND_CENTER_FORWARDED_QUERY_KEYS,
  WORKSPACE_COMMAND_CENTER_LEGACY_PATH,
  isWorkspaceCommandCenterPath,
  navEntryMatchesPathname,
  workspaceCommandCenterPath,
} from "../src/lib/workspace/command-center-paths";
import { isSafeContinuationRoute } from "../src/lib/auth/validate-continuation-route";
import { getRouteAccessPolicy, isProtectedPageRoute } from "../src/lib/auth/route-policy-registry";

const WS = "11111111-2222-3333-4444-555555555555";
const CANONICAL = `/workspaces/${WS}/command-center`;

const legacyRoute = readFileSync("src/app/(protected)/command-center/page.tsx", "utf8");
const canonicalRoute = readFileSync("src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx", "utf8");
const shell = readFileSync("src/components/pmfreak/operational-shell.tsx", "utf8");
const protectedLayout = readFileSync("src/app/(protected)/layout.tsx", "utf8");

// ─── The canonical path itself ────────────────────────────────────────────

test("the canonical path is the entity-qualified route named by the route map", () => {
  assert.equal(workspaceCommandCenterPath(WS), CANONICAL);
  assert.ok(isWorkspaceCommandCenterPath(CANONICAL));
});

test("the workspace id is encoded, never interpolated raw", () => {
  // A path segment is not a safe place for arbitrary text. This is not expected
  // input — it is the assertion that a malformed id cannot escape its segment.
  const path = workspaceCommandCenterPath("a/b?c=d");
  assert.equal(path, "/workspaces/a%2Fb%3Fc%3Dd/command-center");
  assert.equal(path.split("/").length, 4, "an encoded id must not add path segments");
});

test("query values are attached, and empty ones are dropped rather than sent blank", () => {
  assert.equal(workspaceCommandCenterPath(WS, { projectId: "p1" }), `${CANONICAL}?projectId=p1`);
  // `briefGeneration: undefined` is how the caller says "not failed". Serialising
  // it as `briefGeneration=` would make the screen read a failure that never
  // happened.
  assert.equal(
    workspaceCommandCenterPath(WS, { projectId: "p1", briefGeneration: undefined, error: null, from: "" }),
    `${CANONICAL}?projectId=p1`,
  );
  assert.equal(workspaceCommandCenterPath(WS, {}), CANONICAL);
});

// ─── Navigation active-state: the /workspaces collision ───────────────────

test("on the canonical route, Command Center is the active nav entry", () => {
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, CANONICAL));
});

test("on the canonical route, Workspaces is NOT also active", () => {
  // The regression this guards: the canonical Command Center nests under
  // /workspaces/<id>/, and "/workspaces" is a real nav entry, so a plain prefix
  // test highlights both and tells the PM they are in two places at once.
  assert.equal(navEntryMatchesPathname("/workspaces", CANONICAL), false);
});

test("the Workspaces entry still owns its own route", () => {
  assert.ok(navEntryMatchesPathname("/workspaces", "/workspaces"));
  assert.equal(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, "/workspaces"), false);
});

test("the legacy entry point still reads as Command Center while it exists", () => {
  assert.ok(navEntryMatchesPathname(WORKSPACE_COMMAND_CENTER_LEGACY_PATH, "/command-center"));
});

test("every other nav entry keeps the shell's original prefix semantics", () => {
  assert.ok(navEntryMatchesPathname("/projects", "/projects"));
  assert.ok(navEntryMatchesPathname("/projects", "/projects/abc"));
  assert.equal(navEntryMatchesPathname("/projects", "/portfolio"), false);
});

// ─── The canonical route must be protected, and survive re-auth ───────────

test("the canonical route is a protected page, not an unknown one", () => {
  assert.ok(isProtectedPageRoute(CANONICAL));
  assert.equal(getRouteAccessPolicy(CANONICAL), "workspace-contextual");
});

test("a canonical deep link survives an expired session", () => {
  // Without this the user is returned to the bare entry point after logging
  // back in, losing the workspace they were actually looking at. "/workspace"
  // does not cover "/workspaces/..." — the prefix test requires a "/" boundary.
  assert.ok(isSafeContinuationRoute(CANONICAL));
  assert.ok(isSafeContinuationRoute(WORKSPACE_COMMAND_CENTER_LEGACY_PATH), "legacy links must keep working");
});

test("widening the allowlist did not open a blocked prefix", () => {
  for (const blocked of ["/api/anything", "/login", "/_next/static", "/debug/x"]) {
    assert.equal(isSafeContinuationRoute(blocked), false, `${blocked} must stay blocked`);
  }
  assert.equal(isSafeContinuationRoute("//evil.example.com"), false);
});

// ─── Wiring: one screen, one resolution point ─────────────────────────────

test("the legacy path is a resolver that redirects, and no longer renders the screen", () => {
  assert.match(legacyRoute, /redirect\(workspaceCommandCenterPath\(/);
  assert.doesNotMatch(legacyRoute, /CommandCenterClient/, "the screen must exist in exactly one route");
});

test("the legacy resolver forwards the hand-off query keys instead of dropping them", () => {
  assert.match(legacyRoute, /COMMAND_CENTER_FORWARDED_QUERY_KEYS/);
  for (const key of ["projectId", "from", "brainActivated"]) {
    assert.ok(
      (COMMAND_CENTER_FORWARDED_QUERY_KEYS as readonly string[]).includes(key),
      `${key} carries onboarding hand-off state and must be forwarded`,
    );
  }
});

test("the canonical route authorizes the URL's workspace id against real membership", () => {
  // Originally this compared resolveCanonicalWorkspace's answer against the
  // request, because that resolver silently FALLS BACK to another workspace.
  // Review finding P2 showed the comparison also swallowed archived workspaces,
  // so the route now uses resolveRoutedWorkspace, which authorizes the exact id
  // or refuses and has no fallback to compare against.
  assert.match(canonicalRoute, /resolveRoutedWorkspace\(user\.id, requestedWorkspaceId\)/);
  assert.match(canonicalRoute, /workspaceAccess\.access === "denied"/);
  assert.doesNotMatch(canonicalRoute, /resolvePreferredWorkspace/, "the URL is the scope here, not the cookie");
  assert.doesNotMatch(canonicalRoute, /resolveCanonicalWorkspace/, "the falling-back resolver must not return");
});

test("the refusal does not reveal whether the workspace exists", () => {
  assert.match(canonicalRoute, /does not exist or is not one you have access to/);
});

test("navigation points at the canonical route when the workspace is known", () => {
  assert.match(shell, /workspaceCommandCenterPath\(workspaceId/);
  assert.match(shell, /workspaceId\?: string/);
  assert.match(protectedLayout, /workspaceId=\{resolvedWorkspace\.workspaceId\}/);
});

test("the nav entry keeps its stable identity so lookups by href still resolve", () => {
  // Only the destination is canonical. NAVIGATION_HIERARCHY is keyed by href in
  // the shell's tier map and in capability-reveal-selectors.
  const hierarchy = readFileSync("src/lib/workspace/navigation-hierarchy.ts", "utf8");
  assert.match(hierarchy, /label: "Command Center", href: "\/command-center"/);
});
