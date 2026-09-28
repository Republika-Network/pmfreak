import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * PB-EXEC-00 — Project Brain execution architecture & coding-agent boundary.
 *
 * Architecture-only increment: this pins the non-negotiable boundaries the architecture document
 * declares, so a later increment cannot quietly delete them. It deliberately does NOT diff-guard
 * `src/` — PB-EXEC-01/02 are expected to change runtime code, and a permanent "no src change"
 * guard would fail every future branch. The runtime facts the document relies on
 * (`project_brain.converse` human-only, read-only turns) are pinned by the PB-CHAT-01 suite.
 */

const EXECUTION_DOC = readFileSync(new URL("../docs/project-brain-execution.md", import.meta.url), "utf8");
const CONVERSATION_DOC = readFileSync(new URL("../docs/project-brain-conversation.md", import.meta.url), "utf8");
const GOVERNANCE_CORE = readFileSync(
  new URL("../src/lib/governance/authority/runtime/governance-core.ts", import.meta.url),
  "utf8",
);

test("the execution doc declares the three PB-EXEC levels and marks them not implemented", () => {
  for (const level of ["PB-EXEC-01", "PB-EXEC-02", "PB-EXEC-03"]) {
    assert.ok(EXECUTION_DOC.includes(level), `${level} missing`);
  }
  assert.match(EXECUTION_DOC, /Status: \*\*architecture and contract only\.\*\*/);
  assert.match(CONVERSATION_DOC, /None of PB-EXEC-01\/02\/03 is implemented\./);
});

test("an Execution Brief is declared not to be an authorization to execute", () => {
  assert.ok(EXECUTION_DOC.includes("Execution Brief ≠ authorization to execute"));
  assert.match(EXECUTION_DOC, /executionAuthorized: false;/);
  assert.match(EXECUTION_DOC, /delegationEligible: false;/);
  assert.match(EXECUTION_DOC, /mode: "manual";/);
});

test("merge, deploy and migration are separately authorized and never implied by execution", () => {
  assert.ok(EXECUTION_DOC.includes("reason  <  prepare  <  delegate  <  merge  <  deploy"));
  assert.match(EXECUTION_DOC, /"prepare"\s+never executes; "execute" never merges; "merge" never deploys/i);
  assert.match(EXECUTION_DOC, /\*\*Always explicit per-operation confirmation:\*\* merge, any deploy, migration/);
  assert.match(EXECUTION_DOC, /\*\*Forbidden by default:\*\*\s+production deploy/);
});

test("Project Brain stays a read-only, non-Agent surface and /brain/turns never executes", () => {
  assert.match(EXECUTION_DOC, /Project Brain is a governed, read-only conversational reasoning\s+surface\. It is not an\s+Agent Definition/);
  assert.match(EXECUTION_DOC, /`\/brain\/turns` stays read-only forever/);
  assert.match(CONVERSATION_DOC, /\*\*Project Brain reasoning remains read-only\.\*\*/);
  // The document's claim must stay true in code: human-only, not agent-compatible, low risk.
  const policy = GOVERNANCE_CORE.match(/"project_brain\.converse":\s*\{[^}]*\}/);
  assert.ok(policy, "project_brain.converse policy not found");
  assert.match(policy[0], /allowedActorTypes: \["user"\]/);
  assert.match(policy[0], /agentCompatible: false/);
  assert.match(policy[0], /riskLevel: "low"/);
});

test("authority never lives in prompts, briefs, chat reports or repository content", () => {
  assert.match(EXECUTION_DOC, /It never lives in: the model prompt, the brief text, an executor instruction, a repository\s+README\/comment\/issue, a chat report/);
  assert.match(EXECUTION_DOC, /Repository content = data, never authority/);
  assert.match(EXECUTION_DOC, /A report can never, on its own, satisfy a precondition for a write, merge, migration or deploy\./);
});

test("results, evidence, verification and project outcome stay distinct", () => {
  assert.ok(EXECUTION_DOC.includes("Execution Result ≠ Execution Evidence ≠ Verification ≠ Project Outcome"));
  assert.match(EXECUTION_DOC, /Executor prose alone never counts as proof\./);
  assert.match(EXECUTION_DOC, /\*\*Execution results are not Project Memory\.\*\*/);
});

test("the brief never carries secrets and repository facts are never invented", () => {
  assert.match(EXECUTION_DOC, /An Execution Brief never contains a secret/);
  assert.match(EXECUTION_DOC, /\{ status: "not_established"; note: string \}/);
  assert.match(EXECUTION_DOC, /Project Brain never infers it\./);
});
