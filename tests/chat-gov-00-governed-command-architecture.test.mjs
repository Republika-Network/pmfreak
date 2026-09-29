import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CHAT-GOV-00 — chat-hosted governed human command controls (ADR-PMF-077).
 *
 * Architecture-only increment. This pins the boundaries the ADR and the architecture document
 * ratify, so a later CHAT-GOV slice cannot quietly delete them, plus the code facts they rely on:
 * Project Brain's server path (the `/brain/turns` route and `src/lib/project-brain/**`) gives the
 * model no tools and reaches no canonical command. It deliberately does NOT guard UI components:
 * later slices are expected to add human-operated controls there that call the canonical command
 * endpoints.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const ADR = read("docs/adr/ADR-PMF-077-chat-hosted-governed-command-controls.md");
const ARCH = read("docs/project-brain-governed-commands.md");
const CONVERSATION_DOC = read("docs/project-brain-conversation.md");
const EXECUTION_DOC = read("docs/project-brain-execution.md");

const section = (doc, heading) => {
  const start = doc.indexOf(heading);
  assert.ok(start >= 0, `section ${heading} missing`);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end < 0 ? doc.slice(start) : doc.slice(start, start + heading.length + end);
};

const walk = (dir) =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? walk(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });

// The server-side conversation path: everything the model's turn can execute.
const BRAIN_SERVER_FILES = [...walk("src/lib/project-brain"), ...walk("src/app/api/projects/[id]/brain")];

