/**
 * PB-EXEC-01 — render harness for the Execution Brief card and the prepare controls.
 *
 * Executed by tests/pb-exec-01-brief-presentation.test.mjs through tsx (the PB-PRESENT-01
 * pattern) and bundled for the browser by tests/e2e/pb-exec-01-brief-card.spec.ts. Every
 * brief case is PRODUCED by the real turn service (memory store + scripted model), goes
 * through the real `toProjectBrainMessageView`, and is rendered by the real
 * `ProjectBrainAnswer` — the component the conversation mounts for every assistant turn.
 *
 * `buildCases()` is shared; running this file directly prints one JSON document.
 */

import { renderToStaticMarkup } from "react-dom/server";
import type { ContextConversationRow, ContextMessageRow } from "../src/lib/db/database-contract";
import type { InferenceRequest } from "../src/lib/ai/inference/types";
import { ProjectBrainAnswer } from "../src/components/pmfreak/project-brain/project-brain-conversation";
import { deriveAnswerDisclosure } from "../src/components/pmfreak/project-brain/answer-disclosure";
import { assembleProjectBrainContext } from "../src/lib/project-brain/conversation/context-builder";
import { runProjectBrainRequest, type ProjectBrainTurnStore } from "../src/lib/project-brain/conversation/turn-service";
import { toProjectBrainMessageView, type ProjectBrainMessageView } from "../src/lib/project-brain/conversation/transcript-view";
import { renderExecutionBrief } from "../src/lib/project-brain/execution-brief/render";
import { computeBriefContentHash } from "../src/lib/project-brain/execution-brief/assemble";
import { persistedBriefVerifier } from "../src/lib/project-brain/execution-brief/verify";
import type { ExecutionBriefModelOutput } from "../src/lib/project-brain/execution-brief/schema";
import { EXECUTION_BRIEF_RENDERERS, type ExecutionBriefV1 } from "../src/lib/project-brain/execution-brief/types";
import { FIXTURE_NOW, p14ExportProject, PROJECT, scope, USER, WS } from "./fixtures/pb-exec-01-projects";

type Store = ProjectBrainTurnStore & { rows: ContextMessageRow[]; seed(extra: Partial<ContextMessageRow>): ContextMessageRow };

