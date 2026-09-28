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
  assert.match(EXECUTION_DOC, /A report can\s+never, on its own, satisfy a precondition for a write, merge, migration or deploy\./);
});

test("results, evidence, verification and project outcome stay distinct", () => {
  assert.ok(EXECUTION_DOC.includes("Execution Result ≠ Execution Evidence ≠ Verification ≠ Project Outcome"));
  assert.match(EXECUTION_DOC, /Executor prose alone never counts as proof\./);
  assert.match(EXECUTION_DOC, /\*\*Execution results are not Project Memory\.\*\*/);
});

test("the brief never carries secrets and repository facts are never invented", () => {
  assert.match(EXECUTION_DOC, /An Execution Brief never contains a secret/);
  assert.match(EXECUTION_DOC, /\{ status: "not_established"; note: string \}/);
  assert.match(EXECUTION_DOC, /Project Brain never\s+infers it\./);
});

// ─── PR #631 review remediation (P2-1 … P2-3) ──────────────────────────────────

const section = (heading) => {
  const start = EXECUTION_DOC.indexOf(heading);
  assert.ok(start >= 0, `section ${heading} missing`);
  const next = EXECUTION_DOC.indexOf("\n### ", start + heading.length);
  const nextTop = EXECUTION_DOC.indexOf("\n## ", start + heading.length);
  const end = [next, nextTop].filter((i) => i > 0).reduce((a, b) => Math.min(a, b), EXECUTION_DOC.length);
  return EXECUTION_DOC.slice(start, end);
};

test("P2-1: a prior recommendation is targeted by an explicit stable reference, validated server-side", () => {
  const target = section("### 9.2 Target selection");
  assert.match(target, /kind: "project_brain_recommendation"; assistantTurnId: string; statementId: string/);
  assert.match(target, /kind: "current_user_request"/);
  for (const rule of [
    /exists in `context_messages`/,
    /belongs to \*\*this\*\* conversation/,
    /`role = 'assistant'` and `brain_mode` is non-null/,
    /statement whose `id = statementId`/,
    /`epistemicType` is `RECOMMENDATION` and its `scope` equals/,
  ]) {
    assert.match(target, rule);
  }
  assert.match(target, /The earlier Recommendation \*\*identifies\*\* the target; it is \*\*not\*\* a source\./);
  assert.match(target, /execution-selection metadata/);
  assert.match(section("## 20. PB-EXEC-01 implementation plan"), /accepts `intent`, `targetRef` and `renderFor`/);
});

test("P2-1: an ambiguous 'it' is never model-guessed", () => {
  const target = section("### 9.2 Target selection");
  assert.match(target, /must not be resolved by letting a model decide what "it" is/);
  assert.match(target, /\*\*Exactly one\*\* → it becomes the target/);
  assert.match(target, /\*\*Zero or more than one\*\* → no provider call; a deterministic `needs_input` brief/);
  assert.match(EXECUTION_DOC, /never a model guess/);
});

test("P2-2: the persisted canonical brief carries stable ids and no S*/R* alias", () => {
  const example = section("### 9.9 Illustrative canonical brief");
  const json = example.slice(example.indexOf("```json") + 7, example.indexOf("```", example.indexOf("```json") + 7));
  const brief = JSON.parse(json);
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => { strings.push(k); walk(v); });
  };
  walk(brief);
  for (const value of strings) assert.doesNotMatch(value, /^[SR]\d+$/, `alias persisted: ${value}`);
  assert.equal(JSON.stringify(brief).includes("\"reportIds\""), false);
  const sourceIds = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (k === "sourceIds") sourceIds.push(...v);
        else collect(v);
      }
    }
  };
  collect(brief);
  assert.ok(sourceIds.length > 0);
  for (const id of sourceIds) assert.match(id, /^[a-z_]+:/, `not a stable evidenceId: ${id}`);
  const schema = section("### 9.4 Canonical schema");
  assert.match(schema, /sourceIds\s+= stable ProjectBrainSourceReference\.evidenceId/);
  assert.match(schema, /reportedTurnIds = context_messages\.id/);
  assert.match(section("### 9.3 Model output vs canonical brief"), /\*\*No field of a persisted brief contains an `S\*` or `R\*` alias\*\*/);
});

