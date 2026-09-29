/**
 * PB-EXEC-01 — real-provider certification of execution-brief generation (manual; not CI).
 *
 *   npx tsx scripts/pb-exec-01/certify-execution-brief.ts [out.json]
 *
 * Runs representative brief requests through the REAL turn service — target resolution,
 * the dedicated `project_brain.execution_brief` prompt and strict schema, grounding,
 * assembly, hashing, validation and the transcript view — against the REAL configured
 * provider adapter, over tests/fixtures/pb-exec-01-projects.ts. Only the runInference
 * wrapper (quota / usage accounting, which need a database) is bypassed; token usage is
 * captured from the provider response instead.
 *
 * Same outcome contract and env handling as PB-REASON-01/02 (reused, not duplicated):
 * the key is read from the environment or .env.local and is NEVER printed.
 *
 *   NOT_AVAILABLE  no provider key is configured                                exit 0
 *   RUN            every case produced a generative brief AND passed its structural
 *                  checks (strict schema accepted, one provider call, no S…/R… alias
 *                  persisted, no unsupported execution precision, readiness consistent,
 *                  handoff unauthorized, no credential)                          exit 0
 *   FAILED         anything else                                                exit 1
 *
 * No fixture sends a secret-shaped value to the provider: credential-guard behaviour is
 * certified locally with fabricated shapes (tests/pb-exec-01-execution-brief.test.ts).
 * Brief quality beyond the checks is printed for manual review.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ContextConversationRow, ContextMessageRow } from "../../src/lib/db/database-contract";
import { InferenceError, type InferenceRequest, type InferenceResponse } from "../../src/lib/ai/inference/types";
import { estimateCostUsd } from "../../src/lib/ai/usage-accounting";
import { assembleProjectBrainContext, type ProjectBrainRawContext } from "../../src/lib/project-brain/conversation/context-builder";
import { runProjectBrainRequest, type ProjectBrainTurnStore } from "../../src/lib/project-brain/conversation/turn-service";
import { toProjectBrainMessageView } from "../../src/lib/project-brain/conversation/transcript-view";
import { persistedBriefVerifier } from "../../src/lib/project-brain/execution-brief/verify";
import { computeReadiness } from "../../src/lib/project-brain/execution-brief/assemble";
import { scanBriefForCredentials } from "../../src/lib/project-brain/execution-brief/credential-guard";
import { extractExecutionReferences } from "../../src/lib/project-brain/execution-brief/ground";
import { renderExecutionBrief } from "../../src/lib/project-brain/execution-brief/render";
import type { ExecutionBriefTargetRef, ExecutionBriefV1 } from "../../src/lib/project-brain/execution-brief/types";
import { loadEvalEnv } from "../pb-reason-01/eval-real-provider";
import { FIXTURE_NOW, p14ExportProject, PROJECT, scope, steeringReportProject, USER, WS } from "../../tests/fixtures/pb-exec-01-projects";

type Turn = { role: "user" | "assistant"; content: string };
type Case = {
  id: string;
  fixture: () => ProjectBrainRawContext;
  prior: Turn[];
  /** Recommendations of the seeded prior generative answer (targeted explicitly when `target: "recommendation"`). */
  recommendations: string[];
  target: "recommendation" | "current_user_request" | "phrase";
  /** Stable source ids the seeded prior Recommendation cited (default: the P14 milestone). */
  anchors?: string[];
  text: string;
  expect: string;
  /**
   * `hard`: structurally determined (a non-code target can never be handoff-ready) — a
   * mismatch FAILS. Otherwise the expected readiness depends on model judgment (e.g. whether
   * an undecided CSV schema blocks the start) and is reported as a quality observation.
   * Readiness CONSISTENCY with the structured fields (§9.7) is always a hard check.
   */
  readiness?: { value: ExecutionBriefV1["readiness"]; hard: boolean };
  check?: (b: ExecutionBriefV1) => string[];
};

