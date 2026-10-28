import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const migration = fs.readFileSync("supabase/migrations/20260605060000_task_drafts.sql", "utf8");
const engine = fs.readFileSync("src/lib/task-drafts/generate-task-draft.ts", "utf8");
const materializer = fs.readFileSync("src/lib/task-drafts/materialize-task-draft.ts", "utf8");
const indexFile = fs.readFileSync("src/lib/task-drafts/index.ts", "utf8");
const fromActionRoute = fs.readFileSync("src/app/api/task-drafts/from-recommended-action/route.ts", "utf8");
const listRoute = fs.readFileSync("src/app/api/task-drafts/route.ts", "utf8");
const statusRoute = fs.readFileSync("src/app/api/task-drafts/status/route.ts", "utf8");
const shell = fs.readFileSync("src/components/pmfreak/operational-shell.tsx", "utf8");
const contract = fs.readFileSync("src/lib/db/database-contract.ts", "utf8");

// ── Migration ─────────────────────────────────────────────────────────────────

test("task_drafts migration creates table", () => {
  assert.match(migration, /create table if not exists public\.task_drafts/);
});

test("task_drafts migration has all required columns", () => {
  for (const col of [
    "id", "workspace_id", "project_id", "recommended_action_id", "raid_item_id",
    "title", "description", "draft_status", "suggested_owner", "suggested_due_date",
    "suggested_due_window", "priority", "source_type", "source_payload",
    "acceptance_criteria", "checklist", "confidence_score",
    "created_by", "created_at", "updated_at",
  ]) {
    assert.match(migration, new RegExp(`\\b${col}\\b`), `column ${col} missing from migration`);
  }
});

test("task_drafts migration enforces draft_status constraint", () => {
  assert.match(migration, /draft_status in/);
  for (const s of ["draft", "reviewed", "approved", "discarded", "converted_to_task"]) {
    assert.match(migration, new RegExp(`'${s}'`), `draft_status value '${s}' missing`);
  }
});

test("task_drafts migration enforces priority constraint", () => {
  assert.match(migration, /priority in/);
  for (const p of ["low", "medium", "high", "critical"]) {
    assert.match(migration, new RegExp(`'${p}'`), `priority value '${p}' missing`);
  }
});

test("task_drafts migration has unique(workspace_id, recommended_action_id)", () => {
  assert.match(migration, /task_drafts_workspace_action_uidx/);
  assert.match(migration, /workspace_id, recommended_action_id/);
});

test("task_drafts migration has required indexes", () => {
  assert.match(migration, /task_drafts_workspace_idx/);
  assert.match(migration, /task_drafts_project_idx/);
  assert.match(migration, /task_drafts_recommended_action_idx/);
  assert.match(migration, /task_drafts_draft_status_idx/);
  assert.match(migration, /task_drafts_priority_idx/);
});

test("task_drafts migration enables RLS with workspace member policy", () => {
  assert.match(migration, /enable row level security/);
  assert.match(migration, /is_workspace_member\(workspace_id\)/);
});

test("task_drafts migration has select, insert, and update policies", () => {
  assert.match(migration, /workspace members can read task_drafts/);
  assert.match(migration, /workspace members can insert task_drafts/);
  assert.match(migration, /workspace members can update task_drafts/);
});

test("task_drafts migration has updated_at trigger", () => {
  assert.match(migration, /set_updated_at/);
  assert.match(migration, /before update on public\.task_drafts/);
});

// ── Database Contract ─────────────────────────────────────────────────────────

test("database contract declares TaskDraftRow", () => {
  assert.match(contract, /TaskDraftRow/);
});

test("database contract declares TASK_DRAFT_SELECTABLE_COLUMNS", () => {
  assert.match(contract, /TASK_DRAFT_SELECTABLE_COLUMNS/);
});

test("database contract TaskDraftRow includes all columns", () => {
  for (const col of [
    "id", "workspace_id", "project_id", "recommended_action_id", "raid_item_id",
    "title", "description", "draft_status", "suggested_owner", "suggested_due_date",
    "suggested_due_window", "priority", "source_type", "source_payload",
    "acceptance_criteria", "checklist", "confidence_score",
    "created_by", "created_at", "updated_at",
  ]) {
    assert.match(contract, new RegExp(`"${col}"`), `column ${col} missing from TASK_DRAFT_SELECTABLE_COLUMNS`);
  }
});

