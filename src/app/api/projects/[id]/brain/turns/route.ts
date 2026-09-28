import { NextResponse } from "next/server";
import { AccessDeniedError, bootstrapRuntimeConsumer, enforceRuntimeAuthorization, requireProjectPermission } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import { abuseDenyResponse, enforceAbuseLimit } from "@/lib/security/abuse-protection";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runInference, isProviderConfigured } from "@/lib/ai/providers/router";
import {
  findActiveConversation,
  findMessageById,
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
  ProjectBrainExecutionTargetError,
  ProjectBrainTurnConflictError,
  readProjectBrainTranscript,
  resolveProjectBrainGenerativeAccess,
  runProjectBrainRequest,
  toProjectBrainMessageView,
  toProjectBrainTranscript,
  type ProjectBrainTurnStore,
} from "@/lib/project-brain/conversation";
import { parseTargetRef } from "@/lib/project-brain/execution-brief/target";
import { persistedBriefVerifier } from "@/lib/project-brain/execution-brief/verify";
import type { ProjectBrainRequestIdentity } from "@/lib/project-brain/execution-brief/types";

/**
 * PB-CHAT-01 — the canonical Project Brain conversation for ONE project.
 *
 *   GET  /api/projects/[id]/brain/turns   ordered, persisted transcript (read-only;
 *                                         never creates a conversation)
 *   POST /api/projects/[id]/brain/turns   { clientMessageId, text, retry?, intent?, targetRef? }
 *                                         → one idempotent turn
 *
 * PB-EXEC-01 — `intent: "answer" | "execution_brief"` (default answer) and, for a
 * brief, an optional `targetRef` (closed shapes, execution-brief/target.ts). A brief
 * is PREPARED, never executed: this route stays read-only with respect to project
 * state, creates no execution request or grant, calls no agent runtime and touches
 * no repository. `renderFor` is deliberately NOT a field — the renderer is chosen in
 * the browser. Responses: `completed` / `pending` as before; `needs_target` (200,
 * nothing written) when a brief request has no usable target; 400
 * `invalid_execution_target` when an explicit target fails validation (nothing
 * written); 409 `client_message_id_reused_with_different_operation` on an identity
 * mismatch.
 *
 * Scope comes from the ROUTE, never the body: the project id is the path segment
 * and the workspace is `projects.workspace_id`, resolved by
 * `requireProjectPermission`. No workspaceId or projectId is accepted from the
 * caller. An unknown project and a project outside the caller's workspaces are
 * the same 403, so this route is not an existence oracle.
 *
 * Read-only with respect to project state: the only writes behind POST are the
 * user turn, the Project Brain reply and the AI usage row `runInference` records.
 *
 * Generative entitlement is decided HERE, on the server, per request
 * (`resolveProjectBrainGenerativeAccess`): the closed-free-beta profile includes
 * generative Project Brain; any other profile requires the commercial Advanced AI
 * entitlement. An un-entitled turn is still persisted and answered in limited
 * mode, and never reaches the provider. Nothing in the request body can change it.
 *
 * Each handler bootstraps the runtime authority itself (`bootstrapRuntimeConsumer`,
 * idempotent) before its first access check, so the route never depends on another route
 * having run first in this process. A bootstrap failure is an ordinary route error: the
 * request is refused, never authorized some other way.
 */

const ROUTE_ID = "/api/projects/[id]/brain/turns";
const HISTORY_READ_LIMIT = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The closed POST body. Anything else (metadata, renderFor, execution/grant/repository fields, …) is refused. */
const ALLOWED_POST_FIELDS = new Set(["clientMessageId", "text", "retry", "intent", "targetRef"]);

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
    insertUserMessage: async (conversationId, clientMessageId, content, metadata) =>
      insertUserTurn({ conversationId, workspaceId: scope.workspaceId, clientMessageId, content, userId, metadata }),
    findMessage: (conversationId, messageId) => findMessageById({ conversationId, workspaceId: scope.workspaceId, messageId }),
    listReplies: (conversationId, userMessageId) => listRepliesTo({ conversationId, workspaceId: scope.workspaceId, userMessageId }),
    insertReply: (input) =>
      insertProjectBrainReply({ ...input, actorUserId: userId, workspaceId: scope.workspaceId, projectId: scope.projectId }),
  };
}

