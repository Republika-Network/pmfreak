// Project Brain Sprint 0.5 — Foundation Integration tests.
//
// Covers: deterministic initial-response derivation only using real project
// data, the guardrail validation pipeline, the structured knowledge-gap
// model, and static-analysis assertions that fabricated "learning" UI
// (fixed-timer cosmetic states, arbitrary confidence percentages, hardcoded
// gap strings, a firstRun-only access gate) has actually been removed from
// the integrated surfaces — matching the create-project-brain.test.mjs
// convention of asserting contracts directly against source when the
// contract is about UI/control-flow shape rather than pure data.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deriveInitialProjectBrainResponse } from "../src/lib/project-brain/derive-initial-response.ts";
import { buildInitialProjectBrainResponse, PROJECT_BRAIN_FALLBACK_MESSAGE } from "../src/lib/project-brain/validate-response-pipeline.ts";
import { validateResponse } from "../src/lib/project-brain/guardrails.ts";
import { PROJECT_BRAIN_CONSTITUTION_VERSION } from "../src/lib/project-brain/constitution.ts";

const PROJECT = { projectId: "proj-1", workspaceId: "ws-1", projectName: "Atlas Migration", createdAt: "2026-07-01T00:00:00.000Z" };

function emptyOnboarding(overrides = {}) {
  return {
    identity: { technicalLead: "", targetDeliveryDate: "", pmAssigned: "", ...overrides.identity },
    deliveryContext: { problemStatement: "", mainDeliverable: "", externalDependencies: "", contractualMilestones: "", ...overrides.deliveryContext },
    discovery: {
      unknowns: "",
      requirementsDefined: null,
      pendingClientDependencies: "",
      pendingAccesses: "",
      vendorDependencies: "",
      financialBlockers: "",
      ...overrides.discovery,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic derivation
// ─────────────────────────────────────────────────────────────────────────────

test("a project with no onboarding payload and no evidence produces only the project-created fact plus honest gaps", () => {
  const response = deriveInitialProjectBrainResponse({
    project: { ...PROJECT, onboarding: null },
    evidence: { totalCount: 0, processedCount: 0, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });

  const facts = response.statements.filter((s) => s.epistemicType === "FACT");
  assert.equal(facts.length, 1, "only the project-creation fact should exist with no onboarding data");
  assert.match(facts[0].text, /Atlas Migration.*has been created/);
  assert.ok(response.knowledgeGaps.some((g) => g.id === "gap-no-evidence"));
});

test("only populated onboarding fields create FACT/REPORTED statements — empty fields create nothing", () => {
  const response = deriveInitialProjectBrainResponse({
    project: { ...PROJECT, onboarding: emptyOnboarding({ deliveryContext: { problemStatement: "Legacy system is unsupported." } }) },
    evidence: { totalCount: 0, processedCount: 0, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });

  assert.ok(response.statements.some((s) => s.text === "The project's problem statement has been defined."));
  assert.ok(!response.statements.some((s) => s.text === "The project's main deliverable has been defined."), "mainDeliverable was empty — no statement should claim it was defined");
  assert.ok(!response.statements.some((s) => s.epistemicType === "REPORTED"), "no discovery fields were populated — no REPORTED statement should exist");
});

test("unresolved onboarding fields become REPORTED/OPEN_QUESTION statements, never FACT", () => {
  const response = deriveInitialProjectBrainResponse({
    project: {
      ...PROJECT,
      onboarding: emptyOnboarding({ discovery: { pendingClientDependencies: "Legal sign-off pending.", unknowns: "Unclear if SSO is in scope." } }),
    },
    evidence: { totalCount: 0, processedCount: 0, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });

  const clientDepStatement = response.statements.find((s) => s.text.includes("Client dependencies"));
  assert.equal(clientDepStatement.epistemicType, "REPORTED");
  assert.ok(clientDepStatement.reportedBy);

  const unknownsStatement = response.statements.find((s) => s.text.includes("open unknowns"));
  assert.equal(unknownsStatement.epistemicType, "OPEN_QUESTION");
});

test("missing target delivery date and contractual milestones each produce a distinct UNKNOWN knowledge gap", () => {
  const response = deriveInitialProjectBrainResponse({
    project: { ...PROJECT, onboarding: emptyOnboarding() },
    evidence: { totalCount: 1, processedCount: 0, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });

  assert.ok(response.knowledgeGaps.some((g) => g.id === "gap-delivery-timeline" && g.epistemicStatus === "UNKNOWN"));
  assert.ok(response.knowledgeGaps.some((g) => g.id === "gap-contractual-milestones" && g.epistemicStatus === "UNKNOWN"));
  for (const gap of response.knowledgeGaps) {
    assert.ok(gap.reason.trim().length > 0, `gap "${gap.id}" must explain why it matters`);
  }
});

test("supplying a target delivery date removes that specific knowledge gap", () => {
  const response = deriveInitialProjectBrainResponse({
    project: { ...PROJECT, onboarding: emptyOnboarding({ identity: { targetDeliveryDate: "2026-12-01" } }) },
    evidence: { totalCount: 0, processedCount: 0, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });
  assert.ok(!response.knowledgeGaps.some((g) => g.id === "gap-delivery-timeline"));
});

test("evidence count in the response matches the real input count exactly", () => {
  const response = deriveInitialProjectBrainResponse({
    project: { ...PROJECT, onboarding: null },
    evidence: { totalCount: 3, processedCount: 1, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });
  const evidenceFact = response.statements.find((s) => s.text.includes("evidence item"));
  assert.match(evidenceFact.text, /^3 evidence items are stored in Project Memory\.$/);
  assert.ok(!response.knowledgeGaps.some((g) => g.id === "gap-no-evidence"), "evidence exists — the no-evidence gap must not appear");
});

test("response carries the correct project scope and constitution version", () => {
  const response = deriveInitialProjectBrainResponse({
    project: { ...PROJECT, onboarding: null },
    evidence: { totalCount: 0, processedCount: 0, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });
  assert.equal(response.scope.projectId, PROJECT.projectId);
  assert.equal(response.scope.workspaceId, PROJECT.workspaceId);
  assert.equal(response.constitutionVersion, PROJECT_BRAIN_CONSTITUTION_VERSION);
  for (const statement of response.statements) {
    assert.equal(statement.scope.projectId, PROJECT.projectId, `statement "${statement.id}" must stay in the project's scope`);
    assert.equal(statement.constitutionVersion, PROJECT_BRAIN_CONSTITUTION_VERSION);
  }
  for (const gap of response.knowledgeGaps) {
    assert.equal(gap.scope.projectId, PROJECT.projectId, `gap "${gap.id}" must stay in the project's scope`);
  }
});

test("the derived response always passes the constitution's own guardrails", () => {
  const scenarios = [
    { onboarding: null, evidence: { totalCount: 0, processedCount: 0, failedCount: 0 } },
    { onboarding: emptyOnboarding(), evidence: { totalCount: 0, processedCount: 0, failedCount: 0 } },
    {
      onboarding: emptyOnboarding({
        identity: { targetDeliveryDate: "2026-12-01", technicalLead: "J. Rivera", pmAssigned: "A. Chen" },
        deliveryContext: { problemStatement: "x", mainDeliverable: "y", externalDependencies: "z", contractualMilestones: "m" },
        discovery: { unknowns: "u", requirementsDefined: true, pendingClientDependencies: "p", vendorDependencies: "v", financialBlockers: "f" },
      }),
      evidence: { totalCount: 5, processedCount: 3, failedCount: 1 },
    },
  ];

  for (const scenario of scenarios) {
    const response = deriveInitialProjectBrainResponse({ project: { ...PROJECT, onboarding: scenario.onboarding }, evidence: scenario.evidence, generatedAt: PROJECT.createdAt });
    const result = validateResponse(response);
    assert.equal(result.ok, true, `guardrails rejected a legitimately-derived response: ${JSON.stringify(result.ok ? [] : result.failures)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation pipeline — never renders an unsafe claim
// ─────────────────────────────────────────────────────────────────────────────

test("buildInitialProjectBrainResponse returns ok:true with a response for legitimate input", () => {
  const result = buildInitialProjectBrainResponse({
    project: { ...PROJECT, onboarding: null },
    evidence: { totalCount: 0, processedCount: 0, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.response.statements));
});

test("the fallback message never claims analysis happened", () => {
  assert.doesNotMatch(PROJECT_BRAIN_FALLBACK_MESSAGE, /learn|analyz|understand/i);
  assert.match(PROJECT_BRAIN_FALLBACK_MESSAGE, /evidence remains stored/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Truthful evidence lifecycle — no fixed-timer simulation, no "learned"
// ─────────────────────────────────────────────────────────────────────────────

const evidenceTimelineCardSrc = readFileSync("src/components/pmfreak/intelligence-inbox/evidence-timeline-card.tsx", "utf8");
const projectIntelligenceInboxSrc = readFileSync("src/components/pmfreak/intelligence-inbox/project-intelligence-inbox.tsx", "utf8");

test("EvidenceProcessingState is exactly the five truthful states — no fabricated 'learned'/'reading'/'extracting'/'updating' state", () => {
  const typeMatch = evidenceTimelineCardSrc.match(/export type EvidenceProcessingState = ([^;]+);/);
  assert.ok(typeMatch, "EvidenceProcessingState type declaration must exist");
  assert.equal(typeMatch[1], '"uploading" | "stored" | "processing" | "processed" | "failed"');
});

test("the evidence card's zero-analysis state is a single honest sentence, not fabricated per-category dashes", () => {
  assert.match(evidenceTimelineCardSrc, /No operational analysis is available for this evidence yet\./);
  assert.doesNotMatch(evidenceTimelineCardSrc, /STORY_CATEGORIES/);
  assert.doesNotMatch(evidenceTimelineCardSrc, /RESERVED_CATEGORIES/);
});

test("project-intelligence-inbox no longer runs a fixed-timer cosmetic thinking sequence", () => {
  assert.doesNotMatch(projectIntelligenceInboxSrc, /advanceCosmeticThinking/);
  assert.doesNotMatch(projectIntelligenceInboxSrc, /THINKING_STAGE_MS/);
  assert.doesNotMatch(projectIntelligenceInboxSrc, /THINKING_STAGES/);
});

test("project-intelligence-inbox never claims the brain 'just got smarter' or that learning completed", () => {
  assert.doesNotMatch(projectIntelligenceInboxSrc, /got smarter/i);
  assert.doesNotMatch(projectIntelligenceInboxSrc, /Learned from/i);
});

test("evidence lifecycle states map directly from real project_evidence.status, one to one", () => {
  assert.match(
    projectIntelligenceInboxSrc,
    /function processingStateFromServerStatus[\s\S]{0,400}"processed"[\s\S]{0,200}"failed"[\s\S]{0,200}"processing"/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Operational awareness honesty — no arbitrary confidence percentage
// ─────────────────────────────────────────────────────────────────────────────

const operationalMemoryPanelSrc = readFileSync("src/components/pmfreak/intelligence-inbox/operational-memory-panel.tsx", "utf8");

test("OperationalMemoryPanel no longer computes an arbitrary understanding percentage", () => {
  assert.doesNotMatch(operationalMemoryPanelSrc, /understandingPercent/);
  assert.doesNotMatch(operationalMemoryPanelSrc, /learnedCount \* 7/);
  assert.doesNotMatch(operationalMemoryPanelSrc, /Not yet known/);
});

test("OperationalMemoryPanel reports real counts derived from the validated response", () => {
  assert.match(operationalMemoryPanelSrc, /knownCount/);
  assert.match(operationalMemoryPanelSrc, /unresolvedCount/);
  assert.match(operationalMemoryPanelSrc, /Not available yet/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge gaps — structured model, no hardcoded generic strings
// ─────────────────────────────────────────────────────────────────────────────

const knowledgeGapsPanelSrc = readFileSync("src/components/pmfreak/intelligence-inbox/knowledge-gaps-panel.tsx", "utf8");

test("KnowledgeGapsPanel takes structured gaps as a prop instead of a hardcoded array", () => {
  assert.match(knowledgeGapsPanelSrc, /gaps: ProjectBrainKnowledgeGap\[\]/);
  assert.doesNotMatch(knowledgeGapsPanelSrc, /I still don't know who owns delivery/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Returning-user coherence — Project Memory is never gated solely by firstRun
// ─────────────────────────────────────────────────────────────────────────────

const commandCenterClientSrc = readFileSync("src/modules/workspace/screens/command-center/command-center-client.tsx", "utf8");

test("the regular Command Center view retains a persistent way back into the Project Brain view", () => {
  // CHAT-SHELL-01: the "regular" view is now the project conversation. Its Project
  // tool links back to the guided inbox through `view=inbox`, which the Command
  // Center route honours — so the guided view is never reachable only on first run.
  const conversationPage = readFileSync("src/app/(protected)/workspaces/[workspaceId]/projects/[projectId]/page.tsx", "utf8");
  const conversationView = readFileSync("src/components/pmfreak/conversation-shell/project-conversation-view.tsx", "utf8");
  const commandCenterPage = readFileSync("src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx", "utf8");
  assert.match(conversationPage, /guidedSetup: workspaceCommandCenterPath\(workspaceId, \{ projectId: project\.id, view: "inbox" \}\)/);
  assert.match(conversationView, /href: links\.guidedSetup/);
  assert.match(commandCenterPage, /params\.view === "inbox"/);
  // And the guided view's own exit lands in the conversation, not in a second app.
  assert.match(commandCenterClientSrc, /router\.push\(projectHomePath\(workspaceId, projectId\)\)/);
  assert.doesNotMatch(commandCenterClientSrc, /<CommandCenterLayout/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Project isolation — every statement/gap the derivation produces shares scope
// ─────────────────────────────────────────────────────────────────────────────

test("deriving for project A never introduces a statement or gap scoped to a different project", () => {
  const otherProject = { projectId: "proj-B", workspaceId: "ws-B", projectName: "Other Project", createdAt: PROJECT.createdAt };
  const response = deriveInitialProjectBrainResponse({
    project: { ...otherProject, onboarding: emptyOnboarding({ discovery: { pendingClientDependencies: "x" } }) },
    evidence: { totalCount: 2, processedCount: 1, failedCount: 0 },
    generatedAt: PROJECT.createdAt,
  });
  for (const statement of response.statements) {
    assert.notEqual(statement.scope.projectId, PROJECT.projectId);
    assert.equal(statement.scope.projectId, otherProject.projectId);
  }
  const result = validateResponse(response);
  assert.equal(result.ok, true);
});
