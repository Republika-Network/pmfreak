import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  CONTEXT_CONVERSATION_SELECTABLE_COLUMNS,
  CONTEXT_MESSAGE_SELECTABLE_COLUMNS,
  type ContextConversationRow,
  type ContextMessageRow,
} from "@/lib/db/database-contract";
import { contextIdFor, type ContextScope } from "@/lib/context/context-scope";

const CONVERSATION_COLUMNS = CONTEXT_CONVERSATION_SELECTABLE_COLUMNS.join(", ");
const MESSAGE_COLUMNS = CONTEXT_MESSAGE_SELECTABLE_COLUMNS.join(", ");

/**
 * Conversation persistence for the Workspace → PMO → Project hierarchy.
 *
 * Every scope owns exactly one active conversation (enforced by a partial
 * unique index). Queries always filter on the full scope shape — never on
 * workspace_id alone — so history can never bleed across contexts.
 */

function scopeFilter(scope: ContextScope) {
  return {
    contextType: scope.type,
    pmoId: scope.type === "pmo" ? scope.pmoId : null,
    projectId: scope.type === "project" ? scope.projectId : null,
  };
}

function activeConversationQuery(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, scope: ContextScope) {
  const { contextType, pmoId, projectId } = scopeFilter(scope);
  let query = supabase
    .from("context_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("workspace_id", scope.workspaceId)
    .eq("context_type", contextType)
    .eq("status", "active");
  query = pmoId ? query.eq("pmo_id", pmoId) : query.is("pmo_id", null);
  query = projectId ? query.eq("project_id", projectId) : query.is("project_id", null);
  return query;
}

/**
 * Read-only lookup of a scope's active conversation. Never creates one: a GET
 * of an empty thread must not write (PB-CHAT-01). Returns null when none exists.
 */
export async function findActiveConversation(scope: ContextScope): Promise<ContextConversationRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await activeConversationQuery(supabase, scope).maybeSingle();
  if (error) throw new Error(`Unable to load conversation for ${contextIdFor(scope)}: ${error.message}`);
  return (data as unknown as ContextConversationRow | null) ?? null;
}

export async function getOrCreateConversation(scope: ContextScope, userId: string): Promise<ContextConversationRow> {
  const supabase = await createSupabaseServerClient();
  const { contextType, pmoId, projectId } = scopeFilter(scope);

  const query = activeConversationQuery(supabase, scope);

  const { data: existing } = await query.maybeSingle();
  if (existing) return existing as unknown as ContextConversationRow;

  const { data: created, error } = await supabase
    .from("context_conversations")
    .insert({
      workspace_id: scope.workspaceId,
      context_type: contextType,
      pmo_id: pmoId,
      project_id: projectId,
      title: `${contextType} conversation`,
      created_by_user_id: userId,
    })
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error || !created) {
    // A concurrent request may have created the conversation first (unique
    // index on the scope) — re-read before giving up.
    const { data: raced } = await query.maybeSingle();
    if (raced) return raced as unknown as ContextConversationRow;
    throw new Error(`Unable to create conversation for ${contextIdFor(scope)}: ${error?.message ?? "unknown"}`);
  }
  return created as unknown as ContextConversationRow;
}

export async function listMessages(conversationId: string, workspaceId: string, limit = 200): Promise<ContextMessageRow[]> {
  const supabase = await createSupabaseServerClient();
  // Order descending to take the most recent `limit` rows, then reverse to
  // chronological order for display — ordering ascending before the limit
  // would instead return the oldest messages, stranding long conversations
  // on their earliest 200 messages forever.
  // Ordered by the insertion sequence, never by created_at alone: two rows
  // written in the same instant still have one stable order (PB-CHAT-01).
  const { data, error } = await supabase
    .from("context_messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversationId)
    .eq("workspace_id", workspaceId)
    .order("message_seq", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Unable to load messages: ${error.message}`);
  return ((data ?? []) as unknown as ContextMessageRow[]).reverse();
}

export async function appendMessage(input: {
  conversationId: string;
  workspaceId: string;
  role: ContextMessageRow["role"];
  content: string;
  userId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<ContextMessageRow> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("context_messages")
    .insert({
      conversation_id: input.conversationId,
      workspace_id: input.workspaceId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? null,
      created_by_user_id: input.userId ?? null,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error || !data) throw new Error(`Unable to append message: ${error?.message ?? "unknown"}`);
  return data as unknown as ContextMessageRow;
}

// ─── Project Brain turn persistence (PB-CHAT-01) ────────────────────────────
//
// The user's own turn is written with the caller's request-scoped client, so RLS
// proves `created_by_user_id = auth.uid()`. The assistant reply is written by
// the service-role path in src/lib/project-brain/conversation/
// assistant-message-writer.ts — a member cannot author a Project Brain reply.

const UNIQUE_VIOLATION = "23505";

export async function findUserMessageByClientId(input: {
  conversationId: string;
  workspaceId: string;
  clientMessageId: string;
}): Promise<ContextMessageRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("context_messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", input.conversationId)
    .eq("workspace_id", input.workspaceId)
    .eq("client_message_id", input.clientMessageId)
    .eq("role", "user")
    .maybeSingle();
  if (error) throw new Error(`Unable to load message: ${error.message}`);
  return (data as unknown as ContextMessageRow | null) ?? null;
}

/**
 * Idempotent insert of one user turn. A concurrent or replayed insert of the same
 * (conversation, clientMessageId) collides on the partial unique index and is
 * reported as `conflict` so the caller re-reads the row that won.
 */
export async function insertUserTurn(input: {
  conversationId: string;
  workspaceId: string;
  clientMessageId: string;
  content: string;
  userId: string;
}): Promise<{ row: ContextMessageRow } | { conflict: true }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("context_messages")
    .insert({
      conversation_id: input.conversationId,
      workspace_id: input.workspaceId,
      role: "user",
      content: input.content,
      metadata: null,
      created_by_user_id: input.userId,
      client_message_id: input.clientMessageId,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error?.code === UNIQUE_VIOLATION) return { conflict: true };
  if (error || !data) throw new Error(`Unable to append message: ${error?.message ?? "unknown"}`);
  return { row: data as unknown as ContextMessageRow };
}

/** The Project Brain replies (at most one per mode) that answer a user turn. */
export async function listRepliesTo(input: {
  conversationId: string;
  workspaceId: string;
  userMessageId: string;
}): Promise<ContextMessageRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("context_messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", input.conversationId)
    .eq("workspace_id", input.workspaceId)
    .eq("reply_to_message_id", input.userMessageId)
    .order("message_seq", { ascending: true });
  if (error) throw new Error(`Unable to load replies: ${error.message}`);
  return (data ?? []) as unknown as ContextMessageRow[];
}
