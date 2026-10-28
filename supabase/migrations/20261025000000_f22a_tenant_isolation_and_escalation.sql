-- F22-A — cross-tenant discovery (R1), admin→owner invitation escalation (R2) and
-- viewer-forged project decision approvals (R3).
--
-- R1. project_evidence, project_evidence_content and project_discovery carried project_id and
--     workspace_id as independent foreign keys, and any workspace member (a viewer included)
--     could write them through PostgREST. A member of workspace B could therefore insert a
--     backdated evidence row with workspace_id = B and project_id = <tenant A's project>.
--     Discovery regeneration (a privileged background job) loaded evidence by project_id only
--     and took workspace_id from the oldest row, so A's discovery, RAID items and discovery
--     source document were written into B. The application now resolves the workspace from
--     `projects` (discovery-repository.ts); this migration makes the mismatch impossible to
--     store at all — for client AND service-role writers — and limits client writes to the
--     project-writing roles (owner, admin, pm; the F21 matrix).
--
-- R2. workspace_invitations had one owner/admin ALL policy and a role CHECK that still allowed
--     'owner'. The product never invites owners (INVITABLE_WORKSPACE_ROLES, docs/security/
--     invite-workspace-role-boundary.md), but an admin writing directly through PostgREST could
--     insert — or edit a pending invite into — an owner invitation with a token they chose, and
--     acceptance granted the stored role. Now: invitable roles only (admin, pm, viewer) for every
--     writer; a client inserts only invitations issued in its own name; a client may afterwards
--     only revoke or expire a pending invitation, never re-target or re-role it. Acceptance
--     re-validates the inviter and refuses to touch an existing membership (workspace-team.ts).
--
-- R3. project_decisions had an owner/admin/pm "approve" UPDATE policy and a member-wide
--     "submit" UPDATE policy; permissive policies OR together, so the stricter one was void and
--     a viewer could approve a decision and name any user as approver. Now: only owner/admin/pm
--     insert or update; a client writes decision actor columns only as itself and only with the
--     matching transition of the product's state machine (decision-governance/state-machine.ts).
--
-- New foreign keys and the invitation role CHECK are NOT VALID: they bind every new or updated
-- row immediately but do not re-check history, so the migration cannot fail on pre-existing
-- inconsistent rows. The pre-deploy check in docs/security/f22a-predeploy-checks.md lists such
-- rows; once it reports zero, the constraints can be validated with VALIDATE CONSTRAINT.
-- Service-role and SQL sessions (auth.uid() is null) are not subject to the actor triggers.

begin;

-- ── R1: same-workspace evidence and discovery ───────────────────────────────
create unique index if not exists project_evidence_id_project_workspace_uidx
  on public.project_evidence (id, project_id, workspace_id);

alter table public.project_evidence
  add constraint project_evidence_project_workspace_fkey
  foreign key (project_id, workspace_id) references public.projects (id, workspace_id) on delete cascade not valid;

alter table public.project_evidence_content
  add constraint project_evidence_content_project_workspace_fkey
  foreign key (project_id, workspace_id) references public.projects (id, workspace_id) on delete cascade not valid;

alter table public.project_evidence_content
  add constraint project_evidence_content_evidence_scope_fkey
  foreign key (evidence_id, project_id, workspace_id) references public.project_evidence (id, project_id, workspace_id) on delete cascade not valid;

alter table public.project_discovery
  add constraint project_discovery_project_workspace_fkey
  foreign key (project_id, workspace_id) references public.projects (id, workspace_id) on delete cascade not valid;

drop policy "workspace members can insert project_evidence" on public.project_evidence;
drop policy "workspace members can update project_evidence" on public.project_evidence;
drop policy "workspace members can delete project_evidence" on public.project_evidence;

create policy "workspace writers can insert project_evidence"
  on public.project_evidence for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

create policy "workspace writers can update project_evidence"
  on public.project_evidence for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

-- DELETE /api/project-evidence and the upload rollback already require project write access.
create policy "workspace writers can delete project_evidence"
  on public.project_evidence for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

drop policy "workspace members can insert project_evidence_content" on public.project_evidence_content;
drop policy "workspace members can update project_evidence_content" on public.project_evidence_content;

create policy "workspace writers can insert project_evidence_content"
  on public.project_evidence_content for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

create policy "workspace writers can update project_evidence_content"
  on public.project_evidence_content for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

drop policy "workspace members can insert project_discovery" on public.project_discovery;

create policy "workspace writers can insert project_discovery"
  on public.project_discovery for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

-- ── R2: invitations ─────────────────────────────────────────────────────────
alter table public.workspace_invitations
  add constraint workspace_invitations_invitable_role_check
  check (role in ('admin', 'pm', 'viewer')) not valid;

drop policy "workspace owner admin can manage invitations" on public.workspace_invitations;

create policy "workspace managers can issue invitations"
  on public.workspace_invitations for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin'])
    and invited_by_user_id = auth.uid()
    and status = 'pending'
    and accepted_by_user_id is null
    and accepted_at is null
  );

