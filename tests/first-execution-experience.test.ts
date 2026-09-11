// Project Creation & First Execution Experience.
//
// Covers the direct "Quick Add Task" / minimal "Create Project" path that
// lets a user go from a new workspace to real execution tracking without
// the RAID → Recommended Action → Task Draft chain. Real behavioral tests
// for the pure validation functions; structural/guardrail assertions for
// the route/service/UI files, matching this repo's convention for
// server-client-coupled code (see tests/execution-tasks.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateCreateExecutionTaskInput,
  normalizeTaskPriority,
} from "../src/lib/execution-tasks/create-execution-task";
import { validateCreateMinimalProjectInput } from "../src/lib/projects/create-minimal-project";
import { deriveActivationStage, evaluateActivationRules } from "../src/lib/workspace-activation/activation-rules";
import type { WorkspaceActivationEvidence } from "../src/lib/workspace-activation/types";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ─── Pure validation: createExecutionTaskDirect ────────────────────────────

test("task validation: valid minimal input (title + projectId only) passes", () => {
  const result = validateCreateExecutionTaskInput({ projectId: "p-1", title: "Confirm migration scope" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.title, "Confirm migration scope");
    assert.equal(result.data.priority, "medium", "default priority must be medium (Normal)");
    assert.equal(result.data.assigneeId, null);
    assert.equal(result.data.dueDate, null);
  }
});

test("task validation: empty title is rejected", () => {
  const result = validateCreateExecutionTaskInput({ projectId: "p-1", title: "   " });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.field === "title"));
});

test("task validation: missing projectId is rejected", () => {
  const result = validateCreateExecutionTaskInput({ title: "A task" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.field === "projectId"));
});

test("task validation: title over max length is rejected", () => {
  const result = validateCreateExecutionTaskInput({ projectId: "p-1", title: "x".repeat(201) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.field === "title"));
});

test("task validation: invalid priority is rejected, valid ones pass through", () => {
  const bad = validateCreateExecutionTaskInput({ projectId: "p-1", title: "T", priority: "urgent" });
  assert.equal(bad.ok, false);
  for (const priority of ["low", "medium", "high", "critical"]) {
    const ok = validateCreateExecutionTaskInput({ projectId: "p-1", title: "T", priority });
    assert.equal(ok.ok, true, `priority ${priority} should be valid`);
  }
});

test("task validation: invalid due date is rejected", () => {
  const result = validateCreateExecutionTaskInput({ projectId: "p-1", title: "T", dueDate: "not-a-date" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.field === "dueDate"));
});

test("task validation: valid due date normalizes to ISO", () => {
  const result = validateCreateExecutionTaskInput({ projectId: "p-1", title: "T", dueDate: "2026-09-01" });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.data.dueDate!, /^2026-09-01T/);
});

test("task validation: description over max length is rejected", () => {
  const result = validateCreateExecutionTaskInput({ projectId: "p-1", title: "T", description: "x".repeat(4001) });
  assert.equal(result.ok, false);
});

test("normalizeTaskPriority rejects unknown values and accepts the closed set", () => {
  assert.equal(normalizeTaskPriority("critical"), "critical");
  assert.equal(normalizeTaskPriority("urgent"), null);
  assert.equal(normalizeTaskPriority(123), null);
});

// ─── Pure validation: createMinimalProject ─────────────────────────────────

test("project validation: valid name-only input passes", () => {
  const result = validateCreateMinimalProjectInput({ name: "ERP Phase 2" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.name, "ERP Phase 2");
    assert.equal(result.data.description, null);
    assert.equal(result.data.pmoId, null);
  }
});

test("project validation: empty name is rejected", () => {
  const result = validateCreateMinimalProjectInput({ name: "   " });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.field === "name"));
});

test("project validation: name over max length is rejected", () => {
  const result = validateCreateMinimalProjectInput({ name: "x".repeat(201) });
  assert.equal(result.ok, false);
});

test("project validation: description over max length is rejected", () => {
  const result = validateCreateMinimalProjectInput({ name: "Valid", description: "x".repeat(4001) });
  assert.equal(result.ok, false);
});

