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

test("the execution doc declares the three PB-EXEC levels: PB-EXEC-01 implemented, PB-EXEC-02/03 not", () => {
  for (const level of ["PB-EXEC-01", "PB-EXEC-02", "PB-EXEC-03"]) {
    assert.ok(EXECUTION_DOC.includes(level), `${level} missing`);
  }
  // PB-EXEC-01 implemented the brief; the status line says so and nothing more.
  assert.match(EXECUTION_DOC, /Status: \*\*PB-EXEC-00 is architecture and contract; PB-EXEC-01 \(brief generation and manual\s+handoff\) is implemented\*\*/);
  assert.match(EXECUTION_DOC, /PB-EXEC-02 and PB-EXEC-03 are\s+not implemented: nothing delegates, executes, reads a repository or integrates with Claude Code\s+or Codex\./);
  assert.match(CONVERSATION_DOC, /PB-EXEC-01 is implemented\. PB-EXEC-02 and PB-EXEC-03 are not implemented/);
  for (const overclaim of [/delegated execution (?:is )?implemented/i, /PB-EXEC-02 (?:is )?implemented/i, /repository integration (?:is )?implemented/i, /(?:Claude|Codex) integration (?:is )?implemented/i]) {
    assert.doesNotMatch(EXECUTION_DOC, overclaim);
    assert.doesNotMatch(CONVERSATION_DOC, overclaim);
  }
});

test("P3 cleanup: a persisted brief turn writes both transcript rows and usage; digest staleness is stated per family", () => {
  assert.match(EXECUTION_DOC, /its only writes are the user transcript row\s+\(with its operation identity\), the assistant transcript row \(with the brief in metadata\) and\s+`ai_usage_events`/);
  assert.doesNotMatch(EXECUTION_DOC, /its only writes are the assistant transcript row/);
  const fp = section("### 9.8 Identity, content hash, context fingerprint and versioning");
  assert.match(fp, /\*\*without\*\* an independent revision marker, the digest\s+changes only when the consumed representation changes/);
  assert.match(fp, /\*\*with\*\* a trustworthy revision marker[\s\S]*may conservatively go stale even when the edited content lay outside the\s+consumed excerpt/);
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
  assert.match(section("## 20. PB-EXEC-01 implementation plan"), /accepts `intent` and `targetRef` \(closed shapes, §13\); \*\*no `renderFor`\*\*/);
});