// ── Generation Engine ─────────────────────────────────────────────────────────

test("engine exports generateTaskDraftFromRecommendedAction", () => {
  assert.match(engine, /export function generateTaskDraftFromRecommendedAction/);
});

test("engine maps impact_level critical to priority critical", () => {
  assert.match(engine, /case "critical": return "critical"/);
});

test("engine maps impact_level high to priority high", () => {
  assert.match(engine, /case "high":.*return "high"/s);
});

test("engine maps impact_level medium to priority medium", () => {
  assert.match(engine, /case "medium":.*return "medium"/s);
});

test("engine maps impact_level low to priority low", () => {
  assert.match(engine, /case "low":.*return "low"/s);
});

test("engine falls back to medium priority for null impact level", () => {
  assert.match(engine, /default:.*return "medium"/s);
});

test("engine caps title at 120 characters", () => {
  assert.match(engine, /slice\(0, 120\)/);
});

test("engine generates request_approval acceptance criteria", () => {
  assert.match(engine, /Approval owner identified/);
  assert.match(engine, /Approval request sent/);
  assert.match(engine, /Approval response received/);
});

test("engine generates schedule_meeting acceptance criteria", () => {
  assert.match(engine, /Required stakeholders identified/);
  assert.match(engine, /Meeting scheduled/);
  assert.match(engine, /Decision or next steps captured/);
});

test("engine generates create_mitigation_plan acceptance criteria", () => {
  assert.match(engine, /Mitigation owner assigned/);
  assert.match(engine, /Mitigation steps documented/);
  assert.match(engine, /Residual risk reviewed/);
});

test("engine generates clarify_requirement acceptance criteria", () => {
  assert.match(engine, /Requirement owner identified/);
  assert.match(engine, /Clarification received/);
  assert.match(engine, /Scope or acceptance impact documented/);
});

test("engine generates follow_up acceptance criteria", () => {
  assert.match(engine, /Follow-up owner assigned/);
  assert.match(engine, /Response requested/);
  assert.match(engine, /Next action recorded/);
});

test("engine generates checklists for all action types", () => {
  for (const type of [
    "request_approval", "schedule_meeting", "create_mitigation_plan",
    "clarify_requirement", "follow_up", "escalate_issue",
    "confirm_dependency", "assign_owner", "review_assumption",
  ]) {
    assert.match(engine, new RegExp(`${type}:`), `checklist for ${type} missing`);
  }
});

