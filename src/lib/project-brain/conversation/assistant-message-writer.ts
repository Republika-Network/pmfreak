// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — assistant reply writer (PB-CHAT-01)
//
// PRIVILEGED_ACCESS: A Project Brain reply is written by the system on behalf of
// the requesting actor, after the route has authenticated the user, derived the
// workspace from the project row and passed the project-scoped
// `project_brain.converse` governance check. INSERT of assistant rows into a
// PROJECT conversation is denied to `authenticated` by
// 20260915000000_pb_chat_01_project_brain_conversation.sql, so a member can
// never author a reply (with fabricated citations) that others would read as
// Project Brain output. Same precedent as governance_approval_requests.
// AUDIT_REF: service-role-risk-register.md
//
// This module writes exactly one table (context_messages), exactly one row
// shape (role = 'assistant', reply_to_message_id + brain_mode set) and nothing
// else: no project state, no Evidence, no memory store.
// ─────────────────────────────────────────────────────────────────────────────

import { createPrivilegedSupabaseClient } from "@/lib/security/privileged-access";
import { CONTEXT_MESSAGE_SELECTABLE_COLUMNS, type ContextMessageBrainMode, type ContextMessageRow } from "@/lib/db/database-contract";

const MESSAGE_COLUMNS = CONTEXT_MESSAGE_SELECTABLE_COLUMNS.join(", ");
const UNIQUE_VIOLATION = "23505";

export async function insertProjectBrainReply(input: {
  actorUserId: string;
  workspaceId: string;
  projectId: string;
  conversationId: string;
  replyToMessageId: string;
  mode: ContextMessageBrainMode;
  content: string;
  metadata: Record<string, unknown>;
}): Promise<{ row: ContextMessageRow } | { conflict: true }> {
  const supabase = createPrivilegedSupabaseClient({
    routeId: "/api/projects/[id]/brain/turns",
    operation: "insert_project_brain_reply",
    reason: "project_brain_assistant_reply",
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
  });

  // Defence in depth: the service role bypasses RLS, so the target conversation
  // is re-proven to be THIS project's thread in THIS workspace before writing.
  const { data: conversation, error: conversationError } = await supabase
    .from("context_conversations")
    .select("id")
    .eq("id", input.conversationId)
    .eq("workspace_id", input.workspaceId)
    .eq("project_id", input.projectId)
    .eq("context_type", "project")
    .maybeSingle();
  if (conversationError) throw new Error(`Unable to verify conversation: ${conversationError.message}`);
  if (!conversation) throw new Error("Project Brain reply target is not this project's conversation.");

  const { data, error } = await supabase
    .from("context_messages")
    .insert({
      conversation_id: input.conversationId,
      workspace_id: input.workspaceId,
      role: "assistant",
      content: input.content,
      metadata: input.metadata,
      created_by_user_id: null,
      reply_to_message_id: input.replyToMessageId,
      brain_mode: input.mode,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error?.code === UNIQUE_VIOLATION) return { conflict: true };
  if (error || !data) throw new Error(`Unable to append Project Brain reply: ${error?.message ?? "unknown"}`);
  return { row: data as unknown as ContextMessageRow };
}
