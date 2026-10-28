-- F22-B — authorization for the active workflows still governed by membership-only RLS.
--
-- Role model (src/lib/security/rbac.ts, as in F21 / F22-A): owner, admin and pm write
-- operational project data and upload documents; a viewer (external stakeholder) only reads.
-- Clients act only as themselves and only inside the row's own workspace.
--
--  1. vault_documents / vault_operational_signals — any member (a viewer included) inserted and
--     rewrote vault documents, including the discovery source documents RAID items cite, and
--     inserted signals; project and document references were not tied to the row's workspace.
--     Now: owner/admin/pm, created_by = caller, project and document in the same workspace.
--  2. task_drafts — any member inserted, edited and approved drafts that pms materialize into
--     tasks (POST /api/task-drafts/status only required read access). Now: owner/admin/pm,
--     created_by = caller on insert, project / recommended action / RAID item in the same
--     workspace (and the action in the same project).
--  3. execution_task_events — any member (policy role `public`) inserted timeline events under
--     any actor, including on another tenant's task. Now: owner/admin/pm, actor = caller, and
--     the task must be this workspace's and this project's.
--  4. recommended_action_decisions — any member inserted decision audit rows under any user.
--     Now: owner/admin/pm, decided_by = caller, action in the same workspace and project.
--  5. project_evidence — the evidence delete route removes `storage_path` from Storage with the
--     service role, and writers could store or rewrite that path freely (another tenant's
--     object). Now a client may only insert a path under its own upload prefix
--     (<caller>/<project>/...) as uploaded_by = caller, and can never change the path, uploader,
--     project or workspace afterwards. The route also re-validates the path before deleting.
--  6. governance_violations / governance_commitments — feed live PM capacity, performance and
--     compliance reports; any member could insert, rewrite (and for commitments delete) them.
--     Now: owner/admin/pm write (owner/admin delete commitments); a commitment's action must be
--     in the same workspace. Members still read.
--  7. runtime_conversation_state — the application keys copilot state by the caller's own
--     company (= user id since F1), but RLS only checked workspace membership, so a member could
--     read or overwrite another member's copilot context. Now the row's company must be the
--     caller's (public.current_company_id()).
--
-- Invitation token hashes are already unreadable by clients (column SELECT revoked by
-- 20260820000000_workspace_invite_token_hashing.sql); the F22-B suite keeps guarding it.
--
-- Policies are dropped by exact name. No rows change. Service-role / SQL sessions are not
-- subject to the evidence guard trigger (auth.uid() is null).

begin;

-- ── 1. vault ────────────────────────────────────────────────────────────────
drop policy "workspace members can insert vault_documents" on public.vault_documents;
drop policy "workspace members can update vault_documents" on public.vault_documents;

create policy "workspace writers can insert vault_documents"
  on public.vault_documents for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and created_by = auth.uid()
    and (
      vault_documents.project_id is null
      or exists (select 1 from public.projects p where p.id = vault_documents.project_id and p.workspace_id = vault_documents.workspace_id)
    )
  );

create policy "workspace writers can update vault_documents"
  on public.vault_documents for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and (
      vault_documents.project_id is null
      or exists (select 1 from public.projects p where p.id = vault_documents.project_id and p.workspace_id = vault_documents.workspace_id)
    )
  );

drop policy "workspace members can insert vault_operational_signals" on public.vault_operational_signals;

create policy "workspace writers can insert vault_operational_signals"
  on public.vault_operational_signals for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (
      select 1 from public.vault_documents d
      where d.id = vault_operational_signals.document_id
        and d.workspace_id = vault_operational_signals.workspace_id
        and d.project_id is not distinct from vault_operational_signals.project_id
    )
  );

-- ── 2. task drafts ──────────────────────────────────────────────────────────
drop policy "workspace members can insert task_drafts" on public.task_drafts;
drop policy "workspace members can update task_drafts" on public.task_drafts;

create policy "workspace writers can insert task_drafts"
  on public.task_drafts for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and created_by = auth.uid()
    and exists (select 1 from public.projects p where p.id = task_drafts.project_id and p.workspace_id = task_drafts.workspace_id)
    and exists (
      select 1 from public.recommended_actions a
      where a.id = task_drafts.recommended_action_id and a.workspace_id = task_drafts.workspace_id and a.project_id = task_drafts.project_id
    )
    and (
      task_drafts.raid_item_id is null
      or exists (select 1 from public.raid_items r where r.id = task_drafts.raid_item_id and r.workspace_id = task_drafts.workspace_id)
    )
  );

create policy "workspace writers can update task_drafts"
  on public.task_drafts for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.projects p where p.id = task_drafts.project_id and p.workspace_id = task_drafts.workspace_id)
    and exists (
      select 1 from public.recommended_actions a
      where a.id = task_drafts.recommended_action_id and a.workspace_id = task_drafts.workspace_id and a.project_id = task_drafts.project_id
    )
    and (
      task_drafts.raid_item_id is null
      or exists (select 1 from public.raid_items r where r.id = task_drafts.raid_item_id and r.workspace_id = task_drafts.workspace_id)
    )
  );

-- ── 3. execution task events ────────────────────────────────────────────────
drop policy "workspace members can insert execution_task_events" on public.execution_task_events;

