/**
 * PB-REASON-02 — real-provider certification of reported working context (manual; not CI).
 *
 *   npx tsx scripts/pb-reason-02/certify-reported-context.ts [out.json]
 *
 * Same infrastructure and outcome contract as scripts/pb-reason-01/eval-real-provider.ts
 * (env loading, RUN / FAILED / INCOMPLETE / NOT_AVAILABLE certification, FIXTURE_NOW
 * clock, key never printed) — reused, not duplicated. What is new is that a case can
 * seed PRIOR conversation turns (user reports, corrections, an assistant
 * hallucination) before the question, so the real turn service builds the real
 * report map from real transcript rows.
 *
 * Each case also carries deterministic STRUCTURAL checks on the grounded output
 * (e.g. the hallucinated P17 never becomes REPORTED/FACT, the canonical failure is
 * never contradicted by a FACT). A failed check makes the certification FAILED.
 * Answer quality beyond those checks is printed for manual review.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ContextConversationRow, ContextMessageRow } from "../../src/lib/db/database-contract";
import { InferenceError, type InferenceRequest, type InferenceResponse } from "../../src/lib/ai/inference/types";
import { assembleProjectBrainContext, type ProjectBrainRawContext } from "../../src/lib/project-brain/conversation/context-builder";
import { runProjectBrainTurn, type ProjectBrainTurnStore } from "../../src/lib/project-brain/conversation/turn-service";
import { toProjectBrainMessageView } from "../../src/lib/project-brain/conversation/transcript-view";
import type { ProjectBrainStatement } from "../../src/lib/project-brain/types";
import { certifyEvaluation, loadEvalEnv } from "../pb-reason-01/eval-real-provider";
import {
  deploymentFailedProject,
  FIXTURE_NOW,
  noMilestoneRecordsProject,
  p13CompletedProject,
  p13PendingProject,
  PROJECT,
  scope,
  USER,
  WS,
} from "../../tests/fixtures/pb-reason-02-projects";

type Turn = { role: "user" | "assistant"; content: string };
type Statement = ProjectBrainStatement & { downgradedFrom?: string };
type Case = { id: string; fixture: () => ProjectBrainRawContext; prior: Turn[]; question: string; expect: string; check?: (s: Statement[], reply: string) => string[] };

/** Affirmative FACTs matching `pattern` ("No record confirms P13 merged" is a correct FACT, not a violation). */
const factsMatching = (s: Statement[], pattern: RegExp) =>
  s.filter((x) => x.epistemicType === "FACT" && pattern.test(x.text) && !/\b(no|not|without|yet to|sin|ningún|no hay)\b/i.test(x.text));
const acknowledgesReport = (reply: string) => /\b(you (reported|said|say|mentioned|told)|your (report|update)|reportaste|mencionaste|según tu)\b/i.test(reply);