export const CASES: Case[] = [
  {
    id: "EB1-source-grounded-recommendation", fixture: () => p14ExportProject(), prior: [], recommendations: ["Start P14 invoice export next; P12 is complete and P14 is the next planned milestone."],
    target: "recommendation", text: "Prepare an execution brief for the selected recommendation.",
    expect: "Target P14 invoice export; objective from the milestone record; the voided-invoice decision as a project-record constraint/criterion; handoff ready.",
    readiness: { value: "handoff_ready", hard: false },
    check: (b) => (b.objective && b.objective.origin !== "suggested" ? [] : ["objective not grounded in a record or report"]),
  },
  {
    id: "EB2-reported-working-context", fixture: () => p14ExportProject(), prior: [{ role: "user", content: "P13 merged this morning and the branch is clean." }, { role: "assistant", content: "Noted." }],
    recommendations: ["Start P14 invoice export now that P13 is reported merged."], target: "recommendation", text: "Prepare an execution brief for the selected recommendation.",
    expect: "P13 merge in reportedContext, executionSensitive, never known context.",
    check: (b) => [
      ...(b.reportedContext.some((r) => /merged|clean/i.test(r.text)) ? [] : ["the merge report is not in reportedContext"]),
      ...(b.reportedContext.filter((r) => /merged|clean/i.test(r.text)).every((r) => r.executionSensitive) ? [] : ["a merge/clean report is not execution-sensitive"]),
      ...(b.knownContext.some((k) => /P13[^.]*merged/i.test(k.text) && !/not/i.test(k.text)) ? ["the reported merge became known context"] : []),
      ...(renderExecutionBrief(b, "generic").split("\n").some((l) => l.includes("[project record]") && /\b(merged|clean)\b/i.test(l) && !/\bnot\b/i.test(l))
        ? ["the reported merge renders as a project record"]
        : []),
    ],
  },
  {
    id: "EB3-missing-repository", fixture: () => p14ExportProject(), prior: [], recommendations: ["Implement the P14 invoice export."], target: "phrase", text: "prepare it for Claude",
    expect: "Single candidate resolves deterministically; repository not established; no invented repo/branch/SHA.",
    check: (b) => [
      ...(b.targetRef.kind === "project_brain_recommendation" && b.targetRef.resolvedBy === "single_candidate" ? [] : ["not resolved as the single candidate"]),
      ...(b.repositoryContext.status === "not_established" ? [] : ["a repository was established without a report"]),
    ],
  },
  {
    id: "EB4-suggested-technique", fixture: () => p14ExportProject(), prior: [], recommendations: [], target: "current_user_request",
    text: "Prepare an execution brief to add a CSV download button for invoices on the billing page.",
    expect: "current_user_request; suggested techniques labelled suggested; no invented file paths or commands.",
  },
  {
    id: "EB5-objective-needs-confirmation", fixture: () => p14ExportProject(), prior: [], recommendations: [], target: "current_user_request",
    text: "Prepare an execution brief to make the billing area better.",
    expect: "Vague request → the objective should be suggested or blocked by an open input → needs_input.",
    readiness: { value: "needs_input", hard: false },
  },
  {
    id: "EB6-multiple-project-facts", fixture: () => p14ExportProject(), prior: [], recommendations: ["Implement P14 invoice export, honouring the voided-invoice decision and the export specification."],
    target: "recommendation", text: "Prepare an execution brief for the selected recommendation.",
    expect: "Cites the milestone, the decision and the spec; the supplied test command may appear with basis project_record.",
    check: (b) => (b.provenance.sources.length >= 2 ? [] : ["fewer than two project records cited"]),
  },
  {
    id: "EB7-not-code", fixture: steeringReportProject, prior: [], recommendations: ["Prepare the Q4 steering committee report."], target: "recommendation", anchors: ["project_milestones:f00000q4-0000-4000-8000-000000000000"],
    text: "Prepare an execution brief for the selected recommendation.", expect: "capabilityFit not_code (or unclear) → needs_input.", readiness: { value: "needs_input", hard: true },
  },
  {
    id: "EB8-reported-repository", fixture: () => p14ExportProject(),
    prior: [{ role: "user", content: "The code is at https://github.com/republika/billing-core and the base branch is main." }, { role: "assistant", content: "Noted." }],
    recommendations: ["Implement the P14 invoice export."], target: "recommendation", text: "Prepare an execution brief for the selected recommendation.",
    expect: "repositoryContext reported (github, republika/billing-core, main), never verified; handoff still unauthorized.",
    check: (b) => (b.repositoryContext.status === "reported" && b.repositoryContext.repository === "republika/billing-core" ? [] : ["reported repository not captured"]),
  },
];