test("project validation: non-string pmoId is rejected", () => {
  const result = validateCreateMinimalProjectInput({ name: "Valid", pmoId: 123 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((e) => e.field === "pmoId"));
});

// ─── Activation matrix (deriveActivationStage / evaluateActivationRules) ───
// The rules module is unchanged by this sprint — these tests pin that a
// manually-created task (task_draft_id null) is evidenced identically to a
// converted one, since evidence is a presence probe with no source filter.

const baseEvidence = (overrides: Partial<WorkspaceActivationEvidence> = {}): WorkspaceActivationEvidence => ({
  workspaceId: "ws-1",
  userId: "user-1",
  role: "owner",
  ownerType: null,
  memberCount: 1,
  pendingInviteExists: false,
  pmoExists: false,
  projectExists: false,
  taskExists: false,
  milestoneExists: false,
  raidItemExists: false,
  governanceSignalExists: false,
  recommendedActionExists: false,
  userMessageExists: false,
  insightsFirstViewedAt: null,
  ...overrides,
});

test("activation matrix: 0 projects / 0 tasks -> stage workspace_created, not operationally started", () => {
  const evidence = baseEvidence();
  assert.equal(deriveActivationStage(evidence), "workspace_created");
  assert.equal(evaluateActivationRules(evidence).operationallyStarted, false);
});

test("activation matrix: 1 project / 0 tasks -> stage project_created, not operationally started", () => {
  const evidence = baseEvidence({ projectExists: true });
  assert.equal(deriveActivationStage(evidence), "project_created");
  assert.equal(evaluateActivationRules(evidence).operationallyStarted, false);
});

test("activation matrix: 1 project / 1 task (manual, no RAID/signal) -> execution_started, operationally started", () => {
  const evidence = baseEvidence({ projectExists: true, taskExists: true });
  assert.equal(deriveActivationStage(evidence), "execution_started");
  assert.equal(evaluateActivationRules(evidence).operationallyStarted, true);
});

test("activation matrix: multiple projects behave the same as one for the boolean probes", () => {
  // Evidence is presence-only (boolean), not a count — this pins that a
  // second/third project does not change the stage computation.
  const evidence = baseEvidence({ projectExists: true, taskExists: true });
  assert.equal(deriveActivationStage(evidence), "execution_started");
});

test("activation matrix: a task existing without a project cannot happen in evidence terms (project gates the stage)", () => {
  // taskExists true with projectExists false is not a real reachable state
  // (a task always belongs to a real project), but the rule must still not
  // report execution_started off task evidence alone.
  const evidence = baseEvidence({ projectExists: false, taskExists: true });
  assert.equal(deriveActivationStage(evidence), "workspace_created");
});

// ─── Migration ───────────────────────────────────────────────────────────

const migration = read("supabase/migrations/20260830000000_execution_tasks_optional_draft.sql");

test("migration makes task_draft_id nullable via an additive ALTER, not a rewrite", () => {
  assert.match(migration, /alter table public\.execution_tasks/);
  assert.match(migration, /alter column task_draft_id drop not null/);
});

test("migration does not touch task_drafts or recommended_actions", () => {
  // No DDL against either table — only the explanatory comment mentions
  // task_drafts (to say why it's intentionally untouched).
  assert.ok(!/alter table public\.task_drafts/.test(migration));
  assert.ok(!/alter table public\.recommended_actions/.test(migration));
  assert.ok(!migration.includes("recommended_actions"));
});

// ─── Database contract ──────────────────────────────────────────────────────

const contract = read("src/lib/db/database-contract.ts");

test("database contract: ExecutionTaskRow.task_draft_id is nullable", () => {
  assert.match(contract, /task_draft_id: string \| null/);
});

test("database contract: version references the first-execution-experience sprint", () => {
  assert.match(contract, /first-execution-experience/);
});

// ─── Direct task creation service + route ──────────────────────────────────

const createTaskService = read("src/lib/execution-tasks/create-execution-task.ts");
const executionTasksRoute = read("src/app/api/execution-tasks/route.ts");

test("createExecutionTaskDirect never requires a task draft, recommended action, or RAID item", () => {
  assert.match(createTaskService, /task_draft_id:\s*null/);
  assert.match(createTaskService, /recommended_action_id:\s*null/);
  assert.match(createTaskService, /raid_item_id:\s*null/);
});

test("createExecutionTaskDirect tags manual origin without a new source column", () => {
  assert.match(createTaskService, /source:\s*"manual"/);
  assert.match(createTaskService, /source_payload/);
});

test("createExecutionTaskDirect enforces write access via the canonical capability gate", () => {
  assert.match(createTaskService, /requireProjectAccess\(project\.id,\s*"write"\)/);
});

test("createExecutionTaskDirect resolves workspace from the project row, never trusts a client workspaceId", () => {
  assert.match(createTaskService, /project\.workspace_id/);
  assert.ok(!/workspaceId:\s*input\.workspaceId/.test(createTaskService), "must not accept a client-supplied workspaceId");
});

test("createExecutionTaskDirect rejects an assignee who is not a member of the project's workspace", () => {
  assert.match(createTaskService, /workspace_memberships/);
  assert.match(createTaskService, /Assignee must be a member of this workspace/);
});

test("createExecutionTaskDirect rejects tasks on archived projects", () => {
  assert.match(createTaskService, /archived/);
});

test("createExecutionTaskDirect always creates tasks as not_started (canonical initial state)", () => {
  assert.match(createTaskService, /status:\s*"not_started"/);
});

test("createExecutionTaskDirect writes a task_created activity event", () => {
  assert.match(createTaskService, /execution_task_events/);
  assert.match(createTaskService, /task_created/);
});

test("execution-tasks route exposes POST for direct creation alongside the existing GET", () => {
  assert.match(executionTasksRoute, /export async function GET/);
  assert.match(executionTasksRoute, /export async function POST/);
  assert.match(executionTasksRoute, /createExecutionTaskDirect/);
});

test("execution-tasks POST maps validation/auth/tenancy failures to distinct HTTP statuses", () => {
  assert.match(executionTasksRoute, /unauthenticated:\s*401/);
  assert.match(executionTasksRoute, /unauthorized:\s*403/);
  assert.match(executionTasksRoute, /validation_failed:\s*400/);
});

test("advanced RAID conversion pipeline is untouched by the direct path", () => {
  const converter = read("src/lib/execution-tasks/convert-task-draft.ts");
  assert.match(converter, /export async function convertTaskDraftToExecutionTask/);
  assert.match(converter, /draft_status !== "approved"/);
  assert.ok(!converter.includes("createExecutionTaskDirect"), "conversion path must not depend on the new direct path");
});

// ─── Direct project creation service + route ───────────────────────────────

const createProjectService = read("src/lib/projects/create-minimal-project.ts");
const projectsRoute = read("src/app/api/projects/route.ts");
const projectActions = read("src/app/(protected)/projects/actions.ts");

test("createMinimalProject is the single service both the inline form and the API route call", () => {
  assert.match(projectActions, /createMinimalProject/);
  assert.match(projectsRoute, /createMinimalProject/);
});

test("createMinimalProject resolves the write workspace server-side, never trusts a client workspaceId", () => {
  assert.match(createProjectService, /resolveWriteWorkspace\(userId\)/);
  assert.ok(!createProjectService.includes("input.workspaceId"), "must not accept a client-supplied workspaceId");
});

test("createMinimalProject rejects a PMO not found in the resolved workspace", () => {
  assert.match(createProjectService, /getPmoById\(ensured\.workspaceId, pmoId\)/);
  assert.match(createProjectService, /Selected PMO was not found/);
});

test("createMinimalProject does not fabricate budget, governance, health score, or risk fields", () => {
  // Field-like (colon-suffixed) usage only — the module's own doc comment
  // legitimately names these fields as things it deliberately excludes.
  for (const forbidden of ["budget:", "healthScore:", "health_score:", "riskRegister:", "milestones:"]) {
    assert.ok(!createProjectService.includes(forbidden), `must not fabricate ${forbidden}`);
  }
});

test("projects route exposes POST for minimal creation alongside the existing GET", () => {
  assert.match(projectsRoute, /export async function GET/);
  assert.match(projectsRoute, /export async function POST/);
});

// ─── Workspace members for assignment ──────────────────────────────────────

const workspaceTeam = read("src/lib/workspace-team.ts");
const membersRoute = read("src/app/api/workspace-team/members/route.ts");

test("listWorkspaceMembersForAssignment requires real workspace membership before any read", () => {
  assert.match(workspaceTeam, /export async function listWorkspaceMembersForAssignment/);
  assert.match(workspaceTeam, /await requireWorkspaceMember\(workspaceId\)/);
});

test("listWorkspaceMembersForAssignment reads real workspace_memberships, not the separate pm-registry directory", () => {
  const fnBody = workspaceTeam.slice(workspaceTeam.indexOf("export async function listWorkspaceMembersForAssignment"));
  assert.match(fnBody, /workspace_memberships/);
  assert.ok(!fnBody.includes("pm-registry") && !fnBody.includes("pm_registry"));
});

test("privileged-access registry documents the new listWorkspaceMembersForAssignment usage", () => {
  const registry = read("src/lib/security/privileged-access-registry.ts");
  assert.match(registry, /listWorkspaceMembersForAssignment/);
});

test("members route derives workspace from projectId server-side rather than trusting it directly", () => {
  assert.match(membersRoute, /getProjectWorkspaceId\(projectId\)/);
});

// ─── UI wiring: CTAs open modals, no longer route to Command Center ────────

const emptyStates = read("src/components/pmfreak/empty-states/workspace-empty-state.tsx");

test("EmptyDashboard/EmptyProjects/EmptyPortfolio no longer link create-project to /command-center", () => {
  assert.ok(!emptyStates.includes('href: "/command-center"'), "create-project CTA must open the modal, not link to Command Center");
});

test("EmptyExecution opens the Quick Add Task / Create Project modals contextually", () => {
  assert.match(emptyStates, /AddTaskCta/);
  assert.match(emptyStates, /CreateProjectCta/);
});

const onboardingPanel = read("src/components/pmfreak/onboarding/workspace-onboarding-panel.tsx");

test("onboarding panel opens Quick Add Task for the task_created step instead of linking to Command Center", () => {
  assert.match(onboardingPanel, /AddTaskCta/);
  assert.match(onboardingPanel, /step\.id === "task_created"/);
});

test("onboarding activation rules are unmodified by the CTA wiring change (still evidence-derived)", () => {
  const rules = read("src/lib/workspace-activation/activation-rules.ts");
  assert.match(rules, /completed: \(e\) => e\.taskExists/);
});

// ─── Project landing / first execution view ────────────────────────────────

const projectTaskList = read("src/components/pmfreak/tasks/project-task-list.tsx");
// Project Home is the canonical, workspace-rooted route; `/projects/[id]` now
// holds no screen and resolves into it (canonical Project Home slice).
const projectDetailPage = read("src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/page.tsx");

test("project landing page renders the real task list, not a new board route", () => {
  assert.match(projectDetailPage, /ProjectTaskList/);
});

test("project landing computes canCreateTask from real membership role in the PROJECT's workspace", () => {
  // Still a real membership role, and still only a UI gate — the server actions,
  // `requireProjectAccess` and RLS remain the enforcement. What changed is WHICH
  // workspace's membership is read.
  //
  // It used to be `resolvePreferredWorkspace(user.id)` — the COOKIE — "the same
  // pattern as the projects list page". That comparison was the defect: the list
  // page asks a workspace-scoped question (may I create a project in the
  // workspace I am in?), while Project Home asks a project-scoped one (may I add
  // work to THIS project?), and this project lives in whatever workspace owns it.
  // When the two differed the page authorized one workspace and gated its controls
  // against another. The role now comes from the same verdict that established the
  // project's parent, so the two cannot disagree.
  assert.match(projectDetailPage, /const canCreateTask = access\.role !== null && access\.role !== "viewer";/);
  // Comments stripped: the page RECORDS the defect it replaced, which means naming
  // the cookie resolver. A check that cannot tell an explanation from a call would
  // push that reasoning out of the code.
  const projectDetailCode = projectDetailPage.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(projectDetailCode, /resolvePreferredWorkspace/);
  assert.match(projectDetailPage, /resolveRoutedProject\(user\.id, requestedWorkspaceId, requestedProjectId\)/);
});

test("project task list distinguishes empty, loading, and error states (never silently downgrades error to empty)", () => {
  assert.match(projectTaskList, /project-task-list-empty/);
  assert.match(projectTaskList, /project-task-list-loading/);
  assert.match(projectTaskList, /project-task-list-error/);
  assert.match(projectTaskList, /No work has been added yet/);
  assert.match(projectTaskList, /Unable to load project tasks/);
});

test("project task list omits unset fields rather than printing placeholder noise", () => {
  assert.ok(!projectTaskList.includes("No owner"));
  assert.ok(!projectTaskList.includes("No date"));
  assert.match(projectTaskList, /task\.owner_name &&/);
  assert.match(projectTaskList, /task\.due_date &&/);
});

test("project task list constrains status changes to isValidStatusTransition", () => {
  assert.match(projectTaskList, /isValidStatusTransition/);
});

test("project task list shows a restricted note (no dead CTA) when the viewer cannot create tasks", () => {
  assert.match(projectTaskList, /A project manager or workspace administrator must add the first task/);
});

// ─── Modal accessibility ────────────────────────────────────────────────────

const modal = read("src/components/pmfreak/ui/modal.tsx");

test("shared modal traps focus, closes on Escape, and returns focus on close", () => {
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /event\.key === "Escape"/);
  assert.match(modal, /triggerElementRef\.current\?\.focus\(\)/);
});

