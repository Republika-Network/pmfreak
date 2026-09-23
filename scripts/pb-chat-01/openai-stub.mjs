// ============================================================================
// PB-CHAT-01 — LOCAL VERIFICATION ONLY: a stand-in for the OpenAI chat
// completions endpoint, installed as a Node preload into a disposable
// `next dev` process:
//
//   NODE_OPTIONS="--import ./scripts/pb-chat-01/openai-stub.mjs" \
//   OPENAI_API_KEY=sk-local-stub-not-a-key PB_CHAT_STUB_LOG=<file> next dev -p 3417
//
// WHY IT EXISTS
//   This environment has no OpenAI key, and a browser proof of PB-CHAT-01 must
//   still exercise everything EXCEPT the model: the route, governance, the
//   project-scoped context builder against a real database, prompt construction,
//   the provider router (usage accounting, concurrency, retries, circuit breaker),
//   strict output parsing, citation validation, persistence and the UI. Only the
//   HTTP call to api.openai.com is replaced; nothing leaves the machine.
//
// WHAT IT DOES
//   Reads the source aliases the server actually put in <project_context> and
//   answers with a structured reply that cites them — plus one INVENTED id, so the
//   end-to-end run also proves the server strips fabricated citations. Every reply
//   starts with "[stub model]" so no artifact can be mistaken for a real LLM answer.
//   A question containing "[simulate-provider-failure]" gets HTTP 503, driving the
//   real degraded path. Each call appends one line to PB_CHAT_STUB_LOG so a test
//   can prove a replay did not call the model again.
//
// It is never imported by application code and is not part of the product.
// ============================================================================

import { appendFileSync } from "node:fs";

const TARGET = "https://api.openai.com/v1/chat/completions";
const realFetch = globalThis.fetch;
const logPath = process.env.PB_CHAT_STUB_LOG;

function decode(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function answer(body) {
  const prompt = body.messages?.[1]?.content ?? "";
  const question = decode(/<current_question>([\s\S]*?)<\/current_question>/.exec(prompt)?.[1] ?? "");
  const sources = [...prompt.matchAll(/<source id="(S\d+)" type="([A-Z_]+)"[^>]*>\n([^\n]*)/g)].map((m) => ({ id: m[1], type: m[2], line: decode(m[3]) }));
  const priorTurns = (prompt.match(/<turn role="user">/g) ?? []).length;

  if (/boogers|weather|recipe/i.test(question)) {
    return {
      reply: "[stub model] That's a general question, not one about this project. In general, mucus colour mostly reflects immune activity; see a clinician if it persists. I haven't used any project records for this.",
      statements: [],
    };
  }

  const project = sources.find((s) => s.type === "PROJECT");
  const risk = sources.find((s) => s.type === "RISK" || s.type === "ISSUE");
  const decision = sources.find((s) => s.type === "DECISION");
  const statements = [];
  if (project) statements.push({ text: project.line.replace(/^[^:]+:\s*/, ""), epistemicType: "FACT", sourceIds: [project.id], confidence: "high", inferenceBasis: null, reportedBy: null, contradictingClaims: [] });
  if (risk) statements.push({ text: `An open item is on record: ${risk.line.split(":")[0].replace(/^[^—]+—\s*/, "")}.`, epistemicType: "FACT", sourceIds: [risk.id, "S999"], confidence: "high", inferenceBasis: null, reportedBy: null, contradictingClaims: [] });
  if (decision) statements.push({ text: "Delivery may depend on how the recorded decision is executed.", epistemicType: "INFERENCE", sourceIds: [decision.id], confidence: "medium", inferenceBasis: "A decision is recorded; its execution is not yet evidenced.", reportedBy: null, contradictingClaims: [] });

  return {
    reply: `[stub model] Based on ${sources.length} project records${priorTurns ? ` and ${priorTurns} earlier message(s) in this conversation` : ""}: ${statements.map((s) => s.text).join(" ") || "I found no project records to answer from."}`,
    statements,
  };
}

globalThis.fetch = async function stubbedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (url !== TARGET) return realFetch(input, init);
  const body = JSON.parse(init?.body ?? "{}");
  const question = /<current_question>([\s\S]*?)<\/current_question>/.exec(body.messages?.[1]?.content ?? "")?.[1] ?? "";
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), question: decode(question).slice(0, 120) })}\n`);
  if (question.includes("[simulate-provider-failure]")) {
    return new Response(JSON.stringify({ error: { message: "stub: service unavailable" } }), { status: 503, headers: { "content-type": "application/json" } });
  }
  const content = JSON.stringify(answer(body));
  return new Response(
    JSON.stringify({ model: "stub-model", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
