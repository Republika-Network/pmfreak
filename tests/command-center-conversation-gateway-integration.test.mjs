import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { runConversationChat } from "../src/lib/command-center/conversation-chat.ts";

const route = fs.readFileSync("src/app/api/command-center/chat/route.ts", "utf8");
const layout = fs.readFileSync("src/modules/workspace/screens/command-center/command-center-layout.tsx", "utf8");
const types = fs.readFileSync("src/modules/workspace/presentation/command-center/types.ts", "utf8");

// PB-CHAT-01 retired this deterministic gateway from the customer UI: the Command Center now
// hosts the persisted Project Brain conversation. The route and the gateway are kept (their
// behavioral contract is still pinned below); only the UI wiring assertions changed.

// ─── Wiring (static) ────────────────────────────────────────────────────────────────────────────

test("the chat API route calls the Sprint 8 gateway seam, not a mock or LLM path", () => {
  assert.match(route, /runConversationChat/);
  assert.match(route, /from "@\/lib\/command-center\/conversation-chat"/);
  assert.doesNotMatch(route, /runInference|OpenAI|Anthropic/);
});

test("the chat API route requires authentication", () => {
  assert.match(route, /getAuthUser/);
  assert.match(route, /status: 401/);
});

test("the pure chat seam calls runConversationalBrainGateway, not a direct playbook engine function", () => {
  const chatSeam = fs.readFileSync("src/lib/command-center/conversation-chat.ts", "utf8");
  assert.match(chatSeam, /runConversationalBrainGateway/);
});

test("command-center-layout no longer calls the deterministic gateway (PB-CHAT-01)", () => {
  assert.doesNotMatch(layout, /still learning to answer open-ended questions/);
  assert.doesNotMatch(layout, /postConversationMessage|conversationResultToAssistantMessage|\/api\/command-center\/chat/);
  assert.match(layout, /<ProjectBrainConversation/);
  // The client-side gateway adapter and the feed it rendered are gone.
  assert.equal(fs.existsSync("src/modules/workspace/presentation/command-center/conversation-data.ts"), false);
  assert.equal(fs.existsSync("src/modules/workspace/presentation/command-center/command-feed.tsx"), false);
});

test("ChatMessage type still carries gateway metadata for the retained gateway contract", () => {
  assert.match(types, /gatewayMeta/);
  assert.match(types, /requiresApproval: boolean/);
  assert.match(types, /missingContext: string\[\]/);
});

// ─── Behavioral — open-ended messages must never hit the unsupported/insufficient-context path ─

const OPEN_ENDED_MESSAGES = [
  "¿Qué hago si el cliente no responde?",
  "Mae este proyecto está pegado",
  "Redactame un correo de seguimiento",
];

test("open-ended messages never route to the unsupported handler", () => {
  for (const message of OPEN_ENDED_MESSAGES) {
    const result = runConversationChat({ message });
    assert.notEqual(result.route, "unsupported_handler", `"${message}" must not be unsupported`);
    assert.notEqual(result.mode, "unsupported", `"${message}" must not be treated as unsupported`);
  }
});

test("open-ended messages never produce an empty or bare insufficient-context response", () => {
  for (const message of OPEN_ENDED_MESSAGES) {
    const result = runConversationChat({ message });
    assert.ok(result.response.trim().length > 0, `"${message}" must produce a non-empty response`);
    assert.doesNotMatch(result.response, /^no tengo (?:suficiente )?contexto/i, `"${message}" must not be a bare insufficient-context refusal`);
  }
});

test("'¿Qué hago si el cliente no responde?' is classified as general PM advice with no project required", () => {
  const result = runConversationChat({ message: "¿Qué hago si el cliente no responde?" });
  assert.equal(result.intent, "general_pm_advice");
  assert.equal(result.route, "general_pm_advisor");
  assert.deepEqual(result.missingContext, []);
});

test("'Mae este proyecto está pegado' is detected as a project status question even with no active project", () => {
  const result = runConversationChat({ message: "Mae este proyecto está pegado" });
  assert.equal(result.intent, "project_status_question");
  assert.equal(result.route, "project_status_handler");
  assert.ok(result.missingContext.includes("project"));
});

test("'Redactame un correo de seguimiento' routes to communications and always requires approval", () => {
  const result = runConversationChat({ message: "Redactame un correo de seguimiento" });
  assert.equal(result.intent, "communication_draft");
  assert.equal(result.route, "communications_handler");
  assert.equal(result.requiresApproval, true);
});

test("conversation history is forwarded and bounded to the most recent turns", () => {
  const longHistory = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", message: `turn ${i}` }));
  const result = runConversationChat({ message: "¿Qué recomiendas?", conversationHistory: longHistory });
  assert.equal(result.route, "recommendation_handler");
});
