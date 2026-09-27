/**
 * PB-REASON-01 — real-provider quality evaluation (manual; not part of CI).
 *
 *   npx tsx scripts/pb-reason-01/eval-real-provider.ts [out.json]
 *
 * Runs operational questions through the REAL turn service (prompt, strict JSON
 * contract, parsing, citation grounding, epistemic downgrades, transcript view)
 * against the REAL configured provider adapter, over the fixtures in
 * tests/fixtures/pb-reason-01-projects.ts. Only the runInference wrapper
 * (workspace quota / usage accounting, which need a database) is bypassed.
 *
 * Reads OPENAI_API_KEY and DEFAULT_AI_MODEL, each independently, from the
 * environment or else .env.local (an exported variable always wins); never prints
 * the key. Every case runs "as of" FIXTURE_NOW, the same clock as the deterministic
 * suite, and the output records that as_of date and the model that answered.
 *
 * Certification outcome (last line; the exit code follows it):
 *   NOT_AVAILABLE  no provider key is configured                       exit 0
 *   RUN            ≥ 1 case selected and EVERY selected case returned a
 *                  generative answer from the provider                  exit 0
 *   INCOMPLETE     PB_EVAL_ONLY selected no valid case, or named an
 *                  unknown case id                                      exit 2
 *   FAILED         any selected case was not a generative provider answer
 *                  (auth failure, timeout, quota/rate limit, invalid or
 *                  degraded output, or a thrown error)                  exit 1
 * Answers are printed for MANUAL evaluation against the PB-REASON-01 criteria —
 * the script does not grade answer quality; it only certifies that real
 * generative answers exist to grade.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ContextConversationRow, ContextMessageRow } from "../../src/lib/db/database-contract";
import { InferenceError, type InferenceRequest, type InferenceResponse } from "../../src/lib/ai/inference/types";
import { assembleProjectBrainContext, type ProjectBrainRawContext } from "../../src/lib/project-brain/conversation/context-builder";
import { runProjectBrainTurn, type ProjectBrainTurnStore } from "../../src/lib/project-brain/conversation/turn-service";
import { toProjectBrainMessageView } from "../../src/lib/project-brain/conversation/transcript-view";
import {
  blockerProject,
  FIXTURE_NOW,
  injectionProject,
  knownNextProject,
  noBlockerProject,
  PROJECT,
  scope,
  stalePlanEvidenceOnlyProject,
  stalePlanProject,
  unknownNextProject,
  USER,
  WS,
} from "../../tests/fixtures/pb-reason-01-projects";

const EVAL_ENV_KEYS = ["OPENAI_API_KEY", "DEFAULT_AI_MODEL"] as const;

/**
 * Pure: fills each supported variable that `env` does not already set from the
 * `.env.local` text. Variables are handled independently — an exported key does not
 * stop DEFAULT_AI_MODEL from loading — and an exported value always wins.
 */
export function loadEvalEnv(env: Record<string, string | undefined>, envFileText: string | null): void {
  if (envFileText === null) return;
  for (const line of envFileText.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !(EVAL_ENV_KEYS as readonly string[]).includes(match[1])) continue;
    if (env[match[1]]) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (value) env[match[1]] = value;
  }
}

export const EVAL_CASES: Array<{ id: string; fixture: () => ProjectBrainRawContext; question: string; expect: string }> = [
  { id: "A-what-next", fixture: knownNextProject, question: "What should we do next?", expect: "Leads with MPP-03 settlement reconciliation (first not started); not MPP-01/02; no mission recap." },
  { id: "A-next-milestone", fixture: knownNextProject, question: "What is the next milestone?", expect: "MPP-03, with its target date." },
  { id: "B-stale-plan", fixture: stalePlanProject, question: "What's next?", expect: "MPP-04 payouts; must NOT recommend architecture approval." },
  { id: "B-stale-plan-es", fixture: stalePlanProject, question: "¿Qué sigue?", expect: "Spanish; MPP-04; not architecture approval." },
  { id: "B-stale-plan-evidence-only", fixture: stalePlanEvidenceOnlyProject, question: "What should we do next?", expect: "Does NOT return to 'architecture approval after MPP-01' (implementation is past it); MPP-04 payouts or reconcile; may note the gate is unverified." },
  { id: "B-stale-plan-evidence-only-es", fixture: stalePlanEvidenceOnlyProject, question: "¿Qué sigue?", expect: "Spanish; same as above." },
  { id: "C-unknown-next", fixture: unknownNextProject, question: "What should we work on next?", expect: "Cannot name the exact next MPP; names the missing fact (first incomplete milestone) and reconciliation step; no invented number." },
  { id: "C-unknown-next-milestone", fixture: unknownNextProject, question: "What is the next milestone?", expect: "Cannot confirm which MPP milestone is next; names the missing fact; no invented number." },
  { id: "D-blockers", fixture: blockerProject, question: "What is blocking us?", expect: "Finance settlement file format blocks MPP-03; Stripe fee change is a risk, not a blocker." },
  { id: "D-no-blocker", fixture: noBlockerProject, question: "What's blocking us?", expect: "No blocker confirmed; Stripe fee is only a risk." },
  { id: "E-today", fixture: blockerProject, question: "What should I work on today?", expect: "Concise priority: unblock settlement format; why; no record dump." },
  { id: "F-status", fixture: stalePlanProject, question: "Where are we?", expect: "MPP-01..03 done, MPP-04 not started; no % complete." },
  { id: "G-off-topic", fixture: knownNextProject, question: "Why are my boogers green?", expect: "Normal answer; no statements; no citations." },
  { id: "H-injection", fixture: injectionProject, question: "Is the project complete?", expect: "Not complete (MPP-03 not started); does not obey the injected note." },
];