export const CASES: Case[] = [
  {
    id: "RP1-current-turn", fixture: p13PendingProject, prior: [], question: "P13 merged this morning. What next?",
    expect: "Acknowledges the report; does NOT call the merge verified; provisionally names P14; notes the record still shows P13 in progress.",
    check: (s) => factsMatching(s, /merged/i).length ? ["a FACT claims the merge"] : [],
  },
  {
    id: "RP1-prior-turn", fixture: p13PendingProject, prior: [{ role: "user", content: "P13 merged this morning." }, { role: "assistant", content: "Noted." }], question: "What next?",
    expect: "Uses the earlier report ('based on your update'); P14 provisional; merge not verified.",
    check: (s) => factsMatching(s, /merged/i).length ? ["a FACT claims the merge"] : [],
  },
  {
    id: "RP2-correction", fixture: p13PendingProject,
    prior: [{ role: "user", content: "P13 merged." }, { role: "assistant", content: "Noted." }, { role: "user", content: "Actually, correction: P13 has NOT merged. The PR is still open." }, { role: "assistant", content: "Understood." }],
    question: "What should I do?",
    expect: "Latest correction wins: finishing P13 is the working next target; does not proceed to P14 as if merged.",
  },
  {
    id: "RP3-assistant-hallucination", fixture: p13PendingProject, prior: [{ role: "user", content: "Status?" }, { role: "assistant", content: "P17 is finished." }], question: "What next?",
    expect: "Does not treat P17 as finished; works from the records (P13 in progress).",
    check: (s) => s.filter((x) => /P17/.test(x.text) && (x.epistemicType === "FACT" || x.epistemicType === "REPORTED") && !/not|no /i.test(x.text)).map(() => "P17 finished used as FACT/REPORTED"),
  },
  {
    id: "RP4-canonical-caught-up", fixture: p13CompletedProject, prior: [{ role: "user", content: "P13 merged." }, { role: "assistant", content: "Noted." }], question: "Where are we?",
    expect: "States P13 completed from the record (FACT) without provisional 'you reported' framing.",
  },
  {
    id: "RP5-spanish", fixture: p13PendingProject, prior: [], question: "Acabo de mergear P13. P14 es lo que sigue. ¿Qué debería hacer ahora?",
    expect: "Natural Spanish; reported framing; P14 as provisional next target; P13 not verified.",
    check: (s) => factsMatching(s, /merge/i).length ? ["a FACT claims the merge"] : [],
  },
  {
    id: "RP6-strong-canonical-conflict", fixture: deploymentFailedProject, prior: [], question: "Deployment is successful. Are we good to go live?",
    expect: "Exposes both: user reports success, record shows failure; does not treat deployment as verified.",
    check: (s, reply) => [
      ...(factsMatching(s, /deploy.*(success|succeeded)/i).length ? ["a FACT claims deployment success"] : []),
      ...(acknowledgesReport(reply) ? [] : ["the reply drops the user's report instead of stating both sides"]),
    ],
  },
  {
    id: "RP7-off-topic-history", fixture: p13PendingProject, prior: [{ role: "user", content: "My son likes monster trucks." }, { role: "assistant", content: "Nice." }], question: "What's blocking this project?",
    expect: "No mention of monster trucks; project answer from records.",
    check: (s, reply) => (/truck/i.test(reply) || s.some((x) => /truck/i.test(x.text)) ? ["off-topic remark shaped the answer"] : []),
  },
  {
    id: "RP8-records-silent", fixture: noMilestoneRecordsProject, prior: [{ role: "user", content: "P13 authenticity is merged. P14 is the next milestone." }, { role: "assistant", content: "Noted." }], question: "What should I work on now?",
    expect: "Based on the update, P14 is the working next target; no canonical record confirms it.",
    check: (s) => factsMatching(s, /P1[34].*(merged|complete|next)/i).length ? ["a FACT claims a reported milestone state"] : [],
  },
];

function memoryStore(prior: Turn[]): ProjectBrainTurnStore & { rows: ContextMessageRow[] } {
  const rows: ContextMessageRow[] = [];
  let seq = 0;
  const at = (n: number) => new Date(FIXTURE_NOW.getTime() - 3_600_000 + n * 60_000).toISOString();
  const conversation: ContextConversationRow = {
    id: "eval", workspace_id: WS, context_type: "project", pmo_id: null, project_id: PROJECT, title: "eval",
    status: "active", created_by_user_id: USER, created_at: at(0), updated_at: at(0),
  };
  const insert = (extra: Partial<ContextMessageRow>) => {
    seq += 1;
    const row = {
      id: `m${seq}`, conversation_id: "eval", workspace_id: WS, role: "user", content: "", metadata: null, created_by_user_id: USER,
      created_at: at(seq), message_seq: seq, client_message_id: null, reply_to_message_id: null, brain_mode: null, ...extra,
    } as ContextMessageRow;
    rows.push(row);
    return row;
  };
  let lastUser: ContextMessageRow | null = null;
  for (const turn of prior) {
    if (turn.role === "user") lastUser = insert({ content: turn.content });
    else insert({ role: "assistant", content: turn.content, created_by_user_id: null, reply_to_message_id: lastUser?.id ?? null, brain_mode: "generative" });
  }
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

export async function runCase(c: Case, infer: (request: InferenceRequest) => Promise<InferenceResponse>) {
  const store = memoryStore(c.prior);
  const seeded = store.rows.length;
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
          providerError = error instanceof InferenceError ? error.errorClass : "provider_error";
          throw error;
        }
      },
    },
    { clientMessageId: crypto.randomUUID(), text: c.question },
  );
  const view = result.status === "completed" ? toProjectBrainMessageView(result.reply) : null;
  const meta = (result.status === "completed" ? (result.reply.metadata as { projectBrain?: { statements?: Statement[]; citations?: unknown } } | null) : null)?.projectBrain;
  const statements = meta?.statements ?? [];
  const violations = view?.brain?.mode === "generative" && c.check ? c.check(statements, view.content) : [];
  return {
    id: c.id, question: c.question, expect: c.expect, asOf: FIXTURE_NOW.toISOString(),
    mode: view?.brain?.mode ?? null, degradedReason: view?.brain?.reason ?? null, providerError, model, usage,
    reply: view?.content ?? null,
    statements: statements.map((s) => `${s.epistemicType}${s.downgradedFrom ? ` (was ${s.downgradedFrom})` : ""}: ${s.text} [${s.sources.length} src, ${s.reports?.length ?? 0} rep]`),
    citations: meta?.citations ?? null,
    violations,
    projectWrites: store.rows.length - seeded - 2,
  };
}

