-- =============================================================================
-- PB-CHAT-01 — Unified Project Brain conversation: transcript hardening.
--
-- WHY
--   PB-CHAT-01 makes `context_conversations` / `context_messages` the canonical
--   transcript of the Project Brain conversation (one thread per project). The
--   tables were created by 20260828000001_workspace_pmo_project_hierarchy.sql for
--   a deterministic chat and are not strong enough to hold a generative,
--   billable, citable conversation:
--
--     * no client idempotency identity  -> a network retry duplicated the user
--                                          turn and could re-run the model;
--     * ordering by created_at only     -> timestamp ties had no stable order;
--     * "workspace members can manage"  -> FOR ALL policies let any member UPDATE
--                                          or DELETE any message (or delete a
--                                          whole conversation, cascading its
--                                          messages) — history was not
--                                          append-only;
--     * assistant rows insertable by    -> any member could forge a "Project
--       any member                         Brain" reply, with fabricated source
--                                          citations, into a project thread.
--
-- WHAT IT ADDS (additive only — no existing row is rewritten except the one-time
-- sequence backfill, no row is deleted)
--
--   context_messages.message_seq          monotonic insertion sequence; the
--                                         transcript orders by it, never by
--                                         created_at alone. Historical rows are
--                                         backfilled in (created_at, id) order.
--   context_messages.client_message_id    client-generated idempotency id for a
--                                         USER turn; unique per conversation.
--   context_messages.reply_to_message_id  links an ASSISTANT reply to the user
--                                         turn it answers (same conversation).
--   context_messages.brain_mode           'generative' | 'degraded' on Project
--                                         Brain assistant replies. At most ONE
--                                         reply per (user turn, mode): a replay
--                                         can never append a second generative
--                                         answer, and a degraded answer can be
--                                         followed by at most one generative
--                                         retry.
--
-- AUTHORITY / RLS
--   * context_messages: SELECT for workspace members (unchanged semantics);
--     INSERT only through the new policy below; NO update/delete policy, and
--     UPDATE/DELETE are revoked from anon/authenticated. Transcript is
--     append-only from every customer path.
--   * A member may insert a USER row only as themselves
--     (created_by_user_id = auth.uid()).
--   * ASSISTANT/SYSTEM rows in a PROJECT-scoped conversation are written only by
--     the Project Brain server path (service role, see
--     src/lib/project-brain/conversation/assistant-message-writer.ts). The
--     workspace/PMO chats (still deterministic, out of PB-CHAT-01 scope) keep
--     inserting their own assistant rows with the member's client, as before.
--   * context_conversations: SELECT + INSERT for members; the FOR ALL policy is
--     replaced, and UPDATE/DELETE are revoked from anon/authenticated, because
--     deleting a conversation cascades to its messages.
--
-- RESIDUAL BOUNDARY (documented, not hidden)
--   PMFreak has no per-project ACL: project read access IS workspace membership
--   with a role holding `read` (src/lib/security/access-guards.ts
--   requireProjectPermission). The database boundary is therefore the
--   workspace; the project boundary is enforced by the API (project-scoped
--   governance action `project_brain.converse`, and every read filtered by the
--   routed project id) and by the scope-shape/same-workspace triggers.
--
-- NOT IN THIS MIGRATION (PB-CHAT-02/03): attachments, relevance classification,
-- Project Memory, Evidence promotion.
-- =============================================================================

-- ─── Columns ────────────────────────────────────────────────────────────────

create sequence if not exists public.context_messages_message_seq_seq as bigint;

alter table public.context_messages
  add column if not exists message_seq bigint,
  add column if not exists client_message_id uuid,
  add column if not exists reply_to_message_id uuid references public.context_messages(id) on delete cascade,
  add column if not exists brain_mode text;

-- One-time backfill of historical rows, oldest first, ties broken by id so the
-- result is deterministic. Only rows that have no sequence yet are touched.
with ordered as (
  select id
  from public.context_messages
  where message_seq is null
  order by created_at asc, id asc
)
update public.context_messages m
set message_seq = nextval('public.context_messages_message_seq_seq')
from ordered
where m.id = ordered.id;