function memoryStore(): Store {
  const rows: ContextMessageRow[] = [];
  let seq = 0;
  const conversation = { id: "c0000000-0000-4000-8000-000000000001", workspace_id: WS, context_type: "project", pmo_id: null, project_id: PROJECT, title: "t", status: "active", created_by_user_id: USER, created_at: FIXTURE_NOW.toISOString(), updated_at: FIXTURE_NOW.toISOString() } as ContextConversationRow;
  const insert = (extra: Partial<ContextMessageRow>) => {
    seq += 1;
    const row = { id: `d0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, conversation_id: conversation.id, workspace_id: WS, role: "user", content: "", metadata: null, created_by_user_id: USER, created_at: new Date(FIXTURE_NOW.getTime() - 3_600_000 + seq * 60_000).toISOString(), message_seq: seq, client_message_id: null, reply_to_message_id: null, brain_mode: null, ...extra } as ContextMessageRow;
    rows.push(row);
    return row;
  };
  return {
    rows,
    seed: insert,
    findConversation: async () => conversation,
    getOrCreateConversation: async () => conversation,
    listMessages: async () => [...rows],
    findUserMessage: async (_c, id) => rows.find((r) => r.role === "user" && r.client_message_id === id) ?? null,
    insertUserMessage: async (_c, clientMessageId, content, metadata) => ({ row: insert({ client_message_id: clientMessageId, content, metadata: metadata ?? null }) }),
    findMessage: async (_c, id) => rows.find((r) => r.id === id) ?? null,
    listReplies: async (_c, id) => rows.filter((r) => r.reply_to_message_id === id),
    insertReply: async (input) => ({ row: insert({ role: "assistant", content: input.content, metadata: input.metadata, created_by_user_id: null, reply_to_message_id: input.replyToMessageId, brain_mode: input.mode }) }),
  };
}

const alias = (prompt: string, labelPart: string) => {
  const lines = prompt.split("\n");
  const index = lines.findIndex((l) => l.includes(labelPart) && !l.startsWith("<turn"));
  return lines[index - 1].match(/<source id="(S\d+)"/)![1];
};
const reportFor = (prompt: string, content: string) => prompt.split("\n").find((l) => l.startsWith("<turn") && l.includes(content))?.match(/report_id="(R\d+)"/)?.[1] ?? "R1";

function selectedTarget(prompt: string): { title: string; statement: string } | null {
  const m = prompt.match(/<selected_target title="([^"]*)" statement="([^"]*)">/);
  const un = (v: string) => v.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return m ? { title: un(m[1]), statement: un(m[2]) } : null;
}

function good(prompt: string): ExecutionBriefModelOutput {
  const p14 = alias(prompt, "Milestone — P14 Invoice export");
  const decision = alias(prompt, "Decision — Invoice exports must exclude voided invoices");
  return {
    capabilityFit: "fits",
    // A compliant model echoes the server-owned target (final review) when one is given.
    target: { ...(selectedTarget(prompt) ?? { title: "Implement P14 — invoice export", statement: "Build the CSV invoice export described in milestone P14." }), sourceAliases: [p14], reportAliases: [] },
    objective: { text: "Users can export one billing period's invoices as CSV from the billing page.", origin: "project_record", sourceAliases: [p14], reportAliases: [] },
    whyNow: { text: "P14 is the next planned milestone.", sourceAliases: [p14], reportAliases: [] },
    knownContext: [{ text: "Milestone P14 Invoice export is planned with a target of 2026-10-15.", sourceAliases: [p14] }],
    reportedContext: [],
    assumptions: [{ text: "The export runs on demand." }],
    unknowns: [{ fact: "The exact CSV column order", why: "No record states it.", resolveBy: "user", blocking: false }],
    scope: { inScope: ["CSV export of one billing period's invoices"], outOfScope: ["PDF export"] },
    areasToInspect: [],
    constraints: [{ text: "Voided invoices must never appear in an export.", origin: "project_record", sourceAliases: [decision], reportAliases: [] }],
    acceptanceCriteria: [
      { text: "Exporting a period with voided invoices produces a CSV without them.", origin: "project_record", sourceAliases: [decision], reportAliases: [] },
      { text: "An empty period produces a CSV with only the header row.", origin: "suggested", sourceAliases: [], reportAliases: [] },
    ],
    verificationPlan: [{ step: "Add automated tests for voided-invoice exclusion", kind: "test", command: null, sourceAliases: [], reportAliases: [] }],
  };
}

function seedAnswer(store: Store, recommendations: string[]) {
  const user = store.seed({ content: "What should I work on next?", client_message_id: `00000000-0000-4000-8000-${String(store.rows.length + 900).padStart(12, "0")}` });
  // As persisted: the full current reference of the P14 milestone the Recommendation cited.
  const anchor = JSON.parse(JSON.stringify(assembleProjectBrainContext({ ...p14ExportProject(), history: [] }).sources.find((s) => s.reference.evidenceId === "project_milestones:f0000014-0000-4000-8000-000000000000")!.reference));
  const statements = recommendations.map((text, i) => ({ id: `${user.id}:${i}`, scope, epistemicType: "RECOMMENDATION", text, confidence: { kind: "qualitative", level: "medium" }, sources: [anchor], requiresHumanApproval: true, generatedAt: FIXTURE_NOW.toISOString(), constitutionVersion: "1.1.0" }));
  return store.seed({ role: "assistant", content: "Based on the current project state, I recommend implementing P14 next.", created_by_user_id: null, reply_to_message_id: user.id, brain_mode: "generative", metadata: { projectBrain: { version: 1, mode: "generative", statements, sources: [], constitutionVersion: "1.1.0", citations: { rejectedCitations: 0, downgradedStatements: 0, droppedStatements: 0, unsupportedReferences: 0 }, context: { sourceCount: 0, truncated: false, unavailable: [] } } } });
}

async function produce(patch: (o: ExecutionBriefModelOutput, prompt: string) => void, opts: { entitled?: boolean; before?: string[]; recommendation?: string } = {}) {
  const store = memoryStore();
  let n = 0;
  const deps = {
    scope, userId: USER, generativeEntitled: opts.entitled ?? true, store, now: () => FIXTURE_NOW,
    loadContext: async (history: never[]) => assembleProjectBrainContext({ ...p14ExportProject(), history }),
    infer: async (request: InferenceRequest) => {
      const prompt = request.messages[1].content;
      if (request.operationName === "project_brain.turn") return { provider: "openai", model: "stub", content: "{}", parsedJson: { reply: "Noted.", statements: [] } };
      const out = good(prompt);
      patch(out, prompt);
      return { provider: "openai", model: "stub", content: JSON.stringify(out), parsedJson: out };
    },
  };
  for (const text of opts.before ?? []) {
    await runProjectBrainRequest(deps, { clientMessageId: `00000000-0000-4000-8000-${String(++n + 500).padStart(12, "0")}`, text });
  }
  const reply = seedAnswer(store, [opts.recommendation ?? "Implement P14 invoice export next."]);
  const result = await runProjectBrainRequest(deps, {
    clientMessageId: "00000000-0000-4000-8000-000000000777",
    text: "Prepare an execution brief for the selected recommendation.",
    request: { operation: "execution_brief", targetRef: { kind: "project_brain_recommendation", assistantTurnId: reply.id, statementId: `${reply.reply_to_message_id}:0` } },
  });
  if (result.status !== "completed") throw new Error("harness: brief not completed");
  return result.reply;
}

export async function buildCases(): Promise<Record<string, ContextMessageRow>> {
  const ready = await produce(() => {});
  const needsInput = await produce((o) => (o.objective = { ...o.objective, origin: "suggested", sourceAliases: [] }));
  const reported = await produce(
    (o, prompt) => (o.reportedContext = [{ text: "P13 was merged this morning.", reportAliases: [reportFor(prompt, "P13 merged")], executionSensitive: true }]),
    { before: ["P13 merged this morning."] },
  );
  const adjusted = await produce((o) => o.scope.outOfScope.push("Do not modify src/unsupplied/billing/"));
  const long = await produce((o) => {
    o.knownContext.push({ text: `Very long identifier ${"x".repeat(240)}`, sourceAliases: o.knownContext[0].sourceAliases });
  });
  // A selected Recommendation naming a path nothing supplied: identity kept, target withheld.
  const withheld = await produce(() => {}, { recommendation: "Implement P14 in src/not-established/export.ts." });
  const degraded = await produce(() => {}, { entitled: false });
  const malformed = { ...ready, id: "d0000000-0000-4000-8000-00000000abcd", metadata: { projectBrain: { ...(ready.metadata as { projectBrain: object }).projectBrain, executionBrief: { schema: "pmfreak.execution-brief", version: 1 } } } } as ContextMessageRow;
  // A brief that validates but whose text carries a credential-shaped value (the server
  // guard refuses such briefs; this proves the browser's own boundary blocks display/copy).
  const poisonedMeta = JSON.parse(JSON.stringify(ready.metadata)) as { projectBrain: { executionBrief: ExecutionBriefV1 } };
  poisonedMeta.projectBrain.executionBrief.assumptions.push({ text: `Use ${["gh", "p_", "fake0fake0fake0fake0fake0fake"].join("")}` });
  // Re-hashed, so it passes the server's integrity/binding check and exercises boundary 3.
  poisonedMeta.projectBrain.executionBrief.identity.briefContentHash = computeBriefContentHash(poisonedMeta.projectBrain.executionBrief);
  const poisoned = { ...ready, id: "d0000000-0000-4000-8000-00000000beef", metadata: poisonedMeta } as unknown as ContextMessageRow;
  const store = memoryStore();
  const threeRecommendations = seedAnswer(store, ["Implement P14 invoice export.", "Close the P13 review.", "Draft the go-live checklist."]);
  return { ready, needsInput, reported, adjusted, long, withheld, degraded, malformed, poisoned, threeRecommendations };
}

async function main() {
  const cases = await buildCases();
  const views: Record<string, ProjectBrainMessageView> = {};
  const markup: Record<string, string> = {};
  const disclosure: Record<string, unknown> = {};
  const rendered: Record<string, Record<string, string>> = {};
  for (const [name, row] of Object.entries(cases)) {
    const view = toProjectBrainMessageView(row, { verifyExecutionBrief: persistedBriefVerifier(scope) })!;
    views[name] = view;
    markup[name] = renderToStaticMarkup(<ProjectBrainAnswer message={view} variant="light" layout="surface" onPrepareBrief={() => {}} />);
    disclosure[name] = view.brain ? deriveAnswerDisclosure(view.brain) : null;
    if (view.brain?.executionBrief) {
      rendered[name] = Object.fromEntries(EXECUTION_BRIEF_RENDERERS.map((r) => [r, renderExecutionBrief(view.brain!.executionBrief!, r)]));
    }
  }
  process.stdout.write(JSON.stringify({ views, markup, disclosure, rendered }));
}

if (process.argv[1]?.endsWith("pb-exec-01-harness.tsx")) void main();