create policy "workspace managers can update invitations"
  on public.workspace_invitations for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

create policy "workspace managers can delete invitations"
  on public.workspace_invitations for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

-- A client may only retire a pending invitation. Identity, target, role, token and acceptance
-- columns are written once at issue time (or by the service-role acceptance path).
create or replace function public.workspace_invitations_client_update_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id
     or new.company_id is distinct from old.company_id
     or new.email is distinct from old.email
     or new.role is distinct from old.role
     or new.token_hash is distinct from old.token_hash
     or new.invited_by_user_id is distinct from old.invited_by_user_id
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at
     or new.accepted_by_user_id is distinct from old.accepted_by_user_id
     or new.accepted_at is distinct from old.accepted_at then
    raise exception 'workspace_invitation_immutable_field' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'pending' and new.status in ('revoked', 'expired')) then
    raise exception 'workspace_invitation_invalid_status_change' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger workspace_invitations_client_update_guard
  before update on public.workspace_invitations
  for each row execute function public.workspace_invitations_client_update_guard();

-- ── R3: project decisions ───────────────────────────────────────────────────
drop policy "workspace members can create project_decisions" on public.project_decisions;
drop policy "workspace members can submit project_decisions" on public.project_decisions;

create policy "workspace writers can create project_decisions"
  on public.project_decisions for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));
-- "workspace approvers can approve project_decisions" (owner/admin/pm, USING and WITH CHECK)
-- is now the only UPDATE policy.

-- A client records a decision only as itself, and writes each actor column only as itself and
-- only together with the transition that column records. Transitions follow
-- allowedTransitions in src/lib/decision-governance/state-machine.ts.
create or replace function public.project_decisions_client_actor_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  allowed text[];
begin
  if actor is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.created_by is distinct from actor then
      raise exception 'project_decision_creator_must_be_caller' using errcode = '42501';
    end if;
    if coalesce(new.decision_status, 'draft') not in ('draft', 'pending_review')
       or new.approved_by is not null or new.approved_at is not null
       or new.rejected_by is not null or new.rejected_at is not null
       or new.implemented_by is not null or new.implemented_at is not null
       or new.closed_at is not null then
      raise exception 'project_decision_must_start_unreviewed' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.workspace_id is distinct from old.workspace_id
     or new.project_id is distinct from old.project_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'project_decision_immutable_field' using errcode = '42501';
  end if;

  if new.decision_status is distinct from old.decision_status then
    allowed := case old.decision_status
      when 'draft' then array['pending_review']
      when 'pending_review' then array['approved', 'rejected', 'expired']
      when 'approved' then array['implemented', 'expired']
      when 'rejected' then array['expired']
      when 'implemented' then array['expired']
      else array[]::text[]
    end;
    if not (new.decision_status = any (allowed)) then
      raise exception 'project_decision_invalid_transition' using errcode = '42501';
    end if;
  end if;

  if new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
    if not (new.decision_status = 'approved' and old.decision_status is distinct from 'approved' and new.approved_by = actor) then
      raise exception 'project_decision_approver_must_be_caller' using errcode = '42501';
    end if;
  elsif new.decision_status = 'approved' and old.decision_status is distinct from 'approved' then
    raise exception 'project_decision_approver_must_be_caller' using errcode = '42501';
  end if;

  if new.rejected_by is distinct from old.rejected_by or new.rejected_at is distinct from old.rejected_at then
    if not (new.decision_status = 'rejected' and old.decision_status is distinct from 'rejected' and new.rejected_by = actor) then
      raise exception 'project_decision_rejecter_must_be_caller' using errcode = '42501';
    end if;
  elsif new.decision_status = 'rejected' and old.decision_status is distinct from 'rejected' then
    raise exception 'project_decision_rejecter_must_be_caller' using errcode = '42501';
  end if;

  if new.implemented_by is distinct from old.implemented_by or new.implemented_at is distinct from old.implemented_at then
    if not (new.decision_status = 'implemented' and old.decision_status is distinct from 'implemented' and new.implemented_by = actor) then
      raise exception 'project_decision_implementer_must_be_caller' using errcode = '42501';
    end if;
  elsif new.decision_status = 'implemented' and old.decision_status is distinct from 'implemented' then
    raise exception 'project_decision_implementer_must_be_caller' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger project_decisions_client_actor_guard
  before insert or update on public.project_decisions
  for each row execute function public.project_decisions_client_actor_guard();

-- ── grants ──────────────────────────────────────────────────────────────────
revoke truncate, references, trigger on table
  public.project_evidence, public.project_evidence_content, public.project_discovery,
  public.workspace_invitations, public.project_decisions
  from authenticated;
revoke all on table
  public.project_evidence, public.project_evidence_content, public.project_discovery,
  public.workspace_invitations, public.project_decisions
  from anon;
revoke all on function public.workspace_invitations_client_update_guard() from public, anon, authenticated;
revoke all on function public.project_decisions_client_actor_guard() from public, anon, authenticated;

commit;
