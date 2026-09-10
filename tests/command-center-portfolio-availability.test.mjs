// Regression coverage for the UAT blocker: a failure in the Command Center's
// optional PMO portfolio load must not take down /command-center, and must
// never be reported as an empty portfolio.
//
// Root cause: listPmosWithProjects (src/lib/pmos/pmo-service.ts:35,48) throws
// on any Supabase error, and page.tsx awaited it *before* the empty-projects
// guard, so a transient portfolio failure surfaced as the shared
// (protected)/error.tsx "We hit a protected-area error" screen.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizePortfolio } from "../src/app/(protected)/command-center/portfolio-summary.ts";

const PAGE_SRC = readFileSync("src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx", "utf8");

test("a null portfolio is reported as unavailable, never as empty", () => {
  const summary = summarizePortfolio(null);
  assert.equal(summary.status, "unavailable");
  assert.equal("pmoCount" in summary, false, "an unavailable portfolio must not carry counts");
  assert.equal("projectCount" in summary, false, "an unavailable portfolio must not carry counts");
});

test("an empty portfolio is reported as available with zero counts", () => {
  const summary = summarizePortfolio([]);
  assert.equal(summary.status, "available");
  assert.equal(summary.pmoCount, 0);
  assert.equal(summary.projectCount, 0);
  assert.equal(summary.activeProjectCount, 0);
  assert.equal(summary.firstPmoName, null);
});

test("unavailable and empty are never conflated", () => {
  assert.notEqual(summarizePortfolio(null).status, summarizePortfolio([]).status);
});

test("a populated portfolio counts projects and active projects correctly", () => {
  const summary = summarizePortfolio([
    { name: "Core PMO", projects: [{ status: "active" }, { status: "archived" }] },
    { name: "Client PMO", projects: [{ status: "active" }] },
  ]);
  assert.equal(summary.status, "available");
  assert.equal(summary.pmoCount, 2);
  assert.equal(summary.projectCount, 3);
  assert.equal(summary.activeProjectCount, 2);
  assert.equal(summary.firstPmoName, "Core PMO");
});

test("the command-center page loads the PMO portfolio inside a try/catch", () => {
  assert.match(
    PAGE_SRC,
    /try\s*\{[\s\S]*?listPmosWithProjects\([\s\S]*?\}\s*catch/,
    "listPmosWithProjects must be guarded so a portfolio failure cannot crash /command-center",
  );
});

test("the command-center page classifies a failed projects read instead of swallowing it", () => {
  assert.match(PAGE_SRC, /error:\s*projectsError/, "the projects query must capture its error");
  assert.match(
    PAGE_SRC,
    /if\s*\(projectsError\)/,
    "a failed projects read must be handled explicitly, not fall through to the empty state",
  );
});

test("the command-center page never renders raw portfolio counts unguarded", () => {
  assert.ok(!/pmoPortfolio\.length/.test(PAGE_SRC), "counts must come from summarizePortfolio");
  assert.ok(!/pmoPortfolio\[0\]/.test(PAGE_SRC), "pmoName must come from summarizePortfolio");
});

test("workspace scoping on the command-center queries is unchanged", () => {
  const scoped = PAGE_SRC.match(/\.eq\("workspace_id", workspace\.workspaceId\)/g) ?? [];
  assert.ok(scoped.length >= 2, "every projects read must remain scoped to the resolved workspace");
  assert.match(
    PAGE_SRC,
    /listPmosWithProjects\(workspace\.workspaceId\)/,
    "the portfolio load must remain workspace-scoped",
  );
});
