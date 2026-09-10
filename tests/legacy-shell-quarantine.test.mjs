import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

const onboardingMap = read("src/lib/auth/onboarding-route-map.ts");
const resolver = read("src/lib/auth/resolve-post-auth-destination.ts");
const proxy = read("src/proxy.ts");
const layout = read("src/app/(protected)/layout.tsx");
const workspacePage = read("src/app/(protected)/workspace/page.tsx");
const workspaceSetupPage = read("src/app/(protected)/workspace/setup/page.tsx");
const commandCenterPage = read("src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx");
const commandCenterLayout = read("src/modules/workspace/screens/command-center/command-center-layout.tsx");
const commandCenterEmptyState = read("src/modules/workspace/screens/command-center/command-center-empty-state.tsx");
const operationalShell = read("src/components/pmfreak/operational-shell.tsx");
const routeDebug = read("src/app/api/route-debug/route.ts");

const LEGACY_STRINGS = [
  "Operational Command Center",
  "No active context",
  "Create your first context",
];

// ─── 1. Default authenticated landing route ─────────────────────────────────
test("default authenticated landing route is /command-center, not /workspace", () => {
  assert.match(onboardingMap, /case "active":\s*\n\s*return "\/command-center";/);
  assert.doesNotMatch(onboardingMap, /case "active":\s*\n\s*return "\/workspace";/);
  assert.match(resolver, /return \{ destination: "\/command-center", reason: "command-center-default" \};/);
});

// ─── 2. /workspace/setup no longer renders anything — it is a pure redirect ─
// PMF-001/PMF-002 canonical onboarding consolidation retired the legacy
// wizard hosted at /workspace/setup entirely. There is nothing left for the
// Edge middleware to "complete-onboarding-redirect away from" — the page
// itself always redirects, via the same canonical resolver every other
// onboarding-aware surface uses.
test("/workspace/setup always redirects via the canonical resolver, never renders a wizard", () => {
  assert.doesNotMatch(workspaceSetupPage, /import\s*\{\s*GettingStartedFlow/);
  assert.match(workspaceSetupPage, /redirectToCanonicalOnboardingDestination/);
});

test("proxy.ts makes no setup-route-specific onboarding decision", () => {
  assert.doesNotMatch(proxy, /isSetupRoute/);
  assert.doesNotMatch(proxy, /onboardingCompleted/);
});

// ─── 3. /workspace never renders the legacy OperationalShell ────────────────
test("/workspace redirects to /command-center and does not mount the legacy shell", () => {
  assert.match(workspacePage, /redirect\("\/command-center"\)/);
  assert.doesNotMatch(workspacePage, /WorkspaceShell/);
  assert.doesNotMatch(workspacePage, /<OperationalShell/);
});

test("proxy quarantines /workspace at the edge, before any render occurs", () => {
  assert.match(proxy, /pathname === "\/workspace"/);
});

// ─── 4. Legacy dark-shell strings are absent from the normal user journey ───
for (const [name, file] of Object.entries({
  "command-center page": commandCenterPage,
  "command-center layout": commandCenterLayout,
  "command-center empty state": commandCenterEmptyState,
  "workspace/setup page": workspaceSetupPage,
})) {
  test(`${name} contains none of the legacy dark-shell strings`, () => {
    for (const legacy of LEGACY_STRINGS) {
      assert.equal(file.includes(legacy), false, `${name} must not contain "${legacy}"`);
    }
  });
}

// ─── 5. No-project state uses the premium light empty state ─────────────────
test("command-center page renders CommandCenterEmptyState when there are no projects", () => {
  assert.match(commandCenterPage, /CommandCenterEmptyState/);
});

// ─── 6. Runtime shell markers prove which shell actually rendered ───────────
test("light command-center feature layout carries the pmfreak-light-command-center marker", () => {
  assert.match(commandCenterLayout, /data-shell="pmfreak-light-command-center"/);
  assert.match(commandCenterEmptyState, /data-shell="pmfreak-light-command-center"/);
});

// ─── 7. Single unified authenticated shell — no per-route allowlist ─────────
// The Workspace→PMO→Project refactor (#526/#527) originally broke because new
// routes weren't added to a hardcoded allowlist in (protected)/layout.tsx, so
// they silently fell through to the legacy dark OperationalShell branch.
// PMF-001/PMF-002 canonical onboarding consolidation removed the allowlist
// entirely: the "incomplete onboarding" branch now redirects to the single,
// derived canonical destination for the current state (never a hardcoded
// route string), and only that exact destination ever renders in place of a
// redirect — so no unlisted route can silently bypass the unified shell
// again, because there is no list to fall through.
test("OperationalShell root carries the unified pmfreak-shell marker, not a legacy one", () => {
  assert.match(operationalShell, /data-shell="pmfreak-shell"/);
  assert.doesNotMatch(operationalShell, /pmfreak-legacy-operational-shell/);
});

test("OperationalShell no longer special-cases /command-center into a bare bypass shell", () => {
  assert.doesNotMatch(operationalShell, /pathname\.startsWith\("\/command-center"\)/);
});

test("(protected)/layout.tsx contains no hardcoded per-route allowlist for the incomplete-onboarding branch", () => {
  const branchStart = layout.indexOf("if (!hasWorkspaceAccess(onboardingState))");
  const branchEnd = layout.indexOf("const capabilityProfile");
  const incompleteBranch = layout.slice(branchStart, branchEnd);
  assert.doesNotMatch(incompleteBranch, /currentPath\.startsWith\(/, "no hardcoded route allowlist — the destination must be derived from getOnboardingRedirect");
  assert.match(incompleteBranch, /getOnboardingRedirect\(onboardingState\)/);
  assert.doesNotMatch(incompleteBranch, /<OperationalShell/, "incomplete-onboarding fallback must be a bare wrapper, not the full shell");
});

test("completed-onboarding users always render through OperationalShell, with no route-specific bypass", () => {
  const completeBranch = layout.slice(layout.indexOf("const capabilityProfile"));
  const bareDivBranches = [...completeBranch.matchAll(/currentPath\.startsWith\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(bareDivBranches, [], "no route-specific bypass may exist after the onboarding-complete check");
  assert.match(completeBranch, /<OperationalShell/);
});

// ─── 8. Safe diagnostic endpoint ─────────────────────────────────────────────
test("/api/route-debug reports the corrected routing defaults without leaking secrets", () => {
  assert.match(routeDebug, /defaultAuthenticatedRoute: "\/command-center"/);
  assert.match(routeDebug, /workspaceRedirectTarget: "\/command-center"/);
  assert.match(routeDebug, /setupCompletedRedirectTarget: "\/command-center"/);
  assert.match(routeDebug, /commandCenterMarker: "command-center-light-v2"/);
  const responseBody = routeDebug.slice(routeDebug.indexOf("NextResponse.json({"));
  assert.doesNotMatch(responseBody, /SUPABASE|SECRET|API_KEY|password/i);
});
