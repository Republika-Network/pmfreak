/**
 * Create Project Brain — transactional hardening contract tests.
 *
 * Static-analysis tests (readFileSync + assert) that enforce:
 * - Explicit three-state contract with correlationId and failureClass
 * - No false-positive Brain activation (no redirect/clearDraft/localStorage on failure)
 * - Rollback events on downstream failure
 * - Structured log events for every outcome
 * - Retry preserves input and emits retry event
 * - projectId required for navigation and Command Center hydration
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const saveProject = readFileSync(join(ROOT, "src/lib/projects/save-project-onboarding.ts"), "utf8");
const wizard = readFileSync(join(ROOT, "src/components/pmfreak/projects/create-project-wizard.tsx"), "utf8");
// Project Home is now the canonical, workspace-rooted route; `/projects/[id]`
// holds no screen and resolves into it (canonical Project Home slice). The
// property these tests guard — a project detail screen never renders for a
// project that is not in the database — is asserted on both halves of that seam
// below.
const projectDetailPage = readFileSync(
  join(ROOT, "src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/page.tsx"),
  "utf8"
);
const legacyProjectDetailRoute = readFileSync(
  join(ROOT, "src/app/(protected)/projects/[id]/page.tsx"),
  "utf8"
);
const routedProjectResolver = readFileSync(join(ROOT, "src/lib/projects/routed-project.ts"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// 1. success — explicit contract
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding success result includes projectId, correlationId, and briefStatus", () => {
  assert.match(
    saveProject,
    /status: "success", projectId: data\.id, correlationId: cid, briefStatus/,
    "success return must include projectId, correlationId, and briefStatus"
  );
});

test("saveProjectOnboarding emits project.create.success on the success path", () => {
  assert.match(saveProject, /project\.create\.success/);
  const persistedIdx = saveProject.indexOf("project.create.persisted");
  const successIdx = saveProject.indexOf("project.create.success");
  assert.ok(successIdx > persistedIdx, "project.create.success must be emitted after project.create.persisted");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. recoverable failure — contract shape
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding recoverable_failure result includes failureClass and correlationId", () => {
  assert.match(saveProject, /status: "recoverable_failure"[^}]*failureClass/s);
  assert.match(saveProject, /status: "recoverable_failure"[^}]*correlationId/s);
});

test("saveProjectOnboarding returns recoverable_failure on db_insert_error", () => {
  assert.match(saveProject, /db_insert_error/);
  assert.match(saveProject, /recoverable_failure.*db_insert_error|db_insert_error.*recoverable_failure/s);
});

test("saveProjectOnboarding returns recoverable_failure on unexpected_exception", () => {
  assert.match(saveProject, /unexpected_exception/);
  assert.match(saveProject, /recoverable_failure.*unexpected_exception|unexpected_exception.*recoverable_failure/s);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. fatal failure — contract shape
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding fatal_failure result includes failureClass and correlationId", () => {
  assert.match(saveProject, /status: "fatal_failure"[^}]*failureClass/s);
  assert.match(saveProject, /status: "fatal_failure"[^}]*correlationId/s);
});

test("saveProjectOnboarding returns fatal_failure with failureClass=unauthenticated", () => {
  assert.match(saveProject, /failureClass: "unauthenticated"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. retry preserves input
// ─────────────────────────────────────────────────────────────────────────────

test("wizard handleRetry resets error state before retrying", () => {
  const retryFnIdx = wizard.indexOf("const handleRetry");
  assert.ok(retryFnIdx > 0, "handleRetry must be defined");
  const retryFnBody = wizard.slice(retryFnIdx, retryFnIdx + 300);
  assert.match(retryFnBody, /setSaveError\(null\)/, "must clear saveError on retry");
  assert.match(retryFnBody, /setSaveFailureClass\(null\)/, "must clear saveFailureClass on retry");
});

test("wizard emits project.create.retry event before retrying", () => {
  assert.match(wizard, /project\.create\.retry/, "must emit retry event");
  const retryLogIdx = wizard.indexOf("project.create.retry");
  const setActivatingIdx = wizard.indexOf("void handleActivate()");
  assert.ok(retryLogIdx < setActivatingIdx, "retry log must be emitted before re-invoking handleActivate");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. no redirect on failure
// ─────────────────────────────────────────────────────────────────────────────

test("wizard does not call router.push before status check", () => {
  const statusCheckIdx = wizard.indexOf('result.status !== "success"');
  const pushIdx = wizard.indexOf("router.push(`/command-center?projectId=${result.projectId}");
  assert.ok(statusCheckIdx > 0, "status check must exist");
  assert.ok(pushIdx > statusCheckIdx, "router.push must not appear before the status check");
});

test("wizard returns early without navigation on failure", () => {
  const guardIdx = wizard.indexOf('result.status !== "success"');
  const successPathIdx = wizard.indexOf("// Persistence confirmed", guardIdx);
  const failureBranch = wizard.slice(guardIdx, successPathIdx);
  assert.match(failureBranch, /return/, "failure branch must return early");
  assert.ok(!failureBranch.includes("router.push"), "failure branch must not call router.push");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. draft preserved on failure
// ─────────────────────────────────────────────────────────────────────────────

test("wizard does not call clearDraft before persistence is confirmed", () => {
  const guardIdx = wizard.indexOf('result.status !== "success"');
  const successPathIdx = wizard.indexOf("// Persistence confirmed", guardIdx);
  const failureBranch = wizard.slice(guardIdx, successPathIdx);
  assert.ok(!failureBranch.includes("clearDraft()"), "clearDraft must NOT be called in the failure branch");
});

test("wizard clears draft only after confirmed persistence", () => {
  const persistedIdx = wizard.indexOf("// Persistence confirmed");
  const clearIdx = wizard.indexOf("clearDraft();", persistedIdx);
  assert.ok(persistedIdx > 0, "success path marker must exist");
  assert.ok(clearIdx > persistedIdx, "clearDraft() must appear in the success path only");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. localStorage / cache blocked on failure
// ─────────────────────────────────────────────────────────────────────────────

test("wizard never writes to localStorage during activation (only during field editing)", () => {
  // saveDraft is called by updateIdentity/updateDelivery/updateDiscovery, not by handleActivate
  const activateIdx = wizard.indexOf("const handleActivate");
  const retryIdx = wizard.indexOf("const handleRetry");
  // Neither handleActivate nor handleRetry should call saveDraft
  const activateBody = wizard.slice(activateIdx, retryIdx);
  assert.ok(!activateBody.includes("saveDraft("), "handleActivate must not call saveDraft()");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. no false-positive project activation
// ─────────────────────────────────────────────────────────────────────────────

test("activate button disabled when saveError is present", () => {
  assert.match(
    wizard,
    /disabled=\{activating \|\| !contextReady \|\| !!saveError\}/,
    "activate button must be disabled when saveError is set"
  );
});

test("wizard has exactly one router.push to the command center with projectId and only on success", () => {
  const allPushes = [...wizard.matchAll(/router\.push\(`\/command-center\?projectId=\$\{result\.projectId/g)];
  assert.equal(allPushes.length, 1, "router.push to the command center must appear exactly once");
});



test("wizard lands in the command center scoped to the new project after activation success", () => {
  // Founder Operational Loop sprint: creating a project lands in the Command
  // Center for that project, already showing the intelligence derived from
  // the onboarding context (supersedes Workspace → PMO → Project Change 9).
  assert.equal(
    /router\.push\(`\/projects\/\$\{result\.projectId/.test(wizard),
    false,
    "wizard must not land users on the project overview after activation"
  );
  assert.match(
    wizard,
    /router\.push\(`\/command-center\?projectId=\$\{result\.projectId\}/,
    "wizard must land users in the command center scoped to the created project"
  );
});

test("wizard guards activation against duplicate final navigation", () => {
  assert.match(wizard, /navigationCommittedRef/, "navigation committed ref must exist");
  assert.match(wizard, /activationInFlightRef/, "activation in-flight ref must exist");
  assert.match(
    wizard,
    /activationInFlightRef\.current \|\| navigationCommittedRef\.current/,
    "handleActivate must return when activation/navigation is already in flight"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. rollback path
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding tracks insertedProjectId for potential rollback", () => {
  assert.match(saveProject, /insertedProjectId/, "must track insertedProjectId");
  assert.match(saveProject, /insertedProjectId = data\.id/, "must set insertedProjectId after confirmed insert");
});

test("saveProjectOnboarding emits project.create.rollback.started before rollback delete", () => {
  assert.match(saveProject, /project\.create\.rollback\.started/);
  const startedIdx = saveProject.indexOf("project.create.rollback.started");
  const deleteIdx = saveProject.indexOf(".delete()", startedIdx);
  assert.ok(deleteIdx > startedIdx, "rollback.started must precede the delete call");
});

test("saveProjectOnboarding emits project.create.rollback.completed on successful rollback", () => {
  assert.match(saveProject, /project\.create\.rollback\.completed/);
});

test("saveProjectOnboarding emits project.create.rollback.failed on failed rollback", () => {
  assert.match(saveProject, /project\.create\.rollback\.failed/);
});

test("saveProjectOnboarding issues delete on rollback", () => {
  assert.match(saveProject, /\.delete\(\)/, "rollback must issue a delete");
  assert.match(saveProject, /\.eq\("id", insertedProjectId\)/, "rollback must target the specific project row");
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. structured logs emitted
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding emits all required structured log events", () => {
  const required = [
    "project.create.started",
    "project.create.persisted",
    "project.create.success",
    "project.create.failed",
    "project.create.rollback.started",
    "project.create.rollback.completed",
    "project.create.rollback.failed",
  ];
  for (const event of required) {
    assert.ok(saveProject.includes(event), `must emit ${event}`);
  }
});

test("structured logs include correlationId field", () => {
  assert.match(saveProject, /correlationId/);
  const emitCalls = [...saveProject.matchAll(/emit\(/g)];
  assert.ok(emitCalls.length >= 6, `emit must be called at least 6 times (found ${emitCalls.length})`);
});

test("structured logs include timestamp via emit helper", () => {
  assert.match(saveProject, /function emit\(/, "emit helper must be defined");
  assert.match(saveProject, /timestamp.*new Date\(\)\.toISOString\(\)|new Date\(\)\.toISOString\(\).*timestamp/s);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. missing workspace rejection
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding rejects with fatal_failure when workspace is missing", () => {
  assert.match(saveProject, /missing_workspace/);
  assert.match(saveProject, /fatal_failure.*missing_workspace|missing_workspace.*fatal_failure/s);
});

test("saveProjectOnboarding returns recoverable_failure when workspace resolution throws", () => {
  assert.match(saveProject, /workspace_error/);
  assert.match(saveProject, /recoverable_failure.*workspace_error|workspace_error.*recoverable_failure/s);
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. invalid payload rejection
// ─────────────────────────────────────────────────────────────────────────────

test("saveProjectOnboarding validates all required payload fields", () => {
  assert.match(saveProject, /projectName.*trim/s);
  assert.match(saveProject, /clientOrganization.*trim/s);
  assert.match(saveProject, /pmAssigned.*trim/s);
  assert.match(saveProject, /problemStatement.*trim/s);
  assert.match(saveProject, /mainDeliverable.*trim/s);
});

test("saveProjectOnboarding returns fatal_failure with failureClass=invalid_payload for bad input", () => {
  assert.match(saveProject, /failureClass: "invalid_payload"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. projectId required for navigation
// ─────────────────────────────────────────────────────────────────────────────

test("wizard navigates only using result.projectId from a confirmed success result", () => {
  assert.match(wizard, /router\.push\(`\/command-center\?projectId=\$\{result\.projectId\}/);
  // projectId in the navigation comes from result, not from any intermediate variable
  const navIdx = wizard.indexOf("router.push(`/command-center?projectId=${result.projectId}");
  assert.ok(navIdx > 0, "navigation must use result.projectId");
});

test("saveProjectOnboarding does not return a projectId on any failure path", () => {
  // All failure returns should NOT include projectId
  const recoverableReturns = [...saveProject.matchAll(/return \{[^}]*status: "recoverable_failure"[^}]*\}/gs)];
  const fatalReturns = [...saveProject.matchAll(/return \{[^}]*status: "fatal_failure"[^}]*\}/gs)];
  for (const m of [...recoverableReturns, ...fatalReturns]) {
    assert.ok(!m[0].includes("projectId"), `failure return must not include projectId: ${m[0]}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. command center blocked without persisted projectId
// ─────────────────────────────────────────────────────────────────────────────

test("project detail page refuses before rendering when the project is not in DB", () => {
  // The refusal is no longer `notFound()`. Canonical Project Home shares ONE
  // refusal component with the legacy resolver, so a missing project, a deleted
  // one, one the caller has no membership for, and one whose routed workspace
  // disagrees with `projects.workspace_id` are indistinguishable — a distinct 404
  // path would be a second, distinguishable reply and turn the route into an
  // existence oracle. The guarantee this test exists for is unchanged: nothing
  // renders until a real project row has been read.
  assert.match(
    projectDetailPage,
    /return <ProjectNotAvailable \/>;/,
    "canonical project detail page must refuse if the project is not in DB"
  );
  assert.match(
    projectDetailPage,
    /if \(!project\) return <ProjectNotAvailable \/>;/,
    "the refusal must be gated on the absent project row itself"
  );
  // And the legacy entry point refuses the same way rather than redirecting into
  // a screen for a project that does not resolve.
  assert.match(legacyProjectDetailRoute, /access\.access === "denied"/);
  assert.match(legacyProjectDetailRoute, /return <ProjectNotAvailable \/>;/);
});

test("project detail page fetches project from DB before rendering", () => {
  assert.match(
    projectDetailPage,
    /\.from\("projects"\)|from\('projects'\)/,
    "project detail page must query DB to verify project exists"
  );
  // The legacy route holds no screen, so it queries through the shared routed
  // resolver — which reads the project row before anything is authorized or
  // redirected.
  assert.match(routedProjectResolver, /\.from\("projects"\)/);
  assert.match(legacyProjectDetailRoute, /resolveLegacyProjectRoute\(user\.id, id\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus: no activateProjectBrainAction bypass
// ─────────────────────────────────────────────────────────────────────────────

test("activateProjectBrainAction bypass does not exist in save-project-onboarding", () => {
  assert.ok(
    !saveProject.includes("activateProjectBrainAction"),
    "activateProjectBrainAction must not exist — all activation goes through three-state contract"
  );
});

test("saveProjectOnboarding does not use boolean ok pattern", () => {
  assert.ok(!saveProject.includes("ok: true"), "must not return boolean ok: true");
  assert.ok(!saveProject.includes("ok: false"), "must not return boolean ok: false");
});