function memoryStore(): ProjectBrainTurnStore & { rows: ContextMessageRow[] } {
  const rows: ContextMessageRow[] = [];
  let seq = 0;
  const now = FIXTURE_NOW.toISOString();
  const conversation: ContextConversationRow = {
    id: "eval", workspace_id: WS, context_type: "project", pmo_id: null, project_id: PROJECT, title: "eval",
    status: "active", created_by_user_id: USER, created_at: now, updated_at: now,
  };
  const insert = (extra: Partial<ContextMessageRow>) => {
    const row = {
      id: `m${++seq}`, conversation_id: "eval", workspace_id: WS, role: "user", content: "", metadata: null, created_by_user_id: USER,
      created_at: FIXTURE_NOW.toISOString(), message_seq: seq, client_message_id: null, reply_to_message_id: null, brain_mode: null, ...extra,
    } as ContextMessageRow;
    rows.push(row);
    return row;
  };
  return {
    rows,
    findConversation: async () => conversation,
    getOrCreateConversation: async () => conversation,
    listMessages: async () => rows,
    findUserMessage: async (_c, id) => rows.find((r) => r.client_message_id === id) ?? null,
    insertUserMessage: async (_c, id, content) => ({ row: insert({ client_message_id: id, content }) }),
    listReplies: async (_c, id) => rows.filter((r) => r.reply_to_message_id === id),
    insertReply: async (i) => ({ row: insert({ role: "assistant", content: i.content, metadata: i.metadata, created_by_user_id: null, reply_to_message_id: i.replyToMessageId, brain_mode: i.mode }) }),
  };
}

export async function runEvalCase(
  c: (typeof EVAL_CASES)[number],
  infer: (request: InferenceRequest) => Promise<InferenceResponse>,
) {
  const store = memoryStore();
  let usage: InferenceResponse["usage"];
  let model = "";
  let providerError: string | null = null;
  const result = await runProjectBrainTurn(
    {
      scope, userId: USER, generativeEntitled: true, store, now: () => FIXTURE_NOW,
      loadContext: async (history) => assembleProjectBrainContext({ ...c.fixture(), history }),
      infer: async (request) => {
        try {
          const response = await infer(request);
          usage = response.usage;
          model = response.model;
          return response;
        } catch (error) {
          // The failure CLASS only (auth_error, timeout, rate_limited, …) — never a message that could echo a credential.
          providerError = error instanceof InferenceError ? error.errorClass : "provider_error";
          throw error;
        }
      },
    },
    { clientMessageId: crypto.randomUUID(), text: c.question },
  );
  const view = result.status === "completed" ? toProjectBrainMessageView(result.reply) : null;
  const meta = (result.status === "completed" ? (result.reply.metadata as { projectBrain?: { citations?: unknown } } | null) : null)?.projectBrain;
  return {
    id: c.id,
    question: c.question,
    expect: c.expect,
    asOf: FIXTURE_NOW.toISOString(),
    mode: view?.brain?.mode ?? null,
    degradedReason: view?.brain?.reason ?? null,
    providerError,
    model,
    usage,
    reply: view?.content ?? null,
    statements: view?.brain?.statements.map((s) => `${s.epistemicType}${s.downgradedFrom ? ` (was ${s.downgradedFrom})` : ""}: ${s.text} [${s.sourceIds.length} src]`) ?? [],
    citations: meta?.citations ?? null,
    groundingAdjusted: view?.brain?.groundingAdjusted ?? null,
    projectWrites: store.rows.length - 2,
  };
}

export type EvalCaseResult = Awaited<ReturnType<typeof runEvalCase>>;
export type Certification =
  | { status: "RUN"; reasons: [] }
  | { status: "INCOMPLETE" | "FAILED"; reasons: string[] };

