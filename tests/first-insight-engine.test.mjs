import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const engine = readFileSync(join(ROOT, "src/lib/projects/first-insight/operational-governance-brief-engine.ts"), "utf8");
const types = readFileSync(join(ROOT, "src/lib/projects/first-insight/operational-governance-brief-types.ts"), "utf8");
const store = readFileSync(join(ROOT, "src/lib/projects/first-insight/operational-governance-brief-store.ts"), "utf8");
const orchestrator = readFileSync(join(ROOT, "src/lib/projects/first-insight/operational-governance-brief-orchestrator.ts"), "utf8");
const commandCenterPage = readFileSync(join(ROOT, "src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx"), "utf8");
const commandCenterClient = readFileSync(join(ROOT, "src/modules/workspace/screens/command-center/command-center-client.tsx"), "utf8");
const commandCenterLayout = readFileSync(join(ROOT, "src/modules/workspace/screens/command-center/command-center-layout.tsx"), "utf8");
const saveProject = readFileSync(join(ROOT, "src/lib/projects/save-project-onboarding.ts"), "utf8");

function assertEngineHasRisk(domain, expectedTitleFragment) {
  assert.match(engine, new RegExp(`relatedDomain: "${domain}"`), `engine must create ${domain} risk`);
  assert.match(engine, new RegExp(expectedTitleFragment), `engine must explain ${domain} risk`);
}

test("brief generated from complete payload", () => {
  assert.match(types, /export type OperationalGovernanceBrief = \{/);
  for (const field of ["briefId", "workspaceId", "projectId", "generatedAt", "confidenceScore", "topExecutionRisks", "governanceGaps", "recommendedNextAction", "agentAssignments", "firstInterventionSuggestion", "sourceSummary"]) {
    assert.match(types, new RegExp(`${field}:`), `brief type must include ${field}`);
  }
  assert.match(engine, /export function generateOperationalGovernanceBrief/);
  assert.match(engine, /recommendedNextAction/);
});

test("missing scope creates risk", () => {
  assert.match(engine, /!problemStatement \|\| !mainDeliverable \|\| scopeType === "open" \|\| scopeType === "discovery" \|\| requirementsDefined === false/);
  assertEngineHasRisk("scope", "Scope baseline is not execution-ready");
});

test("missing timeline creates risk", () => {
  assert.match(engine, /!targetDeliveryDate && !contractualMilestones/);
  assertEngineHasRisk("timeline", "Timeline control has no anchor date");
});

test("missing budget creates risk", () => {
  assert.match(engine, /!financialBlockers && !readString\(pmoContextSeed, "successDefinition"\)/);
  assertEngineHasRisk("cost", "Commercial controls are under-specified");
});

test("missing stakeholders creates risk", () => {
  assert.match(engine, /!nonEmptyArray\(pmo\?\.roles\) && !readString\(identity, "clientOrganization"\)/);
  assertEngineHasRisk("stakeholder", "Stakeholder governance is not mapped");
});

test("confidence score calculation", () => {
  assert.match(engine, /function calculateConfidence/);
  assert.match(engine, /score \+= 16/);
  assert.match(engine, /score \+= 22/);
  assert.match(engine, /score -= Math\.min\(30, input\.gaps\.length \* 4\)/);
  assert.match(engine, /Math\.max\(25, Math\.min\(92, score\)\)/);
});

test("persistence success", () => {
  assert.match(store, /from\("operational_governance_briefs"\)\.upsert/);
  assert.match(store, /return \{ ok: true, briefId: brief\.briefId \}/);
  assert.match(store, /onConflict: "project_id"/);
});

test("persistence failure fallback", () => {
  assert.match(store, /if \(error\) return \{ ok: false, error: error\.message \}/);
  assert.match(saveProject, /briefStatus = "generation_failed"/);
  assert.match(saveProject, /project\.create\.brief_generation_failed/);
  assert.match(commandCenterClient, /Project created\. We couldn&apos;t generate the first governance brief yet\./);
  assert.match(commandCenterClient, /Retry brief generation/);
});

test("command center hydration", () => {
  assert.match(commandCenterPage, /loadLatestOperationalGovernanceBrief/);
  assert.match(commandCenterPage, /initialBrief=\{initialBrief\}/);
  assert.match(commandCenterClient, /initialBrief\?: OperationalGovernanceBrief \| null/);
  assert.match(commandCenterLayout, /I can help you review changes, spot risks, prepare updates, create tasks, or generate a project brief\./);
  assert.match(commandCenterLayout, /deriveNeedsYou/);
});

test("no project rollback if brief fails", () => {
  const briefFailureIdx = saveProject.indexOf("project.create.brief_generation_failed");
  const successIdx = saveProject.indexOf("project.create.success", briefFailureIdx);
  const rollbackIdx = saveProject.indexOf("project.create.rollback.started", briefFailureIdx);
  assert.ok(briefFailureIdx > 0, "brief failure event must exist");
  assert.ok(successIdx > briefFailureIdx, "project create still succeeds after brief failure");
  assert.ok(rollbackIdx === -1 || rollbackIdx > successIdx, "brief failure branch must not trigger rollback before success");
});

test("engine hydrates PMO governance, onboarding payload, and workspace runtime state", () => {
  assert.match(orchestrator, /from\("workspace_governance"\)/);
  assert.match(orchestrator, /from\("workspace_runtime_state"\)/);
  assert.match(orchestrator, /projectOnboardingPayload/);
});
