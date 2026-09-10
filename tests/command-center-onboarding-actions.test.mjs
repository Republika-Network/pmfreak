/**
 * Contract tests for onboarding actions living inside the Command Center
 * instead of behind a separate intermediate page. Static-analysis style,
 * matching the rest of this test suite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const emptyState = readFileSync(
  join(ROOT, "src/modules/workspace/screens/command-center/command-center-empty-state.tsx"),
  "utf8"
);
const layout = readFileSync(join(ROOT, "src/modules/workspace/screens/command-center/command-center-layout.tsx"), "utf8");
const page = readFileSync(join(ROOT, "src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 1: the real, evidence-derived onboarding checklist is reused,
// not a new parallel "recommended actions" component
// ─────────────────────────────────────────────────────────────────────────────

test("Command Center empty state mounts the real WorkspaceOnboardingPanel", () => {
  assert.match(emptyState, /import \{ WorkspaceOnboardingPanel \} from "@\/components\/pmfreak\/onboarding\/workspace-onboarding-panel"/);
  assert.match(emptyState, /<WorkspaceOnboardingPanel/);
});

test("Command Center populated layout mounts the real WorkspaceOnboardingPanel", () => {
  assert.match(layout, /import \{ WorkspaceOnboardingPanel \} from "@\/components\/pmfreak\/onboarding\/workspace-onboarding-panel"/);
  assert.match(layout, /<WorkspaceOnboardingPanel/);
});

test("the old dead placeholder 'Get started' cards are gone from the empty state", () => {
  assert.doesNotMatch(emptyState, /Upload project documents/);
  assert.doesNotMatch(emptyState, /Paste meeting notes/);
  assert.doesNotMatch(emptyState, /Unlocks once your first project is created/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 2: the PMO invite nudge shown right after activation is real data,
// never a placeholder name
// ─────────────────────────────────────────────────────────────────────────────

test("page loads the real PMO portfolio before branching, so the empty state can show a real name", () => {
  const pmoFetchIdx = page.indexOf("await listPmosWithProjects(workspace.workspaceId)");
  const emptyStateIdx = page.indexOf("<CommandCenterEmptyState");
  assert.ok(pmoFetchIdx > 0, "must fetch the PMO portfolio");
  assert.ok(emptyStateIdx > pmoFetchIdx, "PMO portfolio must be loaded before rendering the empty state");
  // The portfolio load is now failure-tolerant (see portfolio-summary.ts), so
  // the name comes from the summarized "available" variant. Intent is
  // unchanged: a real PMO name or null — never a fabricated placeholder, and
  // never a name invented after a failed portfolio read.
  assert.match(page, /pmoName=\{portfolio\.status === "available" \? portfolio\.firstPmoName : null\}/);
});

test("the invite nudge only renders with a real fromOnboarding flag and a real pmoName, never a fabricated default", () => {
  assert.match(emptyState, /fromOnboarding && pmoName/);
  assert.doesNotMatch(emptyState, /pmoName\s*=\s*"[^"]+"/, "pmoName must not default to a fabricated placeholder string");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 3: /pmo/invite-team is no longer a forced intermediate page, but
// stays reachable as a real link — not deleted out from under anyone
// ─────────────────────────────────────────────────────────────────────────────

test("/pmo/invite-team route still exists and is reachable as a real link, not orphaned or deleted", () => {
  const inviteTeamPage = readFileSync(join(ROOT, "src/app/(protected)/pmo/invite-team/page.tsx"), "utf8");
  assert.match(inviteTeamPage, /InviteTeamClient/);
  assert.match(emptyState, /href="\/pmo\/invite-team"/, "the onboarding nudge must link to the real invite-team route");
});