function memoryStore(): ProjectBrainTurnStore & { rows: ContextMessageRow[]; seed(extra: Partial<ContextMessageRow>): ContextMessageRow } {
  const rows: ContextMessageRow[] = [];
  let seq = 0;
  const conversation = { id: crypto.randomUUID(), workspace_id: WS, context_type: "project", pmo_id: null, project_id: PROJECT, title: "t", status: "active", created_by_user_id: USER, created_at: FIXTURE_NOW.toISOString(), updated_at: FIXTURE_NOW.toISOString() } as ContextConversationRow;
  const insert = (extra: Partial<ContextMessageRow>) => {
    seq += 1;
    const row = { id: crypto.randomUUID(), conversation_id: conversation.id, workspace_id: WS, role: "user", content: "", metadata: null, created_by_user_id: USER, created_at: new Date(FIXTURE_NOW.getTime() - 3_600_000 + seq * 60_000).toISOString(), message_seq: seq, client_message_id: null, reply_to_message_id: null, brain_mode: null, ...extra } as ContextMessageRow;
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

/** Every execution-shaped reference in the brief's narrative must appear in what the request supplied. */
function unsupportedPrecision(b: ExecutionBriefV1, supplied: string): string[] {
  const narrative = [
    b.target?.title, b.target?.statement, b.objective?.text, b.whyNow?.text,
    ...b.knownContext.map((x) => x.text), ...b.reportedContext.map((x) => x.text), ...b.assumptions.map((x) => x.text),
    ...b.scope.inScope, ...b.scope.outOfScope, ...b.areasToInspect.map((x) => x.text), ...b.constraints.map((x) => x.text),
    ...b.acceptanceCriteria.map((x) => x.text), ...b.verificationPlan.flatMap((x) => [x.step, x.command ?? ""]),
  ].filter(Boolean).join("\n");
  const corpus = supplied.toLowerCase().replace(/\s+/g, " ");
  return extractExecutionReferences(narrative)
    .filter((r) => ["path", "sha", "url", "command", "branch", "pr"].includes(r.kind))
    .filter((r) => !corpus.includes(r.token.replace(/\/$/, "")))
    .map((r) => `unsupported ${r.kind} survived`);
}

export async function runCase(c: Case, complete: (request: InferenceRequest) => Promise<InferenceResponse>) {
  const store = memoryStore();
  const raw = c.fixture();
  for (const turn of c.prior) {
    const user = turn.role === "user" ? store.seed({ content: turn.content, client_message_id: crypto.randomUUID() }) : null;
    if (turn.role === "assistant") store.seed({ role: "assistant", content: turn.content, created_by_user_id: null, brain_mode: null });
    void user;
  }
  let targetRef: ExecutionBriefTargetRef | null = null;
  if (c.recommendations.length > 0) {
    const user = store.seed({ content: "What should I work on next?", client_message_id: crypto.randomUUID() });
    // As persisted: the full current references the Recommendation cited.
    const current = assembleProjectBrainContext({ ...raw, history: [] }).sources;
    const anchorSources = (c.anchors ?? ["project_milestones:f0000014-0000-4000-8000-000000000000"]).map((evidenceId) => JSON.parse(JSON.stringify(current.find((s) => s.reference.evidenceId === evidenceId)!.reference)));
    const statements = c.recommendations.map((text, i) => ({ id: `${user.id}:${i}`, scope, epistemicType: "RECOMMENDATION", text, confidence: { kind: "qualitative", level: "medium" }, sources: anchorSources, requiresHumanApproval: true, generatedAt: FIXTURE_NOW.toISOString(), constitutionVersion: "1.1.0" }));
    const reply = store.seed({ role: "assistant", content: c.recommendations.join(" "), created_by_user_id: null, reply_to_message_id: user.id, brain_mode: "generative", metadata: { projectBrain: { version: 1, mode: "generative", statements, sources: [], constitutionVersion: "1.1.0", context: { sourceCount: 0, truncated: false, unavailable: [] } } } });
    if (c.target === "recommendation") targetRef = { kind: "project_brain_recommendation", assistantTurnId: reply.id, statementId: `${user.id}:0` };
  }
  if (c.target === "current_user_request") targetRef = { kind: "current_user_request" };

  const calls: InferenceRequest[] = [];
  let usage: InferenceResponse["usage"] | undefined;
  let model = "";
  let providerError: string | null = null;
  const result = await runProjectBrainRequest(
    {
      scope, userId: USER, generativeEntitled: true, store, now: () => FIXTURE_NOW,
      loadContext: async (history) => assembleProjectBrainContext({ ...raw, history }),
      infer: async (request) => {
        calls.push(request);
        try {
          const response = await complete(request);
          usage = response.usage;
          model = response.model;
          return response;
        } catch (error) {
          providerError = error instanceof InferenceError ? error.errorClass : "error";
          throw error;
        }
      },
    },
    { clientMessageId: crypto.randomUUID(), text: c.text, request: { operation: "execution_brief", targetRef } },
  );
  const reply = result.status === "completed" ? result.reply : null;
  const view = reply ? toProjectBrainMessageView(reply, { verifyExecutionBrief: persistedBriefVerifier(scope) }) : null;
  const brief = view?.brain?.executionBrief ?? null;
  const checks: string[] = [];
  const notes: string[] = [];
  if (result.status !== "completed") checks.push(`status ${result.status}`);
  if (calls.length !== 1) checks.push(`${calls.length} provider calls (expected exactly 1)`);
  if (calls[0] && calls[0].operationName !== "project_brain.execution_brief") checks.push(`operation ${calls[0].operationName}`);
  if (brief) {
    const persisted = JSON.stringify((reply!.metadata as { projectBrain: { executionBrief: unknown } }).projectBrain.executionBrief);
    if (/"[SR]\d+"/.test(persisted)) checks.push("an S*/R* alias persisted");
    if (brief.readiness !== computeReadiness(brief)) checks.push("readiness inconsistent with the structured fields");
    if (c.readiness?.hard && brief.readiness !== c.readiness.value) checks.push(`readiness ${brief.readiness}, expected ${c.readiness.value}`);
    if (c.readiness && !c.readiness.hard && brief.readiness !== c.readiness.value) notes.push(`readiness ${brief.readiness} (expected ${c.readiness.value}; blocking unknowns: ${brief.unknowns.filter((u) => u.blocking).map((u) => u.fact).join(" | ") || "none"})`);
    if (brief.handoff.executionAuthorized !== false || brief.handoff.delegationEligible !== false || brief.handoff.mode !== "manual") checks.push("handoff not manual/unauthorized");
    if (scanBriefForCredentials(brief).length > 0) checks.push("credential-like content in the brief");
    const suppliedText = [
      ...assembleProjectBrainContext({ ...raw, history: [] }).sources.flatMap((s) => [s.label, s.content]),
      ...c.prior.filter((p) => p.role === "user").map((p) => p.content),
      c.text,
    ].join("\n");
    checks.push(...unsupportedPrecision(brief, suppliedText));
    checks.push(...(c.check?.(brief) ?? []));
  }
  return {
    id: c.id,
    expect: c.expect,
    mode: view?.brain?.mode ?? null,
    degradedReason: view?.brain?.reason ?? null,
    providerError,
    model,
    usage: usage ?? null,
    estimatedCostUsd: usage && model ? estimateCostUsd(model, usage.inputTokens, usage.outputTokens) : null,
    readiness: brief?.readiness ?? null,
    checks,
    notes,
    brief,
    rendered: brief ? renderExecutionBrief(brief, "claude_code") : null,
  };
}

async function main(): Promise<number> {
  loadEvalEnv(process.env, existsSync(".env.local") ? readFileSync(".env.local", "utf8") : null);
  if (!process.env.OPENAI_API_KEY) {
    console.log("REAL_PROVIDER_CERTIFICATION = NOT_AVAILABLE (SKIPPED — provider unavailable: no OPENAI_API_KEY configured)");
    return 0;
  }
  const only = process.env.PB_EVAL_ONLY?.split(",").map((s) => s.trim());
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  console.log(`as_of=${FIXTURE_NOW.toISOString()} configured_model=${process.env.DEFAULT_AI_MODEL ?? "(provider default)"} cases=${cases.length}`);
  const { openAIProvider } = await import("../../src/lib/ai/providers/openai-provider");
  const results: Array<Awaited<ReturnType<typeof runCase>>> = [];
  const reasons: string[] = [];
  for (const c of cases) {
    try {
      const r = await runCase(c, (request) => openAIProvider.complete(request));
      results.push(r);
      console.log(`\n━━ ${r.id} [${r.mode}${r.degradedReason ? `:${r.degradedReason}` : ""}, model=${r.model || "none"}, in=${r.usage?.inputTokens ?? "?"} out=${r.usage?.outputTokens ?? "?"}, readiness=${r.readiness}]`);
      console.log(`expect: ${r.expect}`);
      if (r.rendered) console.log(r.rendered);
      if (r.mode !== "generative") reasons.push(`${r.id}: not a generative brief (mode ${r.mode}, reason ${r.degradedReason}${r.providerError ? `, provider ${r.providerError}` : ""})`);
      for (const check of r.checks) reasons.push(`${r.id}: ${check}`);
      console.log(`checks: ${r.checks.length === 0 ? "PASS" : r.checks.join("; ")}`);
      for (const note of r.notes) console.log(`quality note: ${note}`);
    } catch (error) {
      reasons.push(`${c.id}: threw ${error instanceof Error ? error.name : "error"}`);
    }
  }
  const totals = results.reduce((acc, r) => ({ input: acc.input + (r.usage?.inputTokens ?? 0), output: acc.output + (r.usage?.outputTokens ?? 0), cost: r.estimatedCostUsd === null || acc.cost === null ? null : acc.cost + r.estimatedCostUsd }), { input: 0, output: 0, cost: 0 as number | null });
  const models = [...new Set(results.map((r) => r.model).filter(Boolean))];
  console.log(`\nmodels=${models.join(",") || "none"} runs=${results.length} input_tokens=${totals.input} output_tokens=${totals.output} estimated_cost_usd=${totals.cost === null ? "unavailable (no price for the exact model snapshot)" : totals.cost.toFixed(6)}`);
  const status = reasons.length === 0 && results.length === cases.length ? "RUN" : "FAILED";
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ status, reasons, models, totals, results: results.map(({ rendered, ...rest }) => (void rendered, rest)) }, null, 2));
  for (const reason of reasons) console.log(`  ✗ ${reason}`);
  console.log(`REAL_PROVIDER_CERTIFICATION = ${status}`);
  return status === "RUN" ? 0 : 1;
}

if (process.argv[1]?.endsWith("certify-execution-brief.ts")) {
  main().then((code) => process.exit(code));
}