export async function GET(_request: Request, context: RouteContext) {
  const { id: projectId } = await context.params;
  try {
    bootstrapRuntimeConsumer();
    const resolved = await resolveProject(projectId);
    if ("denied" in resolved) return resolved.denied;
    const scope = { type: "project" as const, workspaceId: resolved.workspaceId, projectId };
    const { conversation, messages } = await readProjectBrainTranscript(buildStore(scope, resolved.userId));
    const access = await resolveProjectBrainGenerativeAccess({ userId: resolved.userId });
    const providerConfigured = isProviderConfigured("openai");
    return NextResponse.json({
      conversationId: conversation?.id ?? null,
      // Briefs are exposed only when hash-verified and bound to their row and THIS route's scope.
      messages: toProjectBrainTranscript(messages, { verifyExecutionBrief: persistedBriefVerifier(scope) }),
      // True only when a POST would actually be allowed to call the provider: a
      // provider key is configured AND this user is entitled in this operating
      // profile. Neither the key nor plan internals are exposed.
      generativeAvailable: providerConfigured && access.entitled,
      limitedModeReason: !access.entitled ? "not_included" : !providerConfigured ? "unavailable" : null,
    });
  } catch (error) {
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to load the Project Brain conversation.");
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id: projectId } = await context.params;
  try {
    bootstrapRuntimeConsumer();
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
    if (Object.keys(body).some((key) => !ALLOWED_POST_FIELDS.has(key))) {
      return NextResponse.json({ error: "Unsupported field." }, { status: 400 });
    }
    // PB-EXEC-01: the operation identity, built here from closed shapes only.
    const intent = body.intent === undefined ? "answer" : body.intent;
    if (intent !== "answer" && intent !== "execution_brief") return NextResponse.json({ error: "Unknown intent.", code: "invalid_intent" }, { status: 400 });
    let operationIdentity: ProjectBrainRequestIdentity = { operation: "answer", targetRef: null };
    if (intent === "answer" && body.targetRef !== undefined) {
      return NextResponse.json({ error: "targetRef is only valid for an execution brief.", code: "invalid_execution_target" }, { status: 400 });
    }
    if (intent === "execution_brief") {
      const targetRef = body.targetRef === undefined || body.targetRef === null ? null : parseTargetRef(body.targetRef);
      if (targetRef === "invalid") return NextResponse.json({ error: "Malformed execution target.", code: "invalid_execution_target" }, { status: 400 });
      operationIdentity = { operation: "execution_brief", targetRef };
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

    const access = await resolveProjectBrainGenerativeAccess({ userId });

    const scope = { type: "project" as const, workspaceId, projectId };
    const supabase = await createSupabaseServerClient();
    const result = await runProjectBrainRequest(
      {
        scope: { workspaceId, projectId },
        userId,
        generativeEntitled: access.entitled,
        store: buildStore(scope, userId),
        loadContext: (history) => loadProjectBrainContext({ client: supabase, scope: { workspaceId, projectId }, userId, history }),
        infer: runInference,
        now: () => new Date(),
      },
      { clientMessageId, text, retry: body.retry === true, request: operationIdentity },
    );

    if (result.status === "needs_target") {
      // §9.2.1: deterministic target selection. Nothing was written, no model was called.
      return NextResponse.json({ status: "needs_target", candidates: result.candidates });
    }

    const view = { verifyExecutionBrief: persistedBriefVerifier({ workspaceId, projectId }) };
    const userMessage = toProjectBrainMessageView(result.userMessage, view);
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
      messages: [userMessage, toProjectBrainMessageView(result.reply, view)],
    });
  } catch (error) {
    if (error instanceof ProjectBrainExecutionTargetError) {
      return NextResponse.json({ error: "That recommendation cannot be used as an execution target.", code: error.code }, { status: 400 });
    }
    if (error instanceof ProjectBrainTurnConflictError) {
      return NextResponse.json({ error: "This message id was already used for a different message.", code: error.reason }, { status: 409 });
    }
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to send your message to Project Brain.");
  }
}
