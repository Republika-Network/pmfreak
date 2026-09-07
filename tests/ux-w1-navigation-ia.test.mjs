/**
 * UX-W1 — navigation / information architecture contract.
 *
 * PMFreak's first level used to advertise its architecture: 27 nodes across four tiers,
 * with Workspace Chat / Daily Execution / Create Center / New Project as the primary rail
 * and a second "lens" rail beneath it. Two entries were the same word for different things
 * — /execution was "Daily Execution" while /command-center was "Execution".
 *
 * W1 froze the first level to four product destinations. This file is the contract:
 * membership, order, naming, and the guarantee that nothing was deleted to get there.
 *
 * Assertions run against the REAL derivation (`computeNavigationRail`, the same function
 * the shell calls) wherever behaviour can be observed, and fall back to source reading only
 * for the exact hierarchy declaration and for how the shell renders it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { NAVIGATION_HIERARCHY, getPrimaryNavigation } from "../src/lib/workspace/navigation-hierarchy.ts";
import { computeCapabilityRevealState, computeNavigationRail } from "../src/features/runtime/capability-reveal/capability-reveal-selectors.ts";
import { ROUTE_GUARD_REGISTRY } from "../src/lib/security/route-guard-registry.ts";

const read = (p) => readFileSync(p, "utf8");
const shell = read("src/components/pmfreak/operational-shell.tsx");
const hierarchySrc = read("src/lib/workspace/navigation-hierarchy.ts");

/** The four product destinations, in product order. */
const PRIMARY_CONTRACT = [
  { label: "Command Center", href: "/command-center" },
  { label: "Projects", href: "/projects" },
  { label: "Execution", href: "/execution" },
  { label: "Portfolio", href: "/portfolio" },
];

/** A brand-new account: the least permissive reveal state a real user can be in. */
const NEW_ACCOUNT = {
  planTier: "free", role: "pm", onboardingCompleted: false, hasProject: false, firstRun: true,
  evidenceSignals: 0, operationalMemorySignals: 0, continuitySignals: 0,
  canUseAdvancedAi: false, canUsePortfolioMemory: false, canUseGovernanceDirectives: false,
};

/** A fully unlocked account: the most permissive. */
const MAX_ACCOUNT = {
  planTier: "pmo", role: "owner", onboardingCompleted: true, hasProject: true, firstRun: false,
  evidenceSignals: 10, operationalMemorySignals: 10, continuitySignals: 10,
  canUseAdvancedAi: true, canUsePortfolioMemory: true, canUseGovernanceDirectives: true,
};

/** The primary rail as the shell computes it, for one account shape and profile. */
function primaryRail(account, profile) {
  const primaryHrefs = new Set(getPrimaryNavigation().map((n) => n.href));
  return computeNavigationRail(computeCapabilityRevealState(account), profile)
    .filter((item) => primaryHrefs.has(item.href));
}

// ───────────────────────────── membership and order ─────────────────────────────

test("W1: primary navigation is exactly four destinations, in product order", () => {
  assert.deepEqual(
    getPrimaryNavigation().map((n) => ({ label: n.label, href: n.href })),
    PRIMARY_CONTRACT,
  );
});

for (const [name, account] of [["a brand-new account", NEW_ACCOUNT], ["a fully unlocked account", MAX_ACCOUNT]]) {
  for (const profile of ["pilot", "founder"]) {
    test(`W1: ${name} on the ${profile} profile sees the same four primary destinations, in order`, () => {
      // Neither capability unlock stage nor capability profile may add to, remove from or
      // reorder the product hierarchy — that is what makes it a hierarchy a PM can learn.
      assert.deepEqual(
        primaryRail(account, profile).map((item) => ({ label: item.label, href: item.href })),
        PRIMARY_CONTRACT,
      );
    });
  }
}

// ───────────────────────────── naming: one concept, one name ────────────────────

test("W1: /command-center is called Command Center, and nothing else is", () => {
  const named = NAVIGATION_HIERARCHY.filter((n) => n.label === "Command Center");
  assert.deepEqual(named.map((n) => n.href), ["/command-center"]);
});

test("W1: /execution is called Execution, and nothing else is", () => {
  const named = NAVIGATION_HIERARCHY.filter((n) => n.label === "Execution");
  assert.deepEqual(named.map((n) => n.href), ["/execution"]);
});