test("P2-2: contextFingerprint is built from stable context identifiers only", () => {
  const fp = section("### 9.8 Identity, content hash, context fingerprint and versioning");
  assert.match(fp, /sources:\s+sorted \[ \{ evidenceId, recordedAt \} \]/);
  assert.match(fp, /reportedTurnIds: sorted/);
  assert.match(fp, /target: \{ kind, assistantTurnId\?, statementId\? \}/);
  assert.match(fp, /It never contains an alias \(`S\*`\/`R\*`\), model prose \(`target\.title`/);
});

test("P2-2: briefContentHash is distinct from contextFingerprint and excludes itself", () => {
  const fp = section("### 9.8 Identity, content hash, context fingerprint and versioning");
  assert.match(fp, /contextFingerprint = WHAT CONTEXT WAS USED/);
  assert.match(fp, /briefContentHash   = EXACTLY WHAT THE BRIEF SAYS/);
  assert.match(fp, /\*\*excluding\*\*\s+`identity\.briefContentHash` itself \(no circularity\)/);
  assert.match(fp, /binds to `\(briefId, briefContentHash, contextFingerprint\)`/);
  const schema = section("### 9.4 Canonical schema");
  assert.match(schema, /contextFingerprint: string;/);
  assert.match(schema, /briefContentHash: string;/);
});

test("P2-3: agent_execution_requests is documented as NOT executor-compatible as-is — and the code agrees", () => {
  const mismatch = section("### 10.1 `agent_execution_requests` cannot represent an executor delegation as-is");
  assert.match(mismatch, /= NOT executor-compatible as-is/);
  assert.match(mismatch, /`tool_key text not null`/);
  assert.match(mismatch, /`getAgentToolByKey\(workspaceId, record\.toolKey\)`/);
  assert.doesNotMatch(EXECUTION_DOC, /\*\*Yes — `agent_execution_requests`\*\*/);
  // If the runtime is generalized later, this test forces the document to be updated with it.
  const migration = readFileSync(
    new URL("../supabase/migrations/20260730000000_agent_execution_request_runtime.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /tool_key text not null/);
  const service = readFileSync(new URL("../src/lib/agents/agent-execution-service.ts", import.meta.url), "utf8");
  assert.match(service, /getAgentToolByKey\(input\.workspaceId, record\.toolKey\)/);
});

test("executor ≠ tool remains the model", () => {
  assert.match(EXECUTION_DOC, /An \*\*executor\*\*\. It uses its own tools; PMFreak never registers it in `agent_tools`\./);
  assert.match(EXECUTION_DOC, /The architecture keeps \*Executor ≠ Agent Tool\*/);
  assert.match(EXECUTION_DOC, /no one may paper over with an invented tool key/);
});

test("the PB-EXEC-02 ADR owns the persistence-generalization decision", () => {
  const mismatch = section("### 10.1 `agent_execution_requests` cannot represent an executor delegation as-is");
  assert.match(mismatch, /\*\*Option A — generalize the existing runtime\.\*\*/);
  assert.match(mismatch, /\*\*Option B — build on the canonical Agent Run model\*\*/);
  assert.match(mismatch, /PB-EXEC-00 does not choose/);
  assert.match(EXECUTION_DOC, /\| D9 \|[^\n]*\*\*Deferred to the PB-EXEC-02 ADR\*\*/);
});

test("PB-EXEC-01 never depends on the agent execution runtime", () => {
  assert.match(section("## 20. PB-EXEC-01 implementation plan"), /\| Agent runtime \| \*\*None\.\*\* PB-EXEC-01 imports nothing from `src\/lib\/agents\/\*\*`/);
  assert.match(EXECUTION_DOC, /\*\*PB-EXEC-01 neither reads nor writes the agent execution runtime\*\*/);
  assert.match(CONVERSATION_DOC, /It does not use the agent execution runtime\./);
});

test("requester ≠ approver is marked proposed, not ratified", () => {
  const status = section("### 12.4 Ratified rules vs proposed PB-EXEC-02 policy");
  assert.match(status, /\| \*\*Requester ≠ approver\*\* \(four-eyes\)[^\n]*\| \*\*Proposed\*\* \| PB-EXEC-02 ADR \|/);
  assert.match(status, /none exists in `docs\/adr\/` or `docs\/product-architecture\/` for humans/);
  assert.match(status, /PB-EXEC-00 introduces no new authority rule/);
  for (const line of status.split("\n")) {
    if (/requester ≠ approver|four-eyes/i.test(line) && line.startsWith("|")) {
      assert.doesNotMatch(line, /\*\*Ratified\*\*/, `four-eyes presented as ratified: ${line}`);
    }
  }
  assert.doesNotMatch(EXECUTION_DOC, /requester ≠ approver, which the current runtime does not yet\s+enforce/);
});
