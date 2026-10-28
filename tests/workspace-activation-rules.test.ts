// Guided Workspace Onboarding — activation rules.
//
// These tests exercise the pure rule set (src/lib/workspace-activation/
// activation-rules.ts). Every assertion checks that progress derives ONLY
// from evidence about real rows: no evidence path may ever mark a step
// completed without the underlying fact.

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveActivationStage,
  deriveActivationSteps,
  deriveWorkspaceActivationMode,
  evaluateActivationRules,
} from "../src/lib/workspace-activation/activation-rules";
import type { WorkspaceActivationEvidence } from "../src/lib/workspace-activation/types";

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

const stepById = (evidence: WorkspaceActivationEvidence, id: string) => {
  const step = deriveActivationSteps(evidence).find((s) => s.id === id);
  assert.ok(step, `step ${id} must exist`);
  return step!;
};

// ─── Mode derivation ─────────────────────────────────────────────────────────

test("mode: solo member with no owner_type is individual", () => {
  assert.equal(deriveWorkspaceActivationMode(baseEvidence()), "individual");
});

test("mode: personal owner_type stays individual", () => {
  assert.equal(deriveWorkspaceActivationMode(baseEvidence({ ownerType: "personal" })), "individual");
});

test("mode: a second member makes it a team", () => {
  assert.equal(deriveWorkspaceActivationMode(baseEvidence({ memberCount: 2 })), "team");
});

test("mode: a real pending invitation makes it a team", () => {
  assert.equal(deriveWorkspaceActivationMode(baseEvidence({ pendingInviteExists: true })), "team");
});

test("mode: company/team owner_type is team even while solo", () => {
  assert.equal(deriveWorkspaceActivationMode(baseEvidence({ ownerType: "company" })), "team");
  assert.equal(deriveWorkspaceActivationMode(baseEvidence({ ownerType: "team" })), "team");
});

// ─── Empty workspace ─────────────────────────────────────────────────────────

test("empty workspace: only workspace_created is completed; nothing else", () => {
  const steps = deriveActivationSteps(baseEvidence());
  const completed = steps.filter((s) => s.status === "completed").map((s) => s.id);
  assert.deepEqual(completed, ["workspace_created"]);
});

test("empty workspace: stage is workspace_created and not operationally started", () => {
  const result = evaluateActivationRules(baseEvidence());
  assert.equal(result.stage, "workspace_created");
  assert.equal(result.operationallyStarted, false);
  assert.equal(result.workspaceReady, false);
});

test("empty workspace: task_created is blocked by project_created", () => {
  const step = stepById(baseEvidence(), "task_created");
  assert.equal(step.status, "blocked");
  assert.deepEqual(step.blockedBy, ["project_created"]);
});

test("empty workspace: milestone and raid are blocked and optional", () => {
  for (const id of ["milestone_created", "raid_registered"]) {
    const step = stepById(baseEvidence(), id);
    assert.equal(step.status, "blocked");
    assert.equal(step.required, false);
  }
});

// ─── Project unlocks execution steps ─────────────────────────────────────────

test("creating a real project completes project_created and unblocks task_created", () => {
  const evidence = baseEvidence({ projectExists: true });
  assert.equal(stepById(evidence, "project_created").status, "completed");
  assert.equal(stepById(evidence, "task_created").status, "available");
  assert.equal(deriveActivationStage(evidence), "project_created");
});

test("archived-only projects do not complete project_created (evidence flag false)", () => {
  // The evidence collector excludes archived projects; with projectExists=false
  // the rules must not complete the step regardless of other data.
  const evidence = baseEvidence({ projectExists: false, taskExists: true });
  assert.equal(stepById(evidence, "project_created").status, "available");
});

test("project + task reaches execution_started and operationallyStarted", () => {
  const evidence = baseEvidence({ projectExists: true, taskExists: true, pmoExists: true });
  const result = evaluateActivationRules(evidence);
  assert.equal(result.stage, "execution_started");
  assert.equal(result.operationallyStarted, true);
});

// ─── Minimal activation path (individual) ────────────────────────────────────

test("individual mode: essential steps are exactly workspace, project, task", () => {
  const result = evaluateActivationRules(baseEvidence({ ownerType: "personal" }));
  const essentialIds = result.steps
    .filter((s) => s.required && s.status !== "not_applicable")
    .map((s) => s.id)
    .sort();
  assert.deepEqual(essentialIds, ["project_created", "task_created", "workspace_created"].sort());
  assert.equal(result.totalEssentialSteps, 3);
});

test("individual mode: workspace becomes ready with project + task only", () => {
  const result = evaluateActivationRules(
    baseEvidence({ ownerType: "personal", projectExists: true, taskExists: true }),
  );
  assert.equal(result.workspaceReady, true);
  assert.equal(result.completedEssentialSteps, result.totalEssentialSteps);
});

test("individual personal workspace: member_invited is not applicable, pmo optional", () => {
  const evidence = baseEvidence({ ownerType: "personal" });
  assert.equal(stepById(evidence, "member_invited").status, "not_applicable");
  const pmo = stepById(evidence, "pmo_created");
  assert.equal(pmo.required, false);
  assert.equal(pmo.status, "available");
});

// ─── Team / PMO path ─────────────────────────────────────────────────────────

test("team mode: pmo_created is essential and workspace not ready without it", () => {
  const result = evaluateActivationRules(
    baseEvidence({ memberCount: 2, projectExists: true, taskExists: true }),
  );
  const pmo = result.steps.find((s) => s.id === "pmo_created")!;
  assert.equal(pmo.required, true);
  assert.equal(result.workspaceReady, false);
});