test("P2-1: an ambiguous 'it' is never model-guessed", () => {
  const target = section("### 9.2 Target selection");
  assert.match(target, /must not be resolved by letting a model decide what "it" is/);
  assert.match(target, /\*\*Exactly one\*\* → it becomes the target/);
  assert.match(target, /\*\*Zero or more than one\*\* → \*\*no `ExecutionBriefV1` is produced\*\*/);
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
  assert.match(fp, /sources: sorted \[ \{ evidenceId, sourceContextDigest \} \]/);
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

// ─── PR #631 final remediation (F1 … F8) ──────────────────────────────────────

const subsection = (heading) => {
  const start = EXECUTION_DOC.indexOf(heading);
  assert.ok(start >= 0, `subsection ${heading} missing`);
  const end = EXECUTION_DOC.slice(start + heading.length).search(/\n#{2,4} /);
  return end < 0 ? EXECUTION_DOC.slice(start) : EXECUTION_DOC.slice(start, start + heading.length + end);
};
const fenced = (text, lang) => {
  const open = text.indexOf("```" + lang);
  assert.ok(open >= 0, `no ${lang} block`);
  const body = open + 3 + lang.length;
  return text.slice(body, text.indexOf("```", body));
};
const renderers = () => {
  const r = subsection("### 9.10 Renderers");
  const claudeAt = r.indexOf("**Claude Code** (illustrative");
  const codexAt = r.indexOf("**Codex** (illustrative");
  assert.ok(claudeAt > 0 && codexAt > claudeAt);
  return { rules: r.slice(0, claudeAt), claude: fenced(r.slice(claudeAt, codexAt), "text"), codex: fenced(r.slice(codexAt), "text") };
};

test("F1: the credential boundary is layered, and the existing helpers are not documented as sufficient", () => {
  const guard = subsection("#### 9.5.1 Credential detection boundary");
  assert.match(guard, /The existing helpers are \*\*not\*\* sufficient by themselves/);
  assert.match(guard, /src\/lib\/security\/redaction\.ts/);
  assert.match(guard, /src\/lib\/audit-export\/redaction\.ts/);
  for (const layer of [/Existing value patterns, reused/, /Sensitive-key rules/, /PEM \/ private-key blocks/, /Provider credential formats/, /Bounded opaque-token rule/]) {
    assert.match(guard, layer);
  }
  assert.match(guard, /not a home-grown universal regex/);
  assert.match(guard, /on the assembled canonical brief \*\*before persistence\*\*/);
  assert.match(guard, /on the rendered text \*\*before display and before copy\*\*/);
  assert.match(guard, /The matched value is never\s+stored, logged/);
  assert.match(EXECUTION_DOC, /Detected credential content never enters `ExecutionBriefV1`\./);
  assert.match(subsection("### 15.3 Secrets"), /are \*\*one layer\*\* of it and\s+are not sufficient on their own/);
});

test("F2: unsupported execution-shaped references never survive in any renderer-bound field", () => {
  const grounding = subsection("### 9.5 Grounding and fake-precision enforcement");
  assert.match(grounding, /no unsupported\s+execution-shaped reference may survive as an unqualified instruction in any field that reaches\s+an executor renderer/);
  for (const field of ["`objective.text`", "`scope.inScope[]`", "`scope.outOfScope[]`", "`constraints[].text`", "`acceptanceCriteria[].text`", "`verificationPlan[].step`", "`assumptions[].text`"]) {
    assert.ok(grounding.includes(field), `${field} not covered`);
  }
  assert.match(grounding, /\*\*removed whole\*\* and\s+replaced by an `unknowns` entry/);
  assert.match(grounding, /\*\*without echoing the unsupported token\*\*/);
  assert.match(grounding, /The server never excises tokens from model\s+prose/);
  assert.match(grounding, /Counting alone is never the response/);
});

test("F2b: a server-owned selected target is not a safety-screen bypass", () => {
  const grounding = subsection("### 9.5 Grounding and fake-precision enforcement");
  assert.match(grounding, /\*\*A server-owned target is not a safety exemption\.\*\*/);
  assert.match(grounding, /passes the \*\*same\*\* screen — credential guard,\s+unsupported execution-shaped reference, dangerous command/);
  assert.match(grounding, /the \*\*whole\*\* target is withheld \(`target = null`, `needs_input`,\s+`groundingAdjusted = true`\), `targetRef` still names the selected work/);
  assert.match(grounding, /never\s+echoing it/);
  assert.match(EXECUTION_DOC, /server-owned identity never bypasses that screen/);
  assert.doesNotMatch(EXECUTION_DOC, /the canonical target is always the selected Recommendation/);
});

test("F3: the context fingerprint tracks the consumed source content, not recordedAt", () => {
  const fp = subsection("### 9.8 Identity, content hash, context fingerprint and versioning");
  assert.match(fp, /`recordedAt` is \*\*not\*\* a revision marker for every family/);
  assert.match(fp, /sourceContextDigest = sha256/);
  assert.match(fp, /label, content,\s+\/\/ the post-budget text actually placed in <project_context>/);
  assert.match(fp, /sources: sorted \[ \{ evidenceId, sourceContextDigest \} \]/);
  assert.doesNotMatch(fp, /\{ evidenceId, recordedAt \}\s+for every source/);
  // The fact that motivates the fix must stay true in code, or the document must be revisited.
  const sourceReference = readFileSync(new URL("../src/lib/project-brain/source-reference.ts", import.meta.url), "utf8");
  assert.match(sourceReference, /sourceSystem: "evidence_items",[\s\S]{0,120}recordedAt: row\.created_at/);
});

test("F4: the turn operation identity prevents cross-operation replay; renderFor is not part of it", () => {
  const decision = section("## 13. PB-EXEC-01 model-call decision");
  assert.match(decision, /metadata\.projectBrainRequest = \{ operation: "answer" \| "execution_brief",\s+targetRef: ExecutionBriefTargetRef \| null \}/);
  assert.match(decision, /client_message_id_reused_with_different_operation/);
  assert.match(decision, /\*answer vs execution_brief\* conflicts, and \*execution_brief with a different\s+`targetRef`\* conflicts/);
  assert.match(decision, /\*\*`renderFor` is not part of the turn — decided\.\*\*/);
  assert.match(decision, /changing it issues no request, causes no inference, writes nothing and never changes the canonical\s+brief/);
  const plan = section("## 20. PB-EXEC-01 implementation plan");
  assert.match(plan, /same `clientMessageId` with `answer` vs `execution_brief` → 409, with a different `targetRef` → 409, never a wrong replay/);
  assert.match(plan, /switching renderer on the same brief → same canonical brief and hash, no request, no inference/);
});

test("F5: the objective carries structured provenance and gates readiness", () => {
  const schema = section("### 9.4 Canonical schema");
  assert.match(schema, /objective: \{[\s\S]*?origin: Exclude<BriefOrigin, "policy">;[\s\S]*?sourceIds: string\[\]; reportedTurnIds: string\[\];/);
  assert.doesNotMatch(schema, /objective: string;/);
  assert.match(section("### 9.7 Readiness"), /\*\*`objective\.origin` is `project_record` or `reported`\*\* with valid support/);
  const brief = JSON.parse(fenced(subsection("### 9.9 Illustrative canonical brief"), "json"));
  assert.equal(typeof brief.objective, "object");
  assert.equal(brief.objective.origin, "project_record");
  assert.ok(brief.objective.sourceIds.length > 0);
  const { claude, codex } = renderers();
  assert.match(claude, /OBJECTIVE\s+\[project record\]/);
  assert.match(codex, /Goal \[project record\]:/);
});

test("F6: every executor renderer keeps the AI-generated / manual-handoff / not-authorization banner", () => {
  const { rules, claude, codex } = renderers();
  assert.match(rules, /\*\*Authorship and authority banner at the top of the rendered text\*\*/);
  for (const [name, text] of [["claude", claude], ["codex", codex]]) {
    const top = text.trim().split("\n").slice(0, 2).join("\n");
    assert.match(top, /AI-generated/, `${name}: AI-generated label missing at the top`);
    assert.match(top, /manual handoff/, `${name}: manual handoff missing at the top`);
    assert.match(top, /not an authorization to execute, merge or deploy/i, `${name}: authority disclaimer missing`);
  }
});

test("F7: renderers change formatting, never epistemic authority", () => {
  const { rules, claude, codex } = renderers();
  assert.match(rules, /\*\*Renderers may change formatting\. They may not change epistemic authority\.\*\*/);
  const brief = JSON.parse(fenced(subsection("### 9.9 Illustrative canonical brief"), "json"));
  const suggested = brief.acceptanceCriteria.filter((c) => c.origin === "suggested");
  assert.ok(suggested.length > 0, "the example must exercise a suggested criterion");
  for (const [name, text] of [["claude", claude], ["codex", codex]]) {
    assert.match(text, /\[suggested\][^\n]*empty period|empty period[^\n]*\[suggested\]/, `${name}: suggested criterion unmarked`);
    assert.match(text, /\[project record\][^\n]*voided invoices|voided invoices[^\n]*\[project record\]/, `${name}: record criterion unmarked`);
    assert.match(text, /reported · unverified|reported in chat, not verified/, `${name}: reported context unmarked`);
    assert.match(text, /\[policy\]/, `${name}: policy items unmarked`);
  }
});

test("F8: an ambiguous target is resolved before the turn, persists nothing and never mislabels brain_mode", () => {
  const ambiguous = subsection("#### 9.2.1 Ambiguous target");
  assert.match(ambiguous, /\*\*Decision: option B — target\s+resolution happens before the turn is persisted\.\*\*/);
  assert.match(ambiguous, /\*\*No user row, no assistant row, no\s+provider call, no `ai_usage_events` row\.\*\*/);
  assert.match(ambiguous, /can never\s+look pending/);
  assert.match(ambiguous, /\*\*PB-EXEC-01 needs no migration for this\*\*/);
  assert.match(ambiguous, /labelling\s+the result `generative` or `degraded` — both would be false/);
  const schema = section("### 9.4 Canonical schema");
  assert.doesNotMatch(schema, /mode: "deterministic"/);
  assert.doesNotMatch(schema, /kind: "unresolved"/);
  assert.doesNotMatch(section("## 23. Open questions"), /stores the deterministic ambiguous-target reply/);
});
