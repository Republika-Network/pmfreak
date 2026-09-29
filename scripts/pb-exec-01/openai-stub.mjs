// ============================================================================
// PB-EXEC-01 — LOCAL VERIFICATION ONLY: extends the PB-CHAT-01 OpenAI stub.
//
//   NODE_OPTIONS="--import ./scripts/pb-exec-01/openai-stub.mjs" \
//   OPENAI_API_KEY=sk-local-stub-not-a-key PB_CHAT_STUB_LOG=<file> next dev -p 3417
//
// Loads scripts/pb-chat-01/openai-stub.mjs (every PB-CHAT/PB-REASON behaviour is
// unchanged) and adds, in front of it:
//   * an answer to a question containing "[recommend]" (or "[recommend-one]") with
//     RECOMMENDATION statements, so the browser can press "Prepare execution brief";
//   * an answer to the `project_brain_execution_brief` schema: a structured brief that
//     cites the aliases the server actually supplied, plus ONE invented file path in
//     "out of scope", so the run also proves the server removes unsupported precision.
// Every reply is marked "[stub model]"; each call appends one line to PB_CHAT_STUB_LOG.
// Only the HTTP call to api.openai.com is replaced. Never imported by application code.
// ============================================================================

import { appendFileSync } from "node:fs";
import "../pb-chat-01/openai-stub.mjs";

const TARGET = "https://api.openai.com/v1/chat/completions";
const chatStubFetch = globalThis.fetch;
const logPath = process.env.PB_CHAT_STUB_LOG;

const decode = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function ok(content) {
  return new Response(
    JSON.stringify({ model: "stub-model", choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function brief(prompt) {
  const sources = [...prompt.matchAll(/<source id="(S\d+)" type="([A-Z_]+)"[^>]*>\n([^\n]*)/g)].map((m) => ({ id: m[1], type: m[2], line: decode(m[3]) }));
  const pick = (...types) => types.map((t) => sources.find((s) => s.type === t)).find(Boolean);
  const main = pick("MILESTONE", "TASK", "PROJECT");
  const rule = pick("DECISION", "RISK", "ISSUE");
  const current = /<current_question[^>]* report_id="(R\d+)"/.exec(prompt)?.[1];
  const reports = [...prompt.matchAll(/<turn role="user"[^>]* report_id="(R\d+)"[^>]*>([\s\S]*?)<\/turn>/g)].map((m) => ({ id: m[1], text: decode(m[2]) }));
  const progress = [...reports].reverse().find((r) => /\b(merged|clean|deployed|finished)\b/i.test(r.text));
  const title = main ? main.line.split(":")[0].replace(/^[^—]+—\s*/, "") : "the selected work";
  // A prior-Recommendation target is server-owned: echo it exactly, as the schema requires.
  const selected = /<selected_target title="([^"]*)" statement="([^"]*)">/.exec(prompt);
  return {
    capabilityFit: "fits",
    target: selected
      ? { title: decode(selected[1]), statement: decode(selected[2]), sourceAliases: [], reportAliases: [] }
      : { title: `[stub model] ${title}`.slice(0, 120), statement: `Deliver ${title} as recorded in the project.`.slice(0, 400), sourceAliases: main ? [main.id] : [], reportAliases: [] },
    objective: { text: `The work recorded as ${title} is complete and verified.`.slice(0, 600), origin: main ? "project_record" : "suggested", sourceAliases: main ? [main.id] : [], reportAliases: [] },
    whyNow: { text: "It is the open item the latest answer recommended.", sourceAliases: main ? [main.id] : [], reportAliases: [] },
    knownContext: main ? [{ text: `On record: ${main.line.replace(/^[^:]+:\s*/, "")}`.slice(0, 280), sourceAliases: [main.id] }] : [],
    reportedContext: progress ? [{ text: `Reported: ${progress.text}`.slice(0, 280), reportAliases: [progress.id], executionSensitive: true }] : [],
    assumptions: [{ text: "The work can be done without changing unrelated features." }],
    unknowns: [{ fact: "Which tests cover this area", why: "The records do not say.", resolveBy: "user", blocking: false }],
    scope: { inScope: [`Changes needed for ${title}`.slice(0, 280)], outOfScope: ["Unrelated refactors", "Do not modify src/stub-invented/"] },
    areasToInspect: [],
    constraints: rule ? [{ text: `Respect the recorded item: ${rule.line.split(":")[0]}`.slice(0, 280), origin: "project_record", sourceAliases: [rule.id], reportAliases: [] }] : [],
    acceptanceCriteria: [
      { text: "The recorded work is demonstrably complete.", origin: main ? "project_record" : "suggested", sourceAliases: main ? [main.id] : [], reportAliases: [] },
      { text: "Existing behaviour elsewhere is unchanged.", origin: "suggested", sourceAliases: [], reportAliases: current ? [] : [] },
    ],
    verificationPlan: [{ step: "Run the project's full automated test suite", kind: "test", command: "npm test", sourceAliases: [], reportAliases: [] }],
  };
}

globalThis.fetch = async function pbExecStubbedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (url !== TARGET) return chatStubFetch(input, init);
  const body = JSON.parse(init?.body ?? "{}");
  const prompt = body.messages?.[1]?.content ?? "";
  const schema = body.response_format?.json_schema?.name;
  const question = decode(/<current_question[^>]*>([\s\S]*?)<\/current_question>/.exec(prompt)?.[1] ?? "");
  if (schema === "project_brain_execution_brief") {
    if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), op: "execution_brief", question: question.slice(0, 120) })}\n`);
    return ok(brief(prompt));
  }
  if (/\[recommend(-one)?\]/.test(question)) {
    if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), op: "answer", question: question.slice(0, 120) })}\n`);
    const recs = /\[recommend-one\]/.test(question)
      ? ["Implement the next recorded milestone."]
      : ["Implement the next recorded milestone.", "Close the open review item first."];
    return ok({
      reply: `[stub model] Based on the current project state, I recommend: ${recs.join(" Or: ")}`,
      statements: recs.map((text) => ({ text, epistemicType: "RECOMMENDATION", sourceIds: [], reportIds: [], confidence: "medium", inferenceBasis: null, reportedBy: null, contradictingClaims: [] })),
    });
  }
  return chatStubFetch(input, init);
};
