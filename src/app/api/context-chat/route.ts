import { NextResponse } from "next/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import { requireAuthenticatedUser, requireProjectAccess, requireWorkspaceMember } from "@/lib/security/server-authorization";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { contextIdFor, type ContextScope } from "@/lib/context/context-scope";
import { appendMessage, getOrCreateConversation, listMessages } from "@/lib/chat/context-chat-service";
import { buildContextReply } from "@/lib/chat/context-chat-responder";
import { getPmoWorkspaceId } from "@/lib/pmos/pmo-service";
import { getProjectWorkspaceId } from "@/lib/projects/project-admin-service";

const ROUTE_ID = "/api/context-chat";
const MAX_MESSAGE_LENGTH = 8000;

function handleAccessError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    if (String(error.metadata.reason) === "unauthorized") {
      return denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" });
    }
    return denyFromAccessError(error, { status: 403, routeId: ROUTE_ID, message: "Forbidden" });
  }
  return null;
}

/**
 * Resolves the scope AND authorizes it in one step. Critically, the
 * workspace_id for a pmo/project scope is always derived from the entity's
 * OWN row — never from the caller's preferred-workspace cookie/session. A
 * user can belong to several workspaces; if their preferred workspace
 * differs from the workspace the requested PMO/project actually lives in,
 * trusting the preferred workspace would persist a conversation row whose
 * workspace_id doesn't match its project_id/pmo_id, which both mislabels
 * the row and (via the workspace-membership RLS read policy) would let
 * members of the WRONG workspace read a conversation about an entity they
 * have no relationship to. Deriving workspace_id from the entity closes
 * that gap: the row's workspace_id is always correct by construction, and
 * the existing requireProjectAccess/requireWorkspaceMember calls remain the
 * authorization gate.
 */
async function resolveAndAuthorizeScope(
  input: { contextType?: unknown; pmoId?: unknown; projectId?: unknown },
  userId: string
): Promise<{ scope: ContextScope } | { error: "workspace_missing" | "invalid_scope" } | { denied: NextResponse } | { retired: NextResponse }> {
  const contextType = typeof input.contextType === "string" ? input.contextType : null;

  if (contextType === "workspace") {
    const resolution = await resolvePreferredWorkspace(userId);
    if (!resolution.workspaceId) return { error: "workspace_missing" };
    await requireWorkspaceMember(resolution.workspaceId);
    return { scope: { type: "workspace", workspaceId: resolution.workspaceId } };
  }

  if (contextType === "pmo") {
    const pmoId = typeof input.pmoId === "string" ? input.pmoId : null;
    if (!pmoId) return { error: "invalid_scope" };
    const workspaceId = await getPmoWorkspaceId(pmoId);
    if (!workspaceId) return { denied: NextResponse.json({ error: "PMO not found." }, { status: 404 }) };
    await requireWorkspaceMember(workspaceId);
    return { scope: { type: "pmo", workspaceId, pmoId } };
  }

  if (contextType === "project") {
    const projectId = typeof input.projectId === "string" ? input.projectId : null;
    if (!projectId) return { error: "invalid_scope" };
    const workspaceId = await getProjectWorkspaceId(projectId);
    if (!workspaceId) return { denied: NextResponse.json({ error: "Project not found." }, { status: 404 }) };
    await requireProjectAccess(projectId, "read");
    // PB-CHAT-01: the project conversation is the Project Brain, served by
    // /api/projects/[id]/brain/turns. This deterministic path no longer reads or
    // writes project threads (and the database now refuses member-authored
    // replies in them), so it answers 410 with the canonical location instead.
    return {
      retired: NextResponse.json(
        { error: "Project chat moved to Project Brain.", canonical: `/api/projects/${encodeURIComponent(projectId)}/brain/turns` },
        { status: 410 },
      ),
    };
  }

  return { error: "invalid_scope" };
}

export async function GET(request: Request) {
  try {
    const { user } = await requireAuthenticatedUser();
    const url = new URL(request.url);
    const resolved = await resolveAndAuthorizeScope(
      {
        contextType: url.searchParams.get("contextType"),
        pmoId: url.searchParams.get("pmoId"),
        projectId: url.searchParams.get("projectId"),
      },
      user.id
    );
    if ("denied" in resolved) return resolved.denied;
    if ("retired" in resolved) return resolved.retired;
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error === "workspace_missing" ? "Workspace context required." : "Invalid context scope." }, { status: 400 });
    }

    const conversation = await getOrCreateConversation(resolved.scope, user.id);
    const messages = await listMessages(conversation.id, resolved.scope.workspaceId);
    return NextResponse.json({
      contextId: contextIdFor(resolved.scope),
      conversation,
      messages,
    });
  } catch (error) {
    const denied = handleAccessError(error);
    if (denied) return denied;
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAuthenticatedUser();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const content = typeof body.message === "string" ? body.message.trim() : "";
    if (!content) return NextResponse.json({ error: "Message is required." }, { status: 400 });
    if (content.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: "Message is too long." }, { status: 400 });
    }

    const resolved = await resolveAndAuthorizeScope(body, user.id);
    if ("denied" in resolved) return resolved.denied;
    if ("retired" in resolved) return resolved.retired;
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error === "workspace_missing" ? "Workspace context required." : "Invalid context scope." }, { status: 400 });
    }

    const conversation = await getOrCreateConversation(resolved.scope, user.id);

    const userMessage = await appendMessage({
      conversationId: conversation.id,
      workspaceId: resolved.scope.workspaceId,
      role: "user",
      content,
      userId: user.id,
    });

    const reply = await buildContextReply(resolved.scope, content);
    const assistantMessage = await appendMessage({
      conversationId: conversation.id,
      workspaceId: resolved.scope.workspaceId,
      role: "assistant",
      content: reply.content,
      metadata: reply.metadata,
    });

    return NextResponse.json({
      contextId: contextIdFor(resolved.scope),
      conversation,
      messages: [userMessage, assistantMessage],
    });
  } catch (error) {
    const denied = handleAccessError(error);
    if (denied) return denied;
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to send message.");
  }
}