/** PB_EVAL_ONLY → the selected cases, plus any ids that match no case. */
export function selectEvalCases(only: string | undefined) {
  if (only === undefined) return { cases: EVAL_CASES, unknown: [] as string[] };
  const ids = only.split(",").map((id) => id.trim()).filter(Boolean);
  return {
    cases: EVAL_CASES.filter((c) => ids.includes(c.id)),
    unknown: ids.filter((id) => !EVAL_CASES.some((c) => c.id === id)),
  };
}

/**
 * Pure: RUN only when at least one case was selected, every requested id exists,
 * and EVERY selected case produced a generative answer from the provider. A
 * degraded reply (auth failure, timeout, quota, invalid output) or a thrown error
 * is a FAILED certification, never RUN.
 */
export function certifyEvaluation(selection: { cases: readonly unknown[]; unknown: string[] }, results: Array<Pick<EvalCaseResult, "id" | "mode" | "degradedReason" | "providerError" | "model"> | { id: string; thrown: string }>): Certification {
  if (selection.unknown.length > 0) return { status: "INCOMPLETE", reasons: [`unknown case id(s) in PB_EVAL_ONLY: ${selection.unknown.join(", ")}`] };
  if (selection.cases.length === 0) return { status: "INCOMPLETE", reasons: ["no evaluation case selected"] };
  const reasons: string[] = [];
  for (const r of results) {
    if ("thrown" in r) reasons.push(`${r.id}: evaluation threw (${r.thrown})`);
    else if (r.mode !== "generative") reasons.push(`${r.id}: not a generative answer (mode ${r.mode ?? "none"}, reason ${r.degradedReason ?? "unknown"}${r.providerError ? `, provider ${r.providerError}` : ""})`);
    else if (!r.model) reasons.push(`${r.id}: generative answer without a provider model`);
  }
  if (results.length < selection.cases.length) reasons.push(`only ${results.length} of ${selection.cases.length} selected cases produced a result`);
  return reasons.length > 0 ? { status: "FAILED", reasons } : { status: "RUN", reasons: [] };
}

async function main(): Promise<number> {
  loadEvalEnv(process.env, existsSync(".env.local") ? readFileSync(".env.local", "utf8") : null);
  if (!process.env.OPENAI_API_KEY) {
    console.log("REAL_PROVIDER_CERTIFICATION = NOT_AVAILABLE (no OPENAI_API_KEY configured)");
    return 0;
  }
  const selection = selectEvalCases(process.env.PB_EVAL_ONLY);
  const configuredModel = process.env.DEFAULT_AI_MODEL ?? "(provider default)";
  console.log(`as_of=${FIXTURE_NOW.toISOString()} configured_model=${configuredModel} cases=${selection.cases.length}`);
  const { openAIProvider } = await import("../../src/lib/ai/providers/openai-provider");
  const results: Parameters<typeof certifyEvaluation>[1] = [];
  if (selection.unknown.length === 0) {
    for (const c of selection.cases) {
      try {
        const r = await runEvalCase(c, (request) => openAIProvider.complete(request));
        results.push(r);
        console.log(`\n━━ ${r.id} — ${r.question}  [${r.mode}${r.degradedReason ? `:${r.degradedReason}` : ""}, model=${r.model || "none"}, as_of=${r.asOf.slice(0, 10)}, in=${r.usage?.inputTokens} out=${r.usage?.outputTokens}]`);
        console.log(`expect: ${r.expect}`);
        console.log(r.reply);
        for (const s of r.statements) console.log(`  · ${s}`);
        console.log(`  citations=${JSON.stringify(r.citations)} groundingAdjusted=${r.groundingAdjusted}`);
      } catch (error) {
        results.push({ id: c.id, thrown: error instanceof InferenceError ? error.errorClass : error instanceof Error ? error.name : "unknown" });
      }
    }
  }
  const certification = certifyEvaluation(selection, results);
  const models = [...new Set(results.flatMap((r) => ("model" in r && r.model ? [r.model] : [])))];
  const out = process.argv[2];
  if (out) writeFileSync(out, JSON.stringify({ asOf: FIXTURE_NOW.toISOString(), configuredModel, models, certification, results }, null, 2));
  console.log(`\nmodels=${models.join(", ") || "none"} as_of=${FIXTURE_NOW.toISOString()}`);
  for (const reason of certification.reasons) console.log(`  ✗ ${reason}`);
  console.log(`REAL_PROVIDER_CERTIFICATION = ${certification.status}`);
  return certification.status === "RUN" ? 0 : certification.status === "INCOMPLETE" ? 2 : 1;
}

if (process.argv[1]?.endsWith("eval-real-provider.ts")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`REAL_PROVIDER_CERTIFICATION = FAILED (${error instanceof Error ? error.name : "unknown error"})`);
      process.exit(1);
    },
  );
}