test("engine does not use LLM or external calls", () => {
  assert.doesNotMatch(engine, /fetch\(/);
  assert.doesNotMatch(engine, /openai/i);
  assert.doesNotMatch(engine, /anthropic/i);
});

// ── Materialization ───────────────────────────────────────────────────────────

test("materializer exports materializeTaskDraftForRecommendedAction", () => {
  assert.match(materializer, /export async function materializeTaskDraftForRecommendedAction/);
});

test("materializer requires authentication", () => {
  assert.match(materializer, /requireAuthenticatedUser/);
});

test("materializer checks project access", () => {
  assert.match(materializer, /requireProjectAccess/);
});

test("materializer loads recommended action and raid item", () => {
  assert.match(materializer, /recommended_actions/);
  assert.match(materializer, /raid_items/);
});

test("materializer upserts by workspace_id + recommended_action_id", () => {
  assert.match(materializer, /workspace_id/);
  assert.match(materializer, /recommended_action_id/);
  assert.match(materializer, /maybeSingle/);
});

test("materializer preserves approved/discarded/converted_to_task drafts", () => {
  assert.match(materializer, /IMMUTABLE_STATUSES/);
  assert.match(materializer, /"approved"/);
  assert.match(materializer, /"discarded"/);
  assert.match(materializer, /"converted_to_task"/);
  assert.match(materializer, /preserved = true/);
});

test("materializer updates draft when status is draft or reviewed", () => {
  assert.match(materializer, /update\(/);
  assert.match(materializer, /draft_status.*draft/s);
});

test("materializer sets recommended_action status to converted_to_task", () => {
  assert.match(materializer, /converted_to_task/);
  assert.match(materializer, /recommended_actions.*update/s);
  assert.match(materializer, /converted_task_id/);
});

test("materializer inserts recommended_action_decisions audit row on transition", () => {
  assert.match(materializer, /recommended_action_decisions/);
  assert.match(materializer, /previous_status/);
  assert.match(materializer, /new_status/);
});

test("materializer returns typed result contract", () => {
  assert.match(materializer, /TaskDraftMaterializationResult/);
  assert.match(materializer, /ok: true/);
  assert.match(materializer, /ok: false/);
  assert.match(materializer, /failureClass/);
});

test("materializer covers all failure classes", () => {
  for (const fc of ["unauthenticated", "not_found", "unauthorized", "generation_failed", "persistence_failed"]) {
    assert.match(materializer, new RegExp(fc), `failureClass ${fc} missing`);
  }
});

test("materializer logs started, completed, failed", () => {
  assert.match(materializer, /task_draft\.materialization\.started/);
  assert.match(materializer, /task_draft\.materialization\.completed/);
  assert.match(materializer, /task_draft\.materialization\.failed/);
});

test("materializer logs include required fields", () => {
  assert.match(materializer, /workspaceId/);
  assert.match(materializer, /projectId/);
  assert.match(materializer, /recommendedActionId/);
  assert.match(materializer, /raidItemId/);
  assert.match(materializer, /durationMs/);
});

// ── API: POST /api/task-drafts/from-recommended-action ────────────────────────

test("from-recommended-action route validates recommendedActionId", () => {
  assert.match(fromActionRoute, /recommendedActionId/);
  assert.match(fromActionRoute, /validation_failed/);
});

test("from-recommended-action route calls materializeTaskDraftForRecommendedAction", () => {
  assert.match(fromActionRoute, /materializeTaskDraftForRecommendedAction/);
});

test("from-recommended-action route maps failure classes to correct HTTP statuses", () => {
  assert.match(fromActionRoute, /validation_failed.*400/s);
  assert.match(fromActionRoute, /unauthenticated.*401/s);
  assert.match(fromActionRoute, /unauthorized.*403/s);
  assert.match(fromActionRoute, /not_found.*404/s);
  assert.match(fromActionRoute, /invalid_transition.*409/s);
});

test("from-recommended-action route returns ok, draft, created, preserved", () => {
  assert.match(fromActionRoute, /ok: true/);
  assert.match(fromActionRoute, /draft.*result\.draft/s);
  assert.match(fromActionRoute, /created/);
  assert.match(fromActionRoute, /preserved/);
});

// ── API: GET /api/task-drafts ──────────────────────────────────────────────────

test("GET task-drafts requires projectId", () => {
  assert.match(listRoute, /projectId is required/);
});

test("GET task-drafts requires authentication and project access", () => {
  assert.match(listRoute, /requireAuthenticatedUser/);
  assert.match(listRoute, /requireProjectAccess/);
});

test("GET task-drafts supports recommendedActionId filter", () => {
  assert.match(listRoute, /recommendedActionId/);
});

test("GET task-drafts supports status filter", () => {
  assert.match(listRoute, /draft_status/);
});

test("GET task-drafts sorts critical/high first then newest first", () => {
  assert.match(listRoute, /PRIORITY_ORDER/);
  assert.match(listRoute, /critical.*high.*medium.*low/s);
  assert.match(listRoute, /created_at/);
});

test("GET task-drafts returns drafts array", () => {
  assert.match(listRoute, /drafts/);
});

// ── API: POST /api/task-drafts/status ─────────────────────────────────────────

test("status route validates draftId and status", () => {
  assert.match(statusRoute, /draftId/);
  assert.match(statusRoute, /status/);
});

test("status route requires project write access, not read (F22-B)", () => {
  assert.match(statusRoute, /requireProjectAccess\(draft\.project_id, "write"\)/);
  assert.doesNotMatch(statusRoute, /requireProjectAccess\([^)]*"read"\)/);
});

test("status route only allows reviewed, approved, discarded", () => {
  assert.match(statusRoute, /ALLOWED_STATUS_UPDATES/);
  assert.match(statusRoute, /"reviewed"/);
  assert.match(statusRoute, /"approved"/);
  assert.match(statusRoute, /"discarded"/);
});

test("status route does not allow converted_to_task from this API", () => {
  assert.doesNotMatch(statusRoute, /converted_to_task.*ALLOWED/s);
});

test("status route logs status update lifecycle", () => {
  assert.match(statusRoute, /task_draft\.status_update\.started/);
  assert.match(statusRoute, /task_draft\.status_update\.completed/);
  assert.match(statusRoute, /task_draft\.status_update\.failed/);
});

// ── UI ────────────────────────────────────────────────────────────────────────

test("UI: Convert button calls handleConvert not handleDecision directly", () => {
  assert.match(shell, /handleConvert/);
  assert.doesNotMatch(shell, /onClick.*handleDecision.*"converted_to_task"/);
});

test("UI: Task Draft Preview panel exists", () => {
  assert.match(shell, /Task Draft/);
  assert.match(shell, /taskDraftPreview/);
});

test("UI: Task Draft Preview shows title, priority, suggested owner, due window", () => {
  assert.match(shell, /taskDraftPreview\.title/);
  assert.match(shell, /taskDraftPreview\.priority/);
  assert.match(shell, /suggested_owner/);
  assert.match(shell, /suggested_due_window/);
});

test("UI: Task Draft Preview shows acceptance criteria and checklist", () => {
  assert.match(shell, /acceptance_criteria/);
  assert.match(shell, /checklist/);
});

test("UI: Task Draft Preview shows confidence score", () => {
  assert.match(shell, /confidence_score/);
});

test("UI: Approve Draft button exists and calls handleDraftStatus with approved", () => {
  assert.match(shell, /Approve Draft/);
  assert.match(shell, /handleDraftStatus.*"approved"/s);
});

test("UI: Discard Draft button exists and calls handleDraftStatus with discarded", () => {
  assert.match(shell, /Discard Draft/);
  assert.match(shell, /handleDraftStatus.*"discarded"/s);
});

test("UI: Keep as Draft button exists", () => {
  assert.match(shell, /Keep as Draft/);
});

test("UI: Approved draft shows execution task conversion action", () => {
  assert.match(shell, /Create Execution Task|handleConvertDraftToTask/i);
  assert.doesNotMatch(shell, /createTask\(|createFinalTask\(/);
});

test("UI: Draft error state exists", () => {
  assert.match(shell, /draftActionError/);
});

// ── Index ─────────────────────────────────────────────────────────────────────

test("index re-exports all public symbols", () => {
  assert.match(indexFile, /generateTaskDraftFromRecommendedAction/);
  assert.match(indexFile, /GeneratedTaskDraft/);
  assert.match(indexFile, /materializeTaskDraftForRecommendedAction/);
  assert.match(indexFile, /TaskDraftMaterializationResult/);
});

// ── Runtime probes ────────────────────────────────────────────────────────────

const runtimeProbe = String.raw`
import assert from "node:assert/strict";
import { generateTaskDraftFromRecommendedAction } from "./src/lib/task-drafts/generate-task-draft.ts";

const baseAction = {
  id: "00000000-0000-0000-0000-000000000001",
  title: "Request approval from Cisco stakeholders for budget sign-off",
  description: "A risk has been identified related to approval dependencies.",
  recommended_action_type: "request_approval",
  impact_level: "high",
  confidence_score: 85,
  recommended_owner: "PM Lead",
  recommended_due_window: "within 3 business days",
  rationale: { trigger: "approval_dependency_detected" },
  evidence_summary: { raidCategory: "risk", raidConfidenceScore: 85 },
};

// Priority mapping
const criticalAction = { ...baseAction, impact_level: "critical" };
assert.equal(generateTaskDraftFromRecommendedAction({ recommendedAction: criticalAction }).priority, "critical", "critical maps to critical");

const highAction = { ...baseAction, impact_level: "high" };
assert.equal(generateTaskDraftFromRecommendedAction({ recommendedAction: highAction }).priority, "high", "high maps to high");

const mediumAction = { ...baseAction, impact_level: "medium" };
assert.equal(generateTaskDraftFromRecommendedAction({ recommendedAction: mediumAction }).priority, "medium", "medium maps to medium");

const lowAction = { ...baseAction, impact_level: "low" };
assert.equal(generateTaskDraftFromRecommendedAction({ recommendedAction: lowAction }).priority, "low", "low maps to low");

const nullAction = { ...baseAction, impact_level: null };
assert.equal(generateTaskDraftFromRecommendedAction({ recommendedAction: nullAction }).priority, "medium", "null maps to medium");

// Title capping
const longTitleAction = { ...baseAction, title: "A".repeat(200) };
const result = generateTaskDraftFromRecommendedAction({ recommendedAction: longTitleAction });
assert.ok(result.title.length <= 120, "title is capped at 120 chars");

// request_approval acceptance criteria
const approvalResult = generateTaskDraftFromRecommendedAction({ recommendedAction: baseAction });
assert.ok(approvalResult.acceptanceCriteria.some(c => c.includes("Approval owner")), "request_approval has 'Approval owner' criterion");
assert.ok(approvalResult.acceptanceCriteria.some(c => c.includes("Approval request sent")), "request_approval has sent criterion");
assert.ok(approvalResult.acceptanceCriteria.some(c => c.includes("Approval response received")), "request_approval has response criterion");

// schedule_meeting acceptance criteria
const meetingAction = { ...baseAction, recommended_action_type: "schedule_meeting" };
const meetingResult = generateTaskDraftFromRecommendedAction({ recommendedAction: meetingAction });
assert.ok(meetingResult.acceptanceCriteria.some(c => c.includes("stakeholders identified")), "schedule_meeting has stakeholders criterion");
assert.ok(meetingResult.acceptanceCriteria.some(c => c.includes("Meeting scheduled")), "schedule_meeting has scheduled criterion");

// create_mitigation_plan acceptance criteria
const mitigationAction = { ...baseAction, recommended_action_type: "create_mitigation_plan" };
const mitigationResult = generateTaskDraftFromRecommendedAction({ recommendedAction: mitigationAction });
assert.ok(mitigationResult.acceptanceCriteria.some(c => c.includes("Mitigation owner")), "mitigation has owner criterion");
assert.ok(mitigationResult.acceptanceCriteria.some(c => c.includes("Residual risk")), "mitigation has residual risk criterion");

// clarify_requirement acceptance criteria
const clarifyAction = { ...baseAction, recommended_action_type: "clarify_requirement" };
const clarifyResult = generateTaskDraftFromRecommendedAction({ recommendedAction: clarifyAction });
assert.ok(clarifyResult.acceptanceCriteria.some(c => c.includes("Requirement owner")), "clarify has requirement owner criterion");
assert.ok(clarifyResult.acceptanceCriteria.some(c => c.includes("Clarification received")), "clarify has received criterion");

// follow_up acceptance criteria
const followAction = { ...baseAction, recommended_action_type: "follow_up" };
const followResult = generateTaskDraftFromRecommendedAction({ recommendedAction: followAction });
assert.ok(followResult.acceptanceCriteria.some(c => c.includes("Follow-up owner")), "follow_up has owner criterion");
assert.ok(followResult.acceptanceCriteria.some(c => c.includes("Next action recorded")), "follow_up has next action criterion");

// Checklist generated
assert.ok(approvalResult.checklist.length >= 3, "checklist has at least 3 steps");

// Source payload contains traceability
assert.equal(approvalResult.sourcePayload.recommendedActionId, baseAction.id, "sourcePayload has recommendedActionId");
assert.equal(approvalResult.sourcePayload.recommendedActionType, "request_approval", "sourcePayload has actionType");

// RAID item context included
const raidItem = { id: "raid-001", category: "risk", title: "Vendor delay", description: "Vendor late", owner: null, due_date: null };
const withRaid = generateTaskDraftFromRecommendedAction({ recommendedAction: baseAction, raidItem });
assert.ok(withRaid.description.includes("risk"), "description includes RAID category context");

// Confidence score
assert.equal(approvalResult.confidenceScore, 85, "confidence score preserved");

console.log("All task-drafts runtime probes passed.");
`;

test("runtime: priority mapping, title cap, acceptance criteria, checklists, and traceability", () => {
  execFileSync("npx", ["tsx", "--eval", runtimeProbe], { encoding: "utf8", stdio: "pipe" });
});