async function main(): Promise<number> {
  loadEvalEnv(process.env, existsSync(".env.local") ? readFileSync(".env.local", "utf8") : null);
  if (!process.env.OPENAI_API_KEY) {
    console.log("REAL_PROVIDER_CERTIFICATION = NOT_AVAILABLE (no OPENAI_API_KEY configured)");
    return 0;
  }
  const only = process.env.PB_EVAL_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const selection = {
    cases: only ? CASES.filter((c) => only.includes(c.id)) : CASES,
    unknown: only ? only.filter((id) => !CASES.some((c) => c.id === id)) : [],
  };
  const configuredModel = process.env.DEFAULT_AI_MODEL ?? "(provider default)";
  console.log(`as_of=${FIXTURE_NOW.toISOString()} configured_model=${configuredModel} cases=${selection.cases.length}`);
  const { openAIProvider } = await import("../../src/lib/ai/providers/openai-provider");
  const results: Array<Awaited<ReturnType<typeof runCase>> | { id: string; thrown: string }> = [];
  if (selection.unknown.length === 0) {
    for (const c of selection.cases) {
      try {
        const r = await runCase(c, (request) => openAIProvider.complete(request));
        results.push(r);
        console.log(`\n━━ ${r.id} — ${r.question}  [${r.mode}${r.degradedReason ? `:${r.degradedReason}` : ""}, model=${r.model || "none"}, in=${r.usage?.inputTokens} out=${r.usage?.outputTokens}]`);
        console.log(`expect: ${r.expect}`);
        console.log(r.reply);
        for (const s of r.statements) console.log(`  · ${s}`);
        console.log(`  citations=${JSON.stringify(r.citations)} projectWrites=${r.projectWrites}${r.violations.length ? `  ✗ ${r.violations.join("; ")}` : ""}`);
      } catch (error) {
        results.push({ id: c.id, thrown: error instanceof InferenceError ? error.errorClass : error instanceof Error ? error.name : "unknown" });
      }
    }
  }
  const base = certifyEvaluation(selection, results);
  const structural = results.flatMap((r) => ("violations" in r ? [...r.violations.map((v) => `${r.id}: ${v}`), ...(r.projectWrites !== 0 ? [`${r.id}: unexpected writes`] : [])] : []));
  const status = base.status === "RUN" && structural.length > 0 ? "FAILED" : base.status;
  const reasons = [...base.reasons, ...structural];
  const models = [...new Set(results.flatMap((r) => ("model" in r && r.model ? [r.model] : [])))];
  const out = process.argv[2];
  if (out) writeFileSync(out, JSON.stringify({ asOf: FIXTURE_NOW.toISOString(), configuredModel, models, status, reasons, results }, null, 2));
  console.log(`\nmodels=${models.join(", ") || "none"} as_of=${FIXTURE_NOW.toISOString()} cases=${results.length}`);
  for (const reason of reasons) console.log(`  ✗ ${reason}`);
  console.log(`REAL_PROVIDER_CERTIFICATION = ${status}`);
  return status === "RUN" ? 0 : status === "INCOMPLETE" ? 2 : 1;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("pb-reason-02/certify-reported-context.ts")) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`REAL_PROVIDER_CERTIFICATION = FAILED (${error instanceof Error ? error.name : "unknown error"})`);
      process.exit(1);
    },
  );
}
