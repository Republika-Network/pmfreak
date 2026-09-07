// Daily Execution Workspace + Task Detail sprint.
//
// Structural/guardrail assertions for the route/service/UI files, matching
// this repo's convention for server-client-coupled code (see
// tests/first-execution-experience.test.ts, tests/execution-tasks.test.mjs).
// Real behavioral coverage for the pure logic lives in
// tests/execution-attention-classification.test.ts and
// tests/execution-task-update-validation.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const taskDetailRoute = read("src/app/api/execution-tasks/[taskId]/route.ts");
const dailyRoute = read("src/app/api/execution-tasks/daily/route.ts");
const updateValidator = read("src/lib/execution-tasks/validate-update-execution-task-input.ts");

// ─── Task detail route: tenancy ────────────────────────────────────────────

test("task detail GET/PATCH resolve the task's own workspace_id from the DB row, never from the client", () => {
  assert.ok(!taskDetailRoute.includes("workspaceId: input"), "must not accept a client-supplied workspaceId");
  assert.ok(!taskDetailRoute.includes("body.workspaceId"), "must not read workspaceId out of the PATCH body");
  assert.match(taskDetailRoute, /task\.workspace_id/, "assignee membership must be checked against the task's own workspace_id");
});

test("task detail PATCH verifies a new assignee is a member of the task's own workspace before saving", () => {
  assert.match(taskDetailRoute, /listWorkspaceMembersForAssignment\(task\.workspace_id\)/);
  assert.match(taskDetailRoute, /Assignee must be a member of this workspace/);
});

test("task detail route never accepts a projectId field on PATCH (no cross-project move in this sprint)", () => {
  assert.ok(!taskDetailRoute.includes("patch.projectId"));
  assert.ok(!taskDetailRoute.includes("body.projectId"));
});