create policy "workspace writers can insert execution_task_events"
  on public.execution_task_events for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and actor_user_id = auth.uid()
    and exists (
      select 1 from public.execution_tasks t
      where t.id = execution_task_events.task_id
        and t.workspace_id = execution_task_events.workspace_id
        and t.project_id = execution_task_events.project_id
    )
  );

-- ── 4. recommended action decisions ─────────────────────────────────────────
drop policy "workspace members can insert recommended_action_decisions" on public.recommended_action_decisions;

create policy "workspace writers can insert recommended_action_decisions"
  on public.recommended_action_decisions for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and decided_by = auth.uid()
    and exists (
      select 1 from public.recommended_actions a
      where a.id = recommended_action_decisions.recommended_action_id
        and a.workspace_id = recommended_action_decisions.workspace_id
        and a.project_id = recommended_action_decisions.project_id
    )
  );

-- ── 5. evidence storage paths ───────────────────────────────────────────────
-- Upload paths are <companyId>/<projectId>/<fileId>-<name>, and companyId is the uploader's
-- user id (F1). A client stores only paths under its own prefix for the row's project.
drop policy "workspace writers can insert project_evidence" on public.project_evidence;

create policy "workspace writers can insert project_evidence"
  on public.project_evidence for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and uploaded_by = auth.uid()
    and starts_with(storage_path, auth.uid()::text || '/' || project_id::text || '/')
    and position('/' in substr(storage_path, length(auth.uid()::text || '/' || project_id::text || '/') + 1)) = 0
    and position('..' in storage_path) = 0
  );

create or replace function public.project_evidence_client_update_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.storage_path is distinct from old.storage_path
     or new.uploaded_by is distinct from old.uploaded_by
     or new.uploaded_at is distinct from old.uploaded_at
     or new.workspace_id is distinct from old.workspace_id
     or new.project_id is distinct from old.project_id then
    raise exception 'project_evidence_immutable_field' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger project_evidence_client_update_guard
  before update on public.project_evidence
  for each row execute function public.project_evidence_client_update_guard();

-- ── 6. governance violations and commitments ────────────────────────────────
drop policy "workspace members can insert governance violations" on public.governance_violations;
drop policy "workspace members can update governance violations" on public.governance_violations;

create policy "workspace writers can insert governance violations"
  on public.governance_violations for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

create policy "workspace writers can update governance violations"
  on public.governance_violations for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

drop policy "workspace_members_can_access_governance_commitments" on public.governance_commitments;

create policy "workspace members can read governance commitments"
  on public.governance_commitments for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "workspace writers can insert governance commitments"
  on public.governance_commitments for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.governance_actions a where a.id = governance_commitments.action_id and a.workspace_id = governance_commitments.workspace_id)
  );

create policy "workspace writers can update governance commitments"
  on public.governance_commitments for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.governance_actions a where a.id = governance_commitments.action_id and a.workspace_id = governance_commitments.workspace_id)
  );

create policy "workspace admins can delete governance commitments"
  on public.governance_commitments for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

-- ── 7. copilot conversation state ───────────────────────────────────────────
drop policy "workspace members can read runtime_conversation_state" on public.runtime_conversation_state;
drop policy "workspace members can insert runtime_conversation_state" on public.runtime_conversation_state;
drop policy "workspace members can update runtime_conversation_state" on public.runtime_conversation_state;

create policy "members read their own runtime_conversation_state"
  on public.runtime_conversation_state for select to authenticated
  using (workspace_id is not null and public.is_workspace_member(workspace_id) and company_id::text = public.current_company_id());

create policy "members insert their own runtime_conversation_state"
  on public.runtime_conversation_state for insert to authenticated
  with check (
    workspace_id is not null and public.is_workspace_member(workspace_id) and company_id::text = public.current_company_id()
    and (
      runtime_conversation_state.project_id is null
      or exists (select 1 from public.projects p where p.id = runtime_conversation_state.project_id and p.workspace_id = runtime_conversation_state.workspace_id)
    )
  );

create policy "members update their own runtime_conversation_state"
  on public.runtime_conversation_state for update to authenticated
  using (workspace_id is not null and public.is_workspace_member(workspace_id) and company_id::text = public.current_company_id())
  with check (
    workspace_id is not null and public.is_workspace_member(workspace_id) and company_id::text = public.current_company_id()
    and (
      runtime_conversation_state.project_id is null
      or exists (select 1 from public.projects p where p.id = runtime_conversation_state.project_id and p.workspace_id = runtime_conversation_state.workspace_id)
    )
  );

-- ── grants ──────────────────────────────────────────────────────────────────
revoke truncate, references, trigger on table
  public.vault_documents, public.vault_operational_signals, public.task_drafts, public.execution_task_events,
  public.recommended_action_decisions, public.governance_violations, public.governance_commitments,
  public.runtime_conversation_state
  from authenticated;
revoke all on table
  public.vault_documents, public.vault_operational_signals, public.task_drafts, public.execution_task_events,
  public.recommended_action_decisions, public.governance_violations, public.governance_commitments,
  public.runtime_conversation_state
  from anon;
revoke all on function public.project_evidence_client_update_guard() from public, anon, authenticated;

commit;
