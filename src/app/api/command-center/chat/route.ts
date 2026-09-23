import { getAuthUser } from "@/lib/auth";
import { denyResponse } from "@/lib/security/deny-response";
import { runConversationChat } from "@/lib/command-center/conversation-chat";
import type { ConversationTurn } from "@/lib/playbook-engine";

const ROUTE_ID = "/api/command-center/chat";

function isConversationTurn(value: unknown): value is ConversationTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Record<string, unknown>;
  return (turn.role === "user" || turn.role === "assistant") && typeof turn.message === "string";
}

/**
 * Internal, deterministic Conversational Brain Gateway endpoint (`runConversationChat`).
 * Deliberately thin — no LLM calls, no persistence, no RAG.
 *
 * RETIRED FROM THE CUSTOMER UI BY PB-CHAT-01. It receives no project state, so it must never
 * again power a visible project conversation: the Command Center now hosts the persisted,
 * project-grounded Project Brain (`/api/projects/[id]/brain/turns`). No `src/` UI calls this
 * route; tests/pb-chat-01-project-brain-conversation.test.ts pins that. It is kept only for
 * backward compatibility with the gateway's own contract tests.
 */
export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "message is required." }, { status: 400 });

  const conversationHistory = Array.isArray(body.conversationHistory)
    ? body.conversationHistory.filter(isConversationTurn)
    : undefined;

  const result = runConversationChat({
    message,
    workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : undefined,
    activeProjectId: typeof body.activeProjectId === "string" ? body.activeProjectId : undefined,
    activeProjectName: typeof body.activeProjectName === "string" ? body.activeProjectName : undefined,
    conversationHistory,
  });

  return Response.json(result);
}