test("task detail GET and PATCH both gate on requireProjectAccess derived from the loaded task, not a client param", () => {
  const occurrences = taskDetailRoute.match(/requireProjectAccess\(task\.project_id,/g) ?? [];
  assert.ok(occurrences.length >= 3, "GET (read), GET (write, for permissions), and PATCH (write) must each check task.project_id");
});

// ─── Task detail route: permissions ────────────────────────────────────────

test("task detail PATCH requires write access before validating or applying any field, including status", () => {
  const patchBody = taskDetailRoute.slice(taskDetailRoute.indexOf("export async function PATCH"));
  const writeCheckIndex = patchBody.indexOf('requireProjectAccess(task.project_id, "write")');
  const validateIndex = patchBody.indexOf("validateUpdateExecutionTaskInput");
  assert.ok(writeCheckIndex > -1 && validateIndex > -1 && writeCheckIndex < validateIndex, "write access must be checked before validation/persistence");
});

test("task detail GET computes canEdit/canAssign from a real write-permission probe, not an unconditional true", () => {
  assert.match(taskDetailRoute, /let canEdit = false;/);
  assert.match(taskDetailRoute, /canEdit = true;/);
});

test("task detail never implements delete — canDelete is always false this sprint (documented scope cut)", () => {
  assert.match(taskDetailRoute, /canDelete: false/);
  assert.ok(!taskDetailRoute.includes("export async function DELETE"));
});

// ─── Task detail route: whitelist / no mass assignment ─────────────────────

test("task detail PATCH only ever writes fields present in the validated whitelist", () => {
  for (const field of ["title", "description", "status", "priority", "assigneeId", "dueDate"]) {
    assert.match(updateValidator, new RegExp(`body\\.${field}`), `validator must explicitly handle ${field}`);
  }
  // No generic spread of the raw body into the DB update.
  assert.ok(!taskDetailRoute.includes("...body"));
  assert.ok(!taskDetailRoute.includes("...patch,"));
});

test("task detail PATCH re-validates status transitions server-side even though the client control only offers valid ones", () => {
  assert.match(taskDetailRoute, /validateUpdateExecutionTaskInput\(body, task\.status\)/);
  assert.match(updateValidator, /isValidStatusTransition/);
});

test("task detail PATCH writes one audit event per changed field, with actor resolved server-side", () => {
  for (const eventType of ["task_title_changed", "task_description_changed", "task_status_changed", "task_priority_changed", "task_assignee_changed", "task_due_date_changed"]) {
    assert.match(taskDetailRoute, new RegExp(eventType));
  }
  assert.match(taskDetailRoute, /actor_user_id: userId/);
  assert.ok(!taskDetailRoute.includes("actor_user_id: body"), "actor must never come from the client body");
});

test("task detail GET never fabricates activity — it reads execution_task_events, returns [] when empty", () => {
  assert.match(taskDetailRoute, /execution_task_events/);
  assert.match(taskDetailRoute, /activity: events \?\? \[\]/);
});

// ─── Daily listing route: tenancy ──────────────────────────────────────────

test("daily route resolves the workspace from the session, never accepts a client-supplied workspaceId", () => {
  assert.match(dailyRoute, /resolvePreferredWorkspace\(userId\)/);
  assert.ok(!dailyRoute.includes('searchParams.get("workspaceId")'), "must not accept a client-supplied workspaceId");
});

test("daily route validates a requested projectId belongs to the resolved workspace before applying it as a filter", () => {
  assert.match(dailyRoute, /projectNameById\.has\(requestedProjectId\)/);
});

test("daily route requires real workspace membership before any task read", () => {
  assert.match(dailyRoute, /requireWorkspaceMember\(workspaceId\)/);
});

test("daily route scopes the execution_tasks query to project ids already confirmed inside this workspace", () => {
  assert.match(dailyRoute, /\.in\("project_id", requestedProjectId \? \[requestedProjectId\] : projectIdsInWorkspace\)/);
});

test("daily route's 'me' assignee filter resolves to the authenticated user's own id, not a client-supplied one", () => {
  assert.match(dailyRoute, /assigneeParam === "me"/);
  assert.match(dailyRoute, /query\.eq\("owner_user_id", userId\)/);
});

// ─── Daily listing route: pagination bound ─────────────────────────────────

test("daily route bounds every response with a max page size — never loads unlimited tasks", () => {
  assert.match(dailyRoute, /MAX_LIMIT/);
  assert.match(dailyRoute, /Math\.min\(limitParam, MAX_LIMIT\)/);
});

// ─── Attention model + validator import correctness (no duplicated mapping) ─

test("attention model imports status/priority enums from the single database-contract source, not a local redefinition", () => {
  const classify = read("src/lib/execution-attention/classify-task-attention.ts");
  assert.match(classify, /from "@\/lib\/db\/database-contract"/);
  assert.ok(!classify.includes('"not_started" | "in_progress"'), "must not redefine the status union locally");
});

test("update validator reuses the canonical lifecycle + priority normalizer rather than redefining them", () => {
  assert.match(updateValidator, /from "\.\/lifecycle"/);
  assert.match(updateValidator, /normalizeTaskPriority/);
});

// ─── Shared components: no duplicated status/priority label mapping ────────

test("TaskStatusControl and TaskPriorityControl import the single label source rather than a local copy", () => {
  const statusControl = read("src/components/pmfreak/execution/task-status-control.tsx");
  const priorityControl = read("src/components/pmfreak/execution/task-priority-control.tsx");
  assert.match(statusControl, /from "@\/lib\/execution-tasks\/task-labels"/);
  assert.match(priorityControl, /from "@\/lib\/execution-tasks\/task-labels"/);
});

test("ProjectTaskList reuses the shared TaskDetailDrawer rather than a second detail implementation", () => {
  const projectTaskList = read("src/components/pmfreak/tasks/project-task-list.tsx");
  assert.match(projectTaskList, /TaskDetailDrawer/);
});

// ─── Regression guardrails: no fabricated data patterns in new surfaces ────

const NEW_FILES = [
  "src/lib/execution-attention/classify-task-attention.ts",
  "src/lib/execution-attention/resolve-execution-section.ts",
  "src/lib/execution-attention/sort-execution-tasks.ts",
  "src/lib/execution-attention/execution-attention-summary.ts",
  "src/lib/execution-tasks/validate-update-execution-task-input.ts",
  "src/app/api/execution-tasks/[taskId]/route.ts",
  "src/app/api/execution-tasks/daily/route.ts",
  "src/components/pmfreak/execution/execution-task-row.tsx",
  "src/components/pmfreak/execution/execution-summary.tsx",
  "src/components/pmfreak/execution/execution-filters.tsx",
  "src/components/pmfreak/execution/task-detail-drawer.tsx",
  "src/components/pmfreak/execution/daily-execution-client.tsx",
  "src/app/(protected)/execution/page.tsx",
];

const FORBIDDEN_FABRICATION_STRINGS = [
  "Sample task",
  "Example project",
  "Welcome task",
  "Demo task",
  "Demo project",
  "PMO Director",
  "Resolution 24h",
  "Execution Health",
  "healthScore",
  "health_score",
  "riskScore",
  "confidenceScore: 0.",
  "AI score",
];

test("no new Daily Execution surface contains fabricated demo/sample data or opaque scores", () => {
  for (const file of NEW_FILES) {
    const src = read(file);
    for (const forbidden of FORBIDDEN_FABRICATION_STRINGS) {
      assert.ok(!src.includes(forbidden), `${file} must not contain "${forbidden}"`);
    }
  }
});

test("attention model never introduces an 'at_risk' or opaque score reason as an actual union member (no approved definition exists)", () => {
  const types = read("src/lib/execution-attention/types.ts");
  const reasonUnion = types.slice(types.indexOf("export type TaskAttentionReason"), types.indexOf("export type TaskAttentionSeverity"));
  assert.ok(!reasonUnion.includes('"at_risk"'), "at_risk must not be a real union member, even if named in the deferral comment");
  assert.ok(!types.includes("attentionScore"));
});

test("attention model does not implement stale_in_progress as a real union member without an approved staleness threshold (documented deferral)", () => {
  const types = read("src/lib/execution-attention/types.ts");
  const reasonUnion = types.slice(types.indexOf("export type TaskAttentionReason"), types.indexOf("export type TaskAttentionSeverity"));
  assert.ok(!reasonUnion.includes('"stale_in_progress"'), "stale_in_progress must not be a real union member yet");
  assert.match(types, /stale_in_progress[\s\S]*not implemented|deliberately not implemented/);
});

test("daily execution workspace distinguishes loading, empty, no-results, and error (never downgrades error to empty)", () => {
  const client = read("src/components/pmfreak/execution/daily-execution-client.tsx");
  assert.match(client, /daily-execution-loading/);
  assert.match(client, /daily-execution-error/);
  assert.match(client, /daily-execution-no-results/);
  assert.match(client, /Unable to load execution work/);
});

test("daily execution summary chips are real counts wired to the same predicate as their filter", () => {
  const summaryComponent = read("src/components/pmfreak/execution/execution-summary.tsx");
  assert.match(summaryComponent, /summary\.needsAttention/);
  assert.match(summaryComponent, /summary\.overdue/);
  assert.ok(!summaryComponent.includes("%"), "summary must not render a percentage/health figure");
});

// ─── Viewer / permission UI behavior ────────────────────────────────────────

test("execution controls render a read-only pill instead of a disabled control when the viewer cannot edit", () => {
  for (const file of [
    "src/components/pmfreak/execution/task-status-control.tsx",
    "src/components/pmfreak/execution/task-assignee-control.tsx",
    "src/components/pmfreak/execution/task-due-date-control.tsx",
    "src/components/pmfreak/execution/task-priority-control.tsx",
  ]) {
    const src = read(file);
    assert.match(src, /if \(!canEdit\)/, `${file} must branch on canEdit rather than always rendering an editable control`);
  }
});

test("task detail drawer explains why editing is unavailable rather than silently hiding controls", () => {
  const drawer = read("src/components/pmfreak/execution/task-detail-drawer.tsx");
  assert.match(drawer, /task-detail-readonly-note/);
  assert.match(drawer, /only project managers and workspace administrators can edit this task/i);
});

// ─── Nav wiring ─────────────────────────────────────────────────────────────

test("navigation hierarchy gives /execution the name Execution, and /command-center the name Command Center", () => {
  // This test used to assert the opposite pairing: "Daily Execution" on /execution while
  // "Execution" named /command-center. That was the naming collision W1 removed — two
  // adjacent nav entries whose labels could not be told apart without knowing the system.
  // The Daily Execution surface itself is unchanged; only what the navigation calls it.
  const hierarchy = read("src/lib/workspace/navigation-hierarchy.ts");
  assert.match(hierarchy, /label: "Execution", href: "\/execution"/);
  assert.match(hierarchy, /label: "Command Center", href: "\/command-center"/);
  assert.doesNotMatch(hierarchy, /label: "Daily Execution"/);
  assert.doesNotMatch(hierarchy, /label: "Execution", href: "\/command-center"/);
});