test("ADR-PMF-077 is accepted and ratifies human-operated controls, never model-controlled execution", () => {
  assert.match(ADR, /^# ADR-PMF-077: Chat-Hosted Governed Command Controls/);
  assert.match(ADR, /\nStatus: Accepted\n/);
  assert.match(ADR, /\*\*Chat-first means conversation plus human-operated governed command controls plus the existing\s+canonical command endpoints\. It never means model-controlled execution\.\*\*/);
  assert.match(ADR, /`\/brain\/turns` remains read-only permanently\./);
  assert.match(ADR, /A \*\*tool\*\* is an operation the \*model\* can invoke\. Project Brain has none, and gains none\./);
  assert.match(ADR, /A \*\*governed command control\*\* is a UI control a \*human\* operates\./);
  assert.match(ADR, /"Separate surface" in PB-EXEC-00 §4\/§12\.2\/§14 means a separate \*\*command endpoint with separate\s+authority\*\*, never `\/brain\/turns`\./);
  assert.match(ADR, /The model cannot press, select, confirm or submit a\s+control/);
  assert.match(ADR, /\*\*The model cannot manufacture canonical ids\.\*\*/);
  assert.match(ADR, /There is no chat-specific write endpoint and no direct table write from chat\./);
  assert.match(ADR, /## Migration Implications\n\nNone\. This ADR changes no schema and no runtime behavior\./);
});

test("the architecture diagram has no Model → Command API path", () => {
  const diagram = section(ARCH, "## 2. Architecture");
  const order = ["MODEL / CONVERSATION", "CANONICAL READ MODEL", "STRUCTURED HUMAN CONTROL", "CANONICAL COMMAND API", "GOVERNED DOMAIN STATE"];
  let at = -1;
  for (const box of order) {
    const next = diagram.indexOf(box, at + 1);
    assert.ok(next > at, `${box} missing or out of order`);
    at = next;
  }
  assert.match(diagram, /explicit human click/);
  assert.match(diagram, /There is NO arrow from MODEL \/ CONVERSATION to CANONICAL COMMAND API\./);
  assert.match(diagram, /There is NO arrow from MODEL \/ CONVERSATION to STRUCTURED HUMAN CONTROL activation\./);
  assert.match(diagram, /It never influences \*\*what is submitted\*\*/);
});

test("the two channels are ratified: conversation writes only transcript and usage", () => {
  const channels = section(ARCH, "## 3. Two channels");
  assert.match(channels, /`context_messages` transcript rows and normal AI usage metadata \(`ai_usage_events`\) only/);
  assert.match(channels, /\| Canonical project-state mutation \| \*\*None\*\* \| Exactly one canonical transition per command \|/);
  assert.match(channels, /`POST \/api\/operational-flow`, `POST \/api\/execution-tasks\/internal-execution`/);
  assert.match(channels, /\*\*The controls may visually live inside the conversation thread but remain architecturally\s+separate from the model\.\*\*/);
  for (const duty of ["Explain", "summarize", "reason", "cite", "suggest", "answer questions"]) assert.ok(channels.includes(duty), duty);
});

test("the eight tool-vs-control rules are stated verbatim", () => {
  const rules = section(ARCH, "## 4. Tools versus governed command controls");
  for (const rule of [
    "`/brain/turns` remains read-only permanently.",
    "Project Brain itself receives no write tools, agent identity or grants.",
    "The conversation surface MAY host structured human command controls.",
    "Those controls are not model tools.",
    "Controls call existing canonical server operations directly",
    "The model cannot press, select, confirm or submit those controls.",
    "The model cannot manufacture canonical IDs.",
    "Canonical references rendered beside replies must be verified server-side.",
  ]) {
    assert.ok(rules.includes(rule), `missing rule: ${rule}`);
  }
  assert.match(rules, /\| Exists for Project Brain \| \*\*No — never\*\* \(PB-EXEC-00 §4\) \|/);
  assert.match(section(ARCH, "## 5. Canonical references beside replies"), /Model text that names an id, a code or a title is never a reference and never produces a card\./);
});

test("one command per authority level; named composite operations are prohibited", () => {
  const one = section(ARCH, "## 6. One command per authority level");
  assert.match(one, /No UI control may perform more than one canonical transition\./);
  for (const transition of ["Recommendation → Decision", "Decision → Action", "Action → Task", "Task → Execution", "Execution → Outcome"]) {
    assert.ok(one.includes(`| ${transition} |`), transition);
  }
  for (const composite of ["Accept and create action", "Authorize and dispatch", "Complete task and mark outcome achieved"]) {
    assert.ok(one.includes(`- ${composite}`), composite);
  }
  assert.match(one, /An offer is never a default and never pre-submitted\./);
  assert.match(ADR, /No control performs more than one canonical transition\./);
  assert.match(ADR, /Composite controls such as\s+"Accept and create action", "Authorize and dispatch" or "Complete task and mark outcome\s+achieved" are prohibited/);
});

test("live cards render verified, current canonical state with one actionable instance", () => {
  const live = section(ARCH, "## 7. Live-card semantics");
  for (const rule of [
    "be keyed by a verified canonical entity id;",
    "render current canonical state, not frozen model output;",
    "refresh after commands",
    "have at most one actionable instance per canonical object;",
    "collapse stale historical instances into read-only status indicators;",
    "never treat transcript prose as authoritative canonical state.",
  ]) {
    assert.ok(live.includes(rule), rule);
  }
  assert.match(live, /Commands are not copied into the transcript\./);
});

test("natural language never executes a write; the intent layer only focuses, opens or chooses", () => {
  const nl = section(ARCH, "## 8. Natural-language boundary");
  for (const phrase of ["accept it", "go ahead", "do it", "create the task", "yes"]) assert.ok(nl.includes(`"${phrase}"`), phrase);
  assert.match(nl, /\*\*MUST NEVER directly execute a write\.\*\*/);
  assert.match(nl, /It must NOT submit the operation\. Confirmation must occur through the structured governed control\./);
  assert.match(nl, /never resolved by letting a model\s+decide what "it" is/);
  assert.match(nl, /Pressing Enter in the composer never confirms a card\./);
  assert.match(ADR, /\*\*Natural language never confirms a write\.\*\*/);
});

test("confirmation tiers T0–T3 are defined and T3 has the ratified floor", () => {
  const tiers = section(ARCH, "## 9. Confirmation tiers");
  for (const tier of ["**T0**", "**T1**", "**T2**", "**T3**"]) assert.ok(tiers.includes(tier), tier);
  assert.match(tiers, /explicit per-field affirmation; no Enter-to-confirm behavior/);
  const floor = tiers.slice(tiers.indexOf("**T3 must apply at minimum to:**"));
  for (const trigger of ["external effects;", "irreversible actions;", "authority mutation;", "critical risk;", "material/high-consequence actions;", "ambiguous/unknown materiality fields."]) {
    assert.ok(floor.includes(trigger), trigger);
  }
  assert.match(tiers, /The conversation can never lower it\./);
  assert.match(tiers, /a later slice may make it stricter, never looser/);
  assert.match(tiers, /\| Propose Action, any other classification \| T3 \|/);
});

test("non-goals are explicit", () => {
  const goals = section(ARCH, "## 12. Explicit non-goals");
  for (const nonGoal of [
    "give tools to the Project Brain model;",
    "allow direct table writes from chat;",
    "introduce composite decide-and-act endpoints;",
    "allow natural-language write confirmation;",
    "use the agent execution runtime as the governed command path;",
    "merge RAID and governed recommendation semantics;",
    "infer outcome achievement from task completion;",
    "delete Needs You / Evidence / Tasks / Monitor / Audit surfaces.",
  ]) {
    assert.ok(goals.includes(`- ${nonGoal}`), nonGoal);
  }
  assert.match(goals, /does not reintroduce automatic `run_chain` after capture \(PR #568\)/);
});

test("gaps G1–G10 are recorded and explicitly unresolved", () => {
  const gaps = section(ARCH, "## 13. Known unresolved gaps");
  assert.match(gaps, /\*\*CHAT-GOV-00 does not resolve any of\s+them\.\*\*/);
  for (let n = 1; n <= 10; n += 1) assert.match(gaps, new RegExp(`\\n\\| G${n} \\| `), `G${n} missing`);
  assert.match(gaps, /\| G2 \| Missing approval operation for `requires_approval` \|/);
  assert.match(gaps, /\| G10 \| Task → Execution → Outcome SIT not yet revalidated \|/);
  assert.match(ADR, /They are recorded, not resolved\./);
});

test("PB-CHAT-01 is amended without weakening no write-back", () => {
  const controls = section(CONVERSATION_DOC, "## Governed command controls (CHAT-GOV)");
  for (const rule of [
    "**`/brain/turns` remains read-only permanently.**",
    "**Project Brain itself receives no write tools, agent identity or grants.**",
    "**The conversation surface MAY host structured human command controls.**",
    "**Those controls are not model tools.**",
    "**Controls call existing canonical server operations directly**",
    "**The model cannot press, select, confirm or submit those controls.**",
    "**The model cannot manufacture canonical IDs.**",
  ]) {
    assert.ok(controls.includes(rule), rule);
  }
  assert.match(controls, /Canonical references rendered beside replies must\s+be verified server-side/);
  const noWriteBack = section(CONVERSATION_DOC, "## No write-back");
  assert.match(noWriteBack, /The only writes behind a turn are the two transcript rows and the AI usage row/);
  assert.match(noWriteBack, /This guarantee is about `\/brain\/turns` and it is permanent\./);
  assert.match(noWriteBack, /never by a turn/);
});

test("PB-EXEC-00 §4/§12.2/§14 are clarified and D19 is registered", () => {
  assert.match(EXECUTION_DOC, /\*\*"Project Brain has no tools" is compatible with "Project Brain hosts governed human command\s+controls"\*\*/);
  assert.match(EXECUTION_DOC, /a "separate\s+surface" for a command means a \*\*separate command endpoint with separate authority\*\*; it does not\s+require a separate screen\./);
  assert.match(EXECUTION_DOC, /Action → Task, Task → Execution and Execution → Outcome are separate commands, and no control\s+performs more than one of them\. An utterance never activates a control\./);
  assert.match(EXECUTION_DOC, /- Hosting is not routing \(CHAT-GOV-00, ADR-PMF-077\)\./);
  assert.match(EXECUTION_DOC, /`\/brain\/turns` gains no write operation and no request field that names a command\./);
  assert.match(EXECUTION_DOC, /\| D19 \| The conversation may host human-operated governed command controls[^\n]*\| Decided \(CHAT-GOV-00, ADR-PMF-077\) \|/);
  // The ratified read-only statements are still there, unchanged.
  assert.match(EXECUTION_DOC, /`\/brain\/turns` stays read-only forever/);
  assert.match(EXECUTION_DOC, /Project Brain gains no tools, no agent identity, no scopes, no grants — in any PB-EXEC level\./);
});

test("code fact: Project Brain's server path gives the model no tools", () => {
  assert.ok(BRAIN_SERVER_FILES.length > 10, "project-brain server files not found");
  for (const file of BRAIN_SERVER_FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /\btool_choice\b|\btools\s*:|\bfunctions\s*:|\bfunction_call\b/, `${file} declares a model tool`);
  }
});

test("code fact: Project Brain's server path reaches no canonical command", () => {
  const COMMANDS = /postOperationalFlow|runExecutionOperation|\/api\/operational-flow|internal-execution|recordHumanDecision|proposeGovernedMaterialAction|dispatchGovernedMaterialActionToTask|revokeGovernedMaterialAction|ensureExpectedOutcome|recordOutcomeObservation|captureOperationalInput|captureLiveOperationalInput|deriveEvidence|runEvidenceDecisionChain|record_operational_decision|persist_governed_material_action|revoke_governed_material_action|dispatch_governed_action_to_internal_task|dispatch_internal_task_execution|transition_internal_task_execution|ensure_expected_task_outcome|record_canonical_outcome_observation|materialize_operational_chain/;
  for (const file of BRAIN_SERVER_FILES) {
    assert.doesNotMatch(read(file), COMMANDS, `${file} references a canonical command`);
  }
  // The one sanctioned dependency on the operational-flow service is its read model.
  const imports = BRAIN_SERVER_FILES.flatMap((file) =>
    [...read(file).matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@\/lib\/operational-flow\/operational-flow-service"/g)].map((m) => m[2].trim()),
  );
  assert.deepEqual(imports, ["getOperationalSummary"]);
});
