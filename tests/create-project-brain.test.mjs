/**
 * Behavioral contract tests for the Create Project Brain transactional flow.
 *
 * Static-analysis tests (readFileSync + assert) verifying that source code
 * upholds the transactional guarantees — no redirect without confirmed
 * persistence, no draft clear on failure, no false-positive Brain Activation,
 * no silent failure, no state ambiguity.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// CHAT-SHELL-01 F1: to the Command Center of the workspace the server ACTUALLY created the
// project in (`result.workspaceId`) — the bare `/command-center` resolved the preferred-workspace
// cookie and so could name a different workspace than the project's.
const PROJECT_CREATED_PUSH = "router.push(\n      workspaceCommandCenterPath(result.workspaceId, {\n        projectId: result.projectId,";

const ROOT = process.cwd();

const saveProject = readFileSync(join(ROOT, "src/lib/projects/save-project-onboarding.ts"), "utf8");
const wizard = readFileSync(join(ROOT, "src/components/pmfreak/projects/create-project-wizard.tsx"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 1: saveProjectOnboarding — three-state return type
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding declares explicit three-state contract", () => {
  assert.match(saveProject, /status: "success"/, "must have success state");
  assert.match(saveProject, /status: "recoverable_failure"/, "must have recoverable_failure state");
  assert.match(saveProject, /status: "fatal_failure"/, "must have fatal_failure state");
});

test("saveProjectOnboarding returns fatal_failure when unauthenticated", () => {
  assert.match(saveProject, /fatal_failure.*unauthenticated|unauthenticated.*fatal_failure/s);
});

test("saveProjectOnboarding returns fatal_failure for invalid payload", () => {
  assert.match(saveProject, /fatal_failure.*invalid_payload|invalid_payload.*fatal_failure/s);
});

test("saveProjectOnboarding returns fatal_failure when workspace is missing", () => {
  assert.match(saveProject, /fatal_failure.*missing_workspace|missing_workspace.*fatal_failure/s);
});

test("saveProjectOnboarding returns recoverable_failure on db insert error", () => {
  assert.match(saveProject, /recoverable_failure.*db_insert_error|db_insert_error.*recoverable_failure/s);
});

test("saveProjectOnboarding returns recoverable_failure on unexpected exception", () => {
  assert.match(saveProject, /recoverable_failure.*unexpected_exception|unexpected_exception.*recoverable_failure/s);
});

test("saveProjectOnboarding returns success only after confirmed DB insert", () => {
  const returnSuccessIdx = saveProject.indexOf('status: "success", projectId: data.id');
  const insertIdx = saveProject.indexOf('.from("projects")');
  assert.ok(insertIdx > 0, "insert call must exist");
  assert.ok(returnSuccessIdx > 0, "return success statement must exist");
  assert.ok(returnSuccessIdx > insertIdx, "success return must appear after the insert call");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 2: payload validation (fatal_failure rejection)
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding validates project name as required", () => {
  assert.match(saveProject, /projectName.*trim|projectName.*required/s);
});

test("saveProjectOnboarding validates client organization as required", () => {
  assert.match(saveProject, /clientOrganization.*trim|clientOrganization.*required/s);
});

test("saveProjectOnboarding validates PM assigned as required", () => {
  assert.match(saveProject, /pmAssigned.*trim|pmAssigned.*required/s);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 3: structured logs
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding emits project.create.started log", () => {
  assert.match(saveProject, /project\.create\.started/);
});

test("saveProjectOnboarding emits project.create.persisted log on success", () => {
  assert.match(saveProject, /project\.create\.persisted/);
});

test("saveProjectOnboarding emits project.create.failed log on every failure path", () => {
  const matches = [...saveProject.matchAll(/project\.create\.failed/g)];
  assert.ok(matches.length >= 4, `must emit project.create.failed in multiple failure paths, found ${matches.length}`);
});

test("structured logs include correlationId field", () => {
  assert.match(saveProject, /correlationId/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 4: wizard — no false-positive activation
// ─────────────────────────────────────────────────────────────────────────────

test("wizard handleActivate gates navigation on status=success", () => {
  assert.match(wizard, /result\.status !== "success"/, "must check status before proceeding");

  const failureGuardIdx = wizard.indexOf('result.status !== "success"');
  const redirectIdx = wizard.indexOf(PROJECT_CREATED_PUSH);
  assert.ok(failureGuardIdx > 0, "failure guard must exist");
  assert.ok(redirectIdx > failureGuardIdx, "redirect must come after the failure guard");
});

test("wizard has exactly one redirect to the command center after persistence", () => {
  const allPushes = [...wizard.matchAll(/router\.push\(\s*workspaceCommandCenterPath\(result\.workspaceId, \{\s*projectId: result\.projectId,/g)];
  assert.equal(allPushes.length, 1, "redirect to the command center must appear exactly once");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 5: draft preserved on failure (INVARIANT 3)
// ─────────────────────────────────────────────────────────────────────────────

test("wizard does NOT clear draft on failure", () => {
  const guardIdx = wizard.indexOf('result.status !== "success"');
  const clearDraftInSuccessPathIdx = wizard.indexOf("clearDraft();", guardIdx);
  assert.ok(guardIdx > 0, "failure guard must exist");
  assert.ok(clearDraftInSuccessPathIdx > guardIdx, "clearDraft() must only appear after the failure guard (success path)");
});

test("wizard does NOT call clearDraft in the failure return branch", () => {
  const guardIdx = wizard.indexOf('result.status !== "success"');
  // Persistence confirmed comment marks end of failure branch
  const successPathIdx = wizard.indexOf("// Persistence confirmed", guardIdx);
  assert.ok(guardIdx > 0, "failure guard must exist");
  assert.ok(successPathIdx > guardIdx, "success path comment must appear after failure guard");

  const failureBranch = wizard.slice(guardIdx, successPathIdx);
  assert.ok(!failureBranch.includes("clearDraft()"), "clearDraft must NOT appear in failure branch");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 6: blocking error UX — no silent failure
// ─────────────────────────────────────────────────────────────────────────────

test("wizard renders blocking error banner with activation-failed title", () => {
  assert.match(wizard, /Project Brain activation failed|Project creation failed/, "blocking error title must be rendered");
});

test("wizard shows failure class (Fatal / Recoverable) in error banner", () => {
  assert.match(wizard, /Fatal/, "must show Fatal label for fatal_failure");
  assert.match(wizard, /Recoverable/, "must show Recoverable label for recoverable_failure");
});

test("wizard renders Retry button for recoverable failures", () => {
  assert.match(wizard, /onRetry/, "onRetry prop must exist");
  assert.match(wizard, /Retry/, "Retry label must be rendered");
  assert.match(wizard, /onClick=\{onRetry\}/, "Retry button must call onRetry");
});

test("wizard renders 'Return to edit' button for fatal failures", () => {
  assert.match(wizard, /Return to edit/, "Return to edit button must exist");
});

test("wizard shows draft-preserved notice in error state", () => {
  assert.match(wizard, /draft has been preserved/i, "must inform user draft is preserved");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 7: activate button disabled on error (INVARIANT 2)
// ─────────────────────────────────────────────────────────────────────────────

test("activate button is disabled when saveError is set", () => {
  assert.match(wizard, /disabled=\{activating \|\| !contextReady \|\| !!saveError\}/, "activate button must be disabled when saveError is present");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 8: no redirect on failure (INVARIANT 1)
// ─────────────────────────────────────────────────────────────────────────────

test("wizard sets activating=false and returns early on failure", () => {
  const guardIdx = wizard.indexOf('result.status !== "success"');
  const successPathIdx = wizard.indexOf("// Persistence confirmed", guardIdx);
  assert.ok(guardIdx > 0, "failure guard must exist");
  assert.ok(successPathIdx > guardIdx, "success path must come after failure guard");

  const failureBranch = wizard.slice(guardIdx, successPathIdx);
  assert.match(failureBranch, /setActivating\(false\)/, "must reset activating spinner on failure");
  assert.match(failureBranch, /return/, "must return early on failure");
});

test("wizard does NOT call router.push before persistence check", () => {
  // router.push to canonical command center project ID must not appear before the status check
  const persistCheckIdx = wizard.indexOf('result.status !== "success"');
  const firstProjectPushIdx = wizard.indexOf(PROJECT_CREATED_PUSH);
  assert.ok(firstProjectPushIdx > persistCheckIdx, "router.push must not appear before persistence check");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 9: correlationId for retry tracing
// ─────────────────────────────────────────────────────────────────────────────

test("wizard generates correlationId for persistence call tracing", () => {
  assert.match(wizard, /correlationId/, "wizard must pass correlationId to saveProjectOnboarding");
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 10: no activateProjectBrainAction (removed — replaced by three-state contract)
// ─────────────────────────────────────────────────────────────────────────────

test("activateProjectBrainAction redirect-based bypass has been removed", () => {
  assert.ok(
    !saveProject.includes("activateProjectBrainAction"),
    "activateProjectBrainAction must be removed — all flows use three-state contract"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 11: boolean ok pattern has been eliminated
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding does not return boolean ok pattern", () => {
  assert.ok(!saveProject.includes("ok: true"), "must not use boolean ok: true return");
  assert.ok(!saveProject.includes("ok: false"), "must not use boolean ok: false return");
});

test("wizard does not check result.ok (boolean pattern eliminated)", () => {
  assert.ok(!wizard.includes("result.ok"), "wizard must not use legacy result.ok boolean check");
});