test("W1: no two navigation entries share a label", () => {
  // The defect this replaced was two adjacent entries a PM could not tell apart.
  const labels = NAVIGATION_HIERARCHY.map((n) => n.label);
  assert.deepEqual([...new Set(labels)].sort(), [...labels].sort());
});

test("W1: no ordinary navigation entry means Execution twice", () => {
  const executionish = NAVIGATION_HIERARCHY.filter((n) => /execution/i.test(n.label));
  assert.deepEqual(executionish.map((n) => n.label), ["Execution"]);
});

// ───────────────────────── retired first-level concepts ─────────────────────────

for (const retired of ["Workspace Chat", "Create Center", "New Project", "Summary", "Executive", "Daily Execution", "Workspace Setup", "Workspaces", "PMOs", "Programs", "Upload", "Members"]) {
  test(`W1: "${retired}" is not first-level navigation`, () => {
    const primaryLabels = getPrimaryNavigation().map((n) => n.label);
    assert.ok(!primaryLabels.includes(retired), `${retired} must not compete at the first level`);
  });
}

test("W1: retiring a concept from the first level never deleted its route", () => {
  // The entire basis for the change. Every route the old hierarchy pointed at still
  // resolves — reclassified into "More", or navigation-hidden but reachable.
  for (const page of [
    "src/app/(protected)/chat/page.tsx",
    "src/app/(protected)/dashboard/page.tsx",
    "src/app/(protected)/executive/page.tsx",
    "src/app/(protected)/projects/new/page.tsx",
    "src/app/(protected)/create-command-center/page.tsx",
    "src/app/(protected)/workspace-setup/page.tsx",
    "src/app/(protected)/team/page.tsx",
    "src/app/(protected)/programs/page.tsx",
    "src/app/(protected)/upload/page.tsx",
  ]) {
    assert.ok(existsSync(page), `${page} must still exist — navigation changed, not routes`);
  }
});

test("W1: every navigation href resolves to a real route (no dead nav entries)", () => {
  for (const node of NAVIGATION_HIERARCHY) {
    const base = `src/app/(protected)${node.href}`;
    const exists = existsSync(`${base}/page.tsx`) || existsSync(`${base}/page.ts`);
    assert.ok(exists, `navigation points at ${node.href}, which has no page`);
  }
});

// ───────────────────────── project creation discoverability ─────────────────────

test("W1: Projects keeps project creation discoverable after New Project left the rail", () => {
  const projects = read("src/app/(protected)/projects/page.tsx");
  const emptyStates = read("src/components/pmfreak/empty-states/workspace-empty-state.tsx");
  // Populated state: the inline create form.
  assert.match(projects, /createProjectAction/);
  assert.match(projects, />Create Project</);
  // Empty state: its own CTA, so a first-time user is not left without one.
  assert.match(projects, /<EmptyProjects/);
  assert.match(emptyStates, /CreateProjectCta label="Create your first project"/);
});

// ───────────────────────── advanced capabilities unchanged ──────────────────────

test("W1: advanced surfaces keep their exact capability requirements", () => {
  // Pinned rather than spot-checked: a navigation change must not become a quiet
  // authorization change.
  const expected = {
    "/operational-memory": "memory",
    "/stakeholder-intel": "stakeholders",
    "/change-detection": "risks",
    "/meetings": "coordination",
    "/follow-up-dashboard": "delivery",
    "/governance": "governance",
    "/policies": "governance",
    "/trust/agents": "interventions",
    "/audit": "governance",
    "/capabilities": "interventions",
    "/intelligence": "executive",
    "/trials": "interventions",
  };
  const actual = Object.fromEntries(
    NAVIGATION_HIERARCHY.filter((n) => n.tier === "advanced").map((n) => [n.href, n.requiresCapability]),
  );
  assert.deepEqual(actual, expected);
});

test("W1: advanced surfaces are still hidden by default", () => {
  for (const node of NAVIGATION_HIERARCHY.filter((n) => n.tier === "advanced")) {
    assert.equal(node.visibleByDefault, false, `${node.href} must not be visible by default`);
  }
});

