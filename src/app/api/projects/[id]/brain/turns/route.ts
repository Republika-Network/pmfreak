import { NextResponse } from "next/server";
import { AccessDeniedError, enforceRuntimeAuthorization, requireProjectPermission } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import { abuseDenyResponse, enforceAbuseLimit } from "@/lib/security/abuse-protection";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runInference, isProviderConfigured } from "@/lib/ai/providers/router";
import {
  findActiveConversation,
  findUserMessageByClientId,
  getOrCreateConversation,
  insertUserTurn,
  listMessages,
  listRepliesTo,
} from "@/lib/chat/context-chat-service";
import type { ContextScope } from "@/lib/context/context-scope";
import {
  insertProjectBrainReply,
  loadProjectBrainContext,
  MAX_USER_MESSAGE_CHARS,
  ProjectBrainTurnConflictError,
  readProjectBrainTranscript,
  runProjectBrainTurn,
  toProjectBrainMessageView,
  toProjectBrainTranscript,
  type ProjectBrainTurnStore,
} from "@/lib/project-brain/conversation";

/**
 * PB-CHAT-01 — the canonical Project Brain conversation for ONE project.
 *
 *   GET  /api/projects/[id]/brain/turns   ordered, persisted transcript (read-only;
 *                                         never creates a conversation)
 *   POST /api/projects/[id]/brain/turns   { clientMessageId, text, retry? } → one
 *                                         idempotent turn
 *
 * Scope comes from the ROUTE, never the body: the project id is the path segment
 * and the workspace is `projects.workspace_id`, resolved by
 * `requireProjectPermission`. No workspaceId or projectId is accepted from the
 * caller. An unknown project and a project outside the caller's workspaces are
 * the same 403, so this route is not an existence oracle.
 *
 * Read-only with respect to project state: the only writes behind POST are the
 * user turn, the Project Brain reply and the AI usage row `runInference` records.
 */

const ROUTE_ID = "/api/projects/[id]/brain/turns";
const HISTORY_READ_LIMIT = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string }> };

async function resolveProject(projectId: string) {
  try {
    const access = (await requireProjectPermission(projectId, "read")) as { workspaceId: string; user: { id: string } };
    return { workspaceId: access.workspaceId, userId: access.user.id };
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return { denied: denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" }) };
      }
      return {
        denied: denyFromAccessError(error, {
          status: 403,
          routeId: ROUTE_ID,
          message: "Project Brain access denied.",
          projectId,
          requestedPermission: "read",
          deniedPermission: "read",
          eventType: "project_scope_violation",
        }),
      };
    }
    throw error;
  }
}

function buildStore(scope: Extract<ContextScope, { type: "project" }>, userId: string): ProjectBrainTurnStore {
  return {
    findConversation: () => findActiveConversation(scope),
    getOrCreateConversation: () => getOrCreateConversation(scope, userId),
    listMessages: (conversationId) => listMessages(conversationId, scope.workspaceId, HISTORY_READ_LIMIT),
    findUserMessage: (conversationId, clientMessageId) =>
      findUserMessageByClientId({ conversationId, workspaceId: scope.workspaceId, clientMessageId }),
    insertUserMessage: async (conversationId, clientMessageId, content) =>
      insertUserTurn({ conversationId, workspaceId: scope.workspaceId, clientMessageId, content, userId }),
    listReplies: (conversationId, userMessageId) => listRepliesTo({ conversationId, workspaceId: scope.workspaceId, userMessageId }),
    insertReply: (input) =>
      insertProjectBrainReply({ ...input, actorUserId: userId, workspaceId: scope.workspaceId, projectId: scope.projectId }),
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const { id: projectId } = await context.params;
  try {
    const resolved = await resolveProject(projectId);
    if ("denied" in resolved) return resolved.denied;
    const scope = { type: "project" as const, workspaceId: resolved.workspaceId, projectId };
    const { conversation, messages } = await readProjectBrainTranscript(buildStore(scope, resolved.userId));
    return NextResponse.json({
      conversationId: conversation?.id ?? null,
      messages: toProjectBrainTranscript(messages),
      // Configuration only (is a provider key present?) — no value is exposed.
      generativeAvailable: isProviderConfigured("openai"),
    });
  } catch (error) {
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to load the Project Brain conversation.");
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id: projectId } = await context.params;
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

    const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!UUID_PATTERN.test(clientMessageId)) return NextResponse.json({ error: "clientMessageId must be a UUID." }, { status: 400 });
    if (!text) return NextResponse.json({ error: "Message is required." }, { status: 400 });
    if (text.length > MAX_USER_MESSAGE_CHARS) return NextResponse.json({ error: "Message is too long." }, { status: 400 });
    if ("attachments" in body || "workspaceId" in body || "projectId" in body) {
      return NextResponse.json({ error: "Unsupported field. Scope comes from the route; attachments are not supported." }, { status: 400 });
    }

    const resolved = await resolveProject(projectId);
    if ("denied" in resolved) return resolved.denied;
    const { workspaceId, userId } = resolved;

    // Narrow, project-scoped, read-only conversational authority. NOT ai.execute.
    const governance = await enforceRuntimeAuthorization({
      actorType: "user",
      actorUserId: userId,
      workspaceId,
      projectId,
      action: "project_brain.converse",
      routeId: ROUTE_ID,
      requestedPermission: "read",
      resourceType: "project_brain_conversation",
      resourceId: projectId,
    });
    if (governance.response) return governance.response;

    // See src/lib/security/abuse-protection-registry.ts ("ai.module_output.project_brain_turn").
    const abuse = await enforceAbuseLimit({ scope: "ai.module_output", action: "project_brain_turn", identifier: userId, limit: 120, windowSeconds: 3600 });
    if (!abuse.allowed) return abuseDenyResponse(abuse);

    const scope = { type: "project" as const, workspaceId, projectId };
    const supabase = await createSupabaseServerClient();
    const result = await runProjectBrainTurn(
      {
        scope: { workspaceId, projectId },
        userId,
        store: buildStore(scope, userId),
        loadContext: (history) => loadProjectBrainContext({ client: supabase, scope: { workspaceId, projectId }, userId, history }),
        infer: runInference,
        now: () => new Date(),
      },
      { clientMessageId, text, retry: body.retry === true },
    );

    const userMessage = toProjectBrainMessageView(result.userMessage);
    if (result.status === "pending") {
      return NextResponse.json(
        { status: "pending", replayed: true, conversationId: result.conversationId, messages: [userMessage], retryAfterMs: result.retryAfterMs },
        { status: 202 },
      );
    }
    return NextResponse.json({
      status: "completed",
      replayed: result.replayed,
      retryFailed: result.retryFailed ?? false,
      conversationId: result.conversationId,
      messages: [userMessage, toProjectBrainMessageView(result.reply)],
    });
  } catch (error) {
    if (error instanceof ProjectBrainTurnConflictError) {
      return NextResponse.json({ error: "This message id was already used for a different message.", code: error.reason }, { status: 409 });
    }
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to send your message to Project Brain.");
  }
}