const quickAddTaskModal = read("src/components/pmfreak/tasks/quick-add-task-modal.tsx");
const createProjectModal = read("src/components/pmfreak/projects/create-project-modal.tsx");

test("Quick Add Task modal offers Add another task without forcing a full reopen", () => {
  assert.match(quickAddTaskModal, /Add another task/);
});

test("Quick Add Task modal shows a blocked state with a real path to create a project first", () => {
  assert.match(quickAddTaskModal, /Create a project first/);
});

test("Create Project modal shows discreet success copy, not an excessive celebration", () => {
  assert.match(createProjectModal, /Project created/);
  assert.match(createProjectModal, /Add the first task to begin tracking execution/);
});

// ─── Regression guardrails: no fabricated data patterns reintroduced ───────

const NEW_FILES = [
  "src/lib/execution-tasks/create-execution-task.ts",
  "src/lib/projects/create-minimal-project.ts",
  "src/lib/workspace-team.ts",
  "src/components/pmfreak/tasks/quick-add-task-modal.tsx",
  "src/components/pmfreak/tasks/project-task-list.tsx",
  "src/components/pmfreak/projects/create-project-modal.tsx",
  "src/components/pmfreak/empty-states/workspace-empty-state.tsx",
  "src/components/pmfreak/onboarding/workspace-onboarding-panel.tsx",
];