test("W1: an advanced surface appears only when its capability domain is unlocked", () => {
  // The gate, not the tier, is what decides visibility — and it is the ONLY thing that
  // decides it. (Which domains a stage or role unlocks is pre-existing reveal behaviour
  // W1 did not touch: a new PM account already reaches some advanced surfaces because the
  // pm role profile grants their domain. What must stay true is that nothing reaches one
  // WITHOUT the domain.)
  for (const account of [NEW_ACCOUNT, MAX_ACCOUNT]) {
    const state = computeCapabilityRevealState(account);
    const railHrefs = new Set(computeNavigationRail(state, "founder").map((i) => i.href));
    for (const node of NAVIGATION_HIERARCHY.filter((n) => n.tier === "advanced")) {
      const unlocked = state.unlockedDomains.includes(node.requiresCapability);
      assert.equal(
        railHrefs.has(node.href),
        unlocked,
        `${node.href} visibility must follow its "${node.requiresCapability}" domain, not the navigation change`,
      );
    }
  }
});

// ───────────────────────── internal surfaces stay out ───────────────────────────

test("W1: no internal or founder-only surface entered customer navigation", () => {
  const hrefs = NAVIGATION_HIERARCHY.map((n) => n.href);
  // Anything the route guard registry classifies founder-internal, plus the internal
  // prefix and the developer surfaces.
  const internalPages = ROUTE_GUARD_REGISTRY
    .filter((e) => e.classification === "founder-internal" && e.kind === "page")
    .map((e) => e.file);
  assert.ok(internalPages.length > 0, "expected the registry to classify internal pages");
  for (const file of internalPages) {
    const route = file.replace("src/app/(protected)", "").replace("src/app", "").replace("/page.tsx", "");
    assert.ok(!hrefs.includes(route), `internal surface ${route} must not be in customer navigation`);
  }
  for (const forbidden of ["/internal/governance-lab", "/operational-flow", "/early-access", "/founder-program", "/debug-session", "/playground"]) {
    assert.ok(!hrefs.includes(forbidden), `${forbidden} must not be in customer navigation`);
  }
});

// ───────────────────────── desktop / mobile parity ──────────────────────────────

test("W1: desktop and mobile derive the primary rail from one computation", () => {
  // Parity by construction rather than by coincidence: there is a single `primaryNav`
  // derivation, and both render sites map over it. A second derivation is how the two
  // surfaces drift apart.
  const derivations = shell.match(/const primaryNav = navItems\.filter/g) ?? [];
  assert.equal(derivations.length, 1, "primaryNav must be derived exactly once");
  const renders = shell.match(/\{primaryNav\.map\(/g) ?? [];
  assert.equal(renders.length, 2, "expected exactly two render sites: the desktop rail and the mobile strip");
});

test("W1: mobile exposes a More affordance over the same secondary and advanced arrays", () => {
  // The mobile strip used to render the primary rail and nothing else, stranding every
  // supporting surface on desktop.
  assert.match(shell, /aria-controls="mobile-more-navigation"/);
  assert.match(shell, /id="mobile-more-navigation"/);
  assert.match(shell, /\[\.\.\.utilityNav, \.\.\.advancedNav\]\.map\(/);
});

test("W1: the desktop rail presents one secondary group", () => {
  assert.match(shell, /More<\/p>/);
  assert.doesNotMatch(shell, /Lenses<\/p>/);
  assert.doesNotMatch(shell, /Utilities<\/p>/);
  assert.match(shell, /AdvancedDrawer items=\{advancedNav\}/);
});

// ───────────────────────── Command Center as home ───────────────────────────────

test("W1: navigational recovery links point at Command Center, not the legacy dashboard", () => {
  const protectedError = read("src/app/(protected)/error.tsx");
  assert.match(protectedError, /href="\/command-center"/);
  assert.doesNotMatch(protectedError, /href="\/dashboard"/);
});

test("W1: the hierarchy documents which routes are intentionally navigation-hidden", () => {
  // A hidden route with no written reason reads as an oversight to the next reader, and
  // gets "fixed" back into the navigation.
  for (const hidden of ["/chat", "/dashboard", "/projects/new"]) {
    assert.ok(hierarchySrc.includes(hidden), `${hidden} is hidden but undocumented in the hierarchy`);
  }
});