test("team mode: real PMO completes the step and readiness follows", () => {
  const result = evaluateActivationRules(
    baseEvidence({ memberCount: 2, pmoExists: true, projectExists: true, taskExists: true }),
  );
  assert.equal(result.workspaceReady, true);
});

test("pending invitation completes member_invited with an invite_pending note", () => {
  const evidence = baseEvidence({ pendingInviteExists: true });
  const step = stepById(evidence, "member_invited");
  assert.equal(step.status, "completed");
  assert.equal(step.note, "invite_pending");
});

test("accepted second member completes member_invited without pending note", () => {
  const evidence = baseEvidence({ memberCount: 2 });
  const step = stepById(evidence, "member_invited");
  assert.equal(step.status, "completed");
  assert.equal(step.note, null);
});

// ─── Conversation, signals, insights ─────────────────────────────────────────

test("conversation_started completes only on a real user message", () => {
  assert.equal(stepById(baseEvidence(), "conversation_started").status, "available");
  assert.equal(
    stepById(baseEvidence({ userMessageExists: true }), "conversation_started").status,
    "completed",
  );
});

test("execution signal completes from real raid/governance/recommendation evidence only", () => {
  assert.equal(
    stepById(baseEvidence({ projectExists: true }), "execution_signal_generated").status,
    "available",
  );
  for (const overrides of [
    { raidItemExists: true },
    { governanceSignalExists: true },
    { recommendedActionExists: true },
  ]) {
    const evidence = baseEvidence({ projectExists: true, ...overrides });
    assert.equal(stepById(evidence, "execution_signal_generated").status, "completed");
  }
});

test("signals stage requires project + task + signal", () => {
  const evidence = baseEvidence({ projectExists: true, taskExists: true, raidItemExists: true });
  assert.equal(deriveActivationStage(evidence), "signals_available");
});

test("insights stage requires a real persisted recommendation", () => {
  const evidence = baseEvidence({
    projectExists: true,
    taskExists: true,
    raidItemExists: true,
    recommendedActionExists: true,
  });
  assert.equal(deriveActivationStage(evidence), "insights_available");
});

test("insights_reviewed needs BOTH a real recommendation and the first-view event", () => {
  const withInsightOnly = baseEvidence({
    projectExists: true,
    taskExists: true,
    recommendedActionExists: true,
  });
  assert.equal(stepById(withInsightOnly, "insights_reviewed").status, "available");

  const viewedWithoutInsight = baseEvidence({ insightsFirstViewedAt: "2026-07-21T00:00:00Z" });
  assert.notEqual(stepById(viewedWithoutInsight, "insights_reviewed").status, "completed");

  const both = baseEvidence({
    projectExists: true,
    taskExists: true,
    recommendedActionExists: true,
    insightsFirstViewedAt: "2026-07-21T00:00:00Z",
  });
  assert.equal(stepById(both, "insights_reviewed").status, "completed");
});

test("insights_reviewed is blocked until a signal exists", () => {
  assert.equal(stepById(baseEvidence(), "insights_reviewed").status, "blocked");
});

// ─── Permissions ─────────────────────────────────────────────────────────────

test("viewer cannot action creation steps but can chat and review", () => {
  const evidence = baseEvidence({ role: "viewer" });
  for (const id of ["project_created", "task_created", "pmo_created", "member_invited"]) {
    assert.equal(stepById(evidence, id).actionAllowed, false, `${id} must deny viewer`);
  }
  assert.equal(stepById(evidence, "conversation_started").actionAllowed, true);
  assert.equal(stepById(evidence, "insights_reviewed").actionAllowed, true);
});

test("pm can create projects/tasks but cannot invite members", () => {
  const evidence = baseEvidence({ role: "pm" });
  assert.equal(stepById(evidence, "project_created").actionAllowed, true);
  assert.equal(stepById(evidence, "task_created").actionAllowed, true);
  assert.equal(stepById(evidence, "member_invited").actionAllowed, false);
  assert.equal(stepById(evidence, "pmo_created").actionAllowed, false, "PMO activation is owner/admin only (PR-3)");
});

test("admin and owner can invite members", () => {
  assert.equal(stepById(baseEvidence({ role: "admin" }), "member_invited").actionAllowed, true);
  assert.equal(stepById(baseEvidence({ role: "owner" }), "member_invited").actionAllowed, true);
  assert.equal(stepById(baseEvidence({ role: "admin" }), "pmo_created").actionAllowed, true);
  assert.equal(stepById(baseEvidence({ role: "owner" }), "pmo_created").actionAllowed, true);
});

test("workspace_created carries no CTA route", () => {
  assert.equal(stepById(baseEvidence(), "workspace_created").route, null);
});

// ─── Fully active workspace ──────────────────────────────────────────────────

test("fully active workspace: everything applicable is completed, ready, insights stage", () => {
  const evidence = baseEvidence({
    memberCount: 2,
    pmoExists: true,
    projectExists: true,
    taskExists: true,
    milestoneExists: true,
    raidItemExists: true,
    governanceSignalExists: true,
    recommendedActionExists: true,
    userMessageExists: true,
    insightsFirstViewedAt: "2026-07-21T00:00:00Z",
  });
  const result = evaluateActivationRules(evidence);
  assert.equal(result.stage, "insights_available");
  assert.equal(result.workspaceReady, true);
  assert.equal(result.operationallyStarted, true);
  const incomplete = result.steps.filter(
    (s) => s.status !== "completed" && s.status !== "not_applicable",
  );
  assert.deepEqual(incomplete, []);
});

test("partial workspace keeps honest counts (no step invented)", () => {
  const result = evaluateActivationRules(baseEvidence({ projectExists: true }));
  assert.equal(result.completedEssentialSteps, 2); // workspace + project
  assert.ok(result.completedEssentialSteps < result.totalEssentialSteps);
  assert.equal(result.workspaceReady, false);
});