const FORBIDDEN_FABRICATION_STRINGS = [
  "Sample task",
  "Example project",
  "Welcome task",
  "Demo project",
  "PMO Director",
  "Resolution 24h",
  "Portfolio Confidence",
];

test("first-execution-experience surface contains no fabricated demo/sample data strings", () => {
  for (const file of NEW_FILES) {
    const src = read(file);
    for (const forbidden of FORBIDDEN_FABRICATION_STRINGS) {
      assert.ok(!src.includes(forbidden), `${file} must not contain "${forbidden}"`);
    }
  }
});

test("quick add task never assigns a fake due date, owner, or priority beyond documented defaults", () => {
  // Defaults must be exactly: status not_started, priority medium (Normal),
  // assignee/due date null unless explicitly supplied by the user.
  assert.match(createTaskService, /priority:\s*ExecutionTaskPriority\s*=\s*"medium"/);
  assert.ok(!createTaskService.includes("new Date()"), "must not stamp an automatic due date");
});

test("no mutation path creates an execution task from the client without going through the server route", () => {
  // The client modal must always call the API route (fetch), never insert
  // into execution_tasks directly from a "use client" file.
  assert.ok(!quickAddTaskModal.includes("createSupabaseServerClient"));
  assert.ok(!quickAddTaskModal.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assert.match(quickAddTaskModal, /fetch\("\/api\/execution-tasks"/);
});