alter table public.context_messages
  alter column message_seq set default nextval('public.context_messages_message_seq_seq'),
  alter column message_seq set not null;

alter sequence public.context_messages_message_seq_seq owned by public.context_messages.message_seq;

-- ─── Invariants ─────────────────────────────────────────────────────────────

alter table public.context_messages
  drop constraint if exists context_messages_client_message_id_user_only,
  add constraint context_messages_client_message_id_user_only
    check (client_message_id is null or role = 'user');

alter table public.context_messages
  drop constraint if exists context_messages_reply_to_assistant_only,
  add constraint context_messages_reply_to_assistant_only
    check (reply_to_message_id is null or role = 'assistant');

alter table public.context_messages
  drop constraint if exists context_messages_brain_mode_shape,
  add constraint context_messages_brain_mode_shape
    check (
      brain_mode is null
      or (brain_mode in ('generative', 'degraded') and role = 'assistant' and reply_to_message_id is not null)
    );

-- Replay of the same client id in the same conversation is the SAME user turn.
create unique index if not exists context_messages_conversation_client_message_uidx
  on public.context_messages (conversation_id, client_message_id)
  where client_message_id is not null;

-- At most one Project Brain reply per (user turn, mode).
create unique index if not exists context_messages_reply_mode_uidx
  on public.context_messages (reply_to_message_id, brain_mode)
  where reply_to_message_id is not null;

create index if not exists context_messages_conversation_seq_idx
  on public.context_messages (conversation_id, message_seq);

-- A reply must answer a USER turn of the SAME conversation. Invoker rights: the
-- only writer that sets reply_to_message_id is the service-role Project Brain
-- path, and a member's own insert never carries one (the column is null there,
-- so the lookup below is skipped).
create or replace function public.enforce_context_message_reply_target() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  target_conversation uuid;
  target_role text;
begin
  if new.reply_to_message_id is null then
    return new;
  end if;
  select conversation_id, role into target_conversation, target_role
  from public.context_messages
  where id = new.reply_to_message_id;
  if target_conversation is distinct from new.conversation_id or target_role is distinct from 'user' then
    raise exception 'context_messages.reply_to_message_id must reference a user message in the same conversation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists context_messages_reply_target on public.context_messages;
create trigger context_messages_reply_target
  before insert or update of reply_to_message_id, conversation_id on public.context_messages
  for each row execute function public.enforce_context_message_reply_target();

-- ─── RLS: context_messages is append-only ───────────────────────────────────

drop policy if exists "workspace members can manage context_messages" on public.context_messages;
drop policy if exists "workspace members can insert context_messages" on public.context_messages;

create policy "workspace members can insert context_messages"
  on public.context_messages for insert
  to authenticated
  with check (
    exists (
      select 1 from public.workspace_memberships wm
      where wm.workspace_id = context_messages.workspace_id
        and wm.user_id = auth.uid()
    )
    and (
      -- A member speaks only as themselves.
      (role = 'user' and created_by_user_id = auth.uid())
      -- Deterministic workspace/PMO chats (unchanged by PB-CHAT-01) still write
      -- their own replies. A PROJECT thread's replies are Project Brain output
      -- and are written only by the server's service-role path.
      or (
        role in ('assistant', 'system')
        and client_message_id is null
        and reply_to_message_id is null
        and brain_mode is null
        and exists (
          select 1 from public.context_conversations c
          where c.id = context_messages.conversation_id
            and c.context_type <> 'project'
        )
      )
    )
  );

revoke update, delete on public.context_messages from anon, authenticated;

-- ─── RLS: conversations cannot be edited or deleted by members ──────────────

drop policy if exists "workspace members can manage context_conversations" on public.context_conversations;
drop policy if exists "workspace members can insert context_conversations" on public.context_conversations;

create policy "workspace members can insert context_conversations"
  on public.context_conversations for insert
  to authenticated
  with check (
    exists (
      select 1 from public.workspace_memberships wm
      where wm.workspace_id = context_conversations.workspace_id
        and wm.user_id = auth.uid()
    )
    and created_by_user_id = auth.uid()
    and status = 'active'
  );

revoke update, delete on public.context_conversations from anon, authenticated;
