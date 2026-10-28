-- F21 — core project data is written by workspace owners/admins/pms only, never viewers.
--
-- The write policies on projects (20260512160000), raid_items (20260602020000),
-- execution_tasks (20260605070000), execution_task_dependencies (20260605080000) and
-- project_milestones (20260605090000) only test workspace membership. The browser holds the
-- user's JWT, so a viewer could insert, rewrite and (for projects, milestones and
-- dependencies) delete project data directly through PostgREST, whatever the application's
-- server-side checks. The child tables also carry project_id / workspace_id as independent
-- foreign keys, and foreign-key checks ignore RLS, so a writer in one workspace could attach
-- tasks, milestones, RAID items or dependencies to another tenant's project or task.
--
-- After this migration (the product's existing role model — ROLE_PERMISSION_MAP in
-- src/lib/security/rbac.ts, where pm holds "write" but not "delete" and viewer only "read"):
--   * every member may still READ (select policies are unchanged);
--   * INSERT / UPDATE require an owner, admin or pm membership in the row's workspace, checked
--     on the existing row (USING) and on the new row (WITH CHECK), so a row can neither be
--     edited by a viewer nor moved into a workspace where the caller is not a writer;
--   * every referenced row must belong to the same workspace as the row: the project (all
--     child tables); for tasks also the milestone, RAID item, task draft and recommended
--     action when set; for RAID items the source vault document; for dependencies both tasks;
--   * DELETE of projects, milestones and dependencies requires owner or admin (the app's only
--     project delete, DELETE /api/projects/[id], already requires admin; no app path deletes
--     milestones or dependencies). execution_tasks and raid_items keep having no delete
--     policy at all;
--   * the client roles lose TRUNCATE / REFERENCES / TRIGGER, and anon loses everything (no
--     policy ever matched anon: auth.uid() is null).
--
-- Membership roles cannot be self-assigned: workspace_memberships has no client write policy.
-- has_workspace_role() is SECURITY INVOKER and reads the caller's own membership row.
-- Service-role and SECURITY DEFINER paths (governed task dispatch/transition, which check
-- can_write_operational_project = owner/admin/pm themselves; background RAID
-- materialization) are unaffected. Policies are dropped by exact name; no rows change.

begin;

-- ── projects ────────────────────────────────────────────────────────────────
drop policy "workspace members can insert projects" on public.projects;
drop policy "workspace members can update projects" on public.projects;
drop policy "workspace members can delete projects" on public.projects;

create policy "workspace writers can insert projects"
  on public.projects for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

create policy "workspace writers can update projects"
  on public.projects for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']));

create policy "workspace admins can delete projects"
  on public.projects for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

-- ── execution_tasks ─────────────────────────────────────────────────────────
drop policy "workspace members can insert execution_tasks" on public.execution_tasks;
drop policy "workspace members can update execution_tasks" on public.execution_tasks;

create policy "workspace writers can insert execution_tasks"
  on public.execution_tasks for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.projects p where p.id = execution_tasks.project_id and p.workspace_id = execution_tasks.workspace_id)
    and (
      execution_tasks.milestone_id is null
      or exists (select 1 from public.project_milestones m where m.id = execution_tasks.milestone_id and m.workspace_id = execution_tasks.workspace_id)
    )
    and (
      execution_tasks.raid_item_id is null
      or exists (select 1 from public.raid_items r where r.id = execution_tasks.raid_item_id and r.workspace_id = execution_tasks.workspace_id)
    )
    and (
      execution_tasks.task_draft_id is null
      or exists (select 1 from public.task_drafts d where d.id = execution_tasks.task_draft_id and d.workspace_id = execution_tasks.workspace_id)
    )
    and (
      execution_tasks.recommended_action_id is null
      or exists (select 1 from public.recommended_actions a where a.id = execution_tasks.recommended_action_id and a.workspace_id = execution_tasks.workspace_id)
    )
  );

create policy "workspace writers can update execution_tasks"
  on public.execution_tasks for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.projects p where p.id = execution_tasks.project_id and p.workspace_id = execution_tasks.workspace_id)
    and (
      execution_tasks.milestone_id is null
      or exists (select 1 from public.project_milestones m where m.id = execution_tasks.milestone_id and m.workspace_id = execution_tasks.workspace_id)
    )
    and (
      execution_tasks.raid_item_id is null
      or exists (select 1 from public.raid_items r where r.id = execution_tasks.raid_item_id and r.workspace_id = execution_tasks.workspace_id)
    )
    and (
      execution_tasks.task_draft_id is null
      or exists (select 1 from public.task_drafts d where d.id = execution_tasks.task_draft_id and d.workspace_id = execution_tasks.workspace_id)
    )
    and (
      execution_tasks.recommended_action_id is null
      or exists (select 1 from public.recommended_actions a where a.id = execution_tasks.recommended_action_id and a.workspace_id = execution_tasks.workspace_id)
    )
  );

-- ── project_milestones ──────────────────────────────────────────────────────
drop policy "workspace members can insert project_milestones" on public.project_milestones;
drop policy "workspace members can update project_milestones" on public.project_milestones;
drop policy "workspace members can delete project_milestones" on public.project_milestones;

create policy "workspace writers can insert project_milestones"
  on public.project_milestones for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.projects p where p.id = project_milestones.project_id and p.workspace_id = project_milestones.workspace_id)
  );

create policy "workspace writers can update project_milestones"
  on public.project_milestones for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.projects p where p.id = project_milestones.project_id and p.workspace_id = project_milestones.workspace_id)
  );

create policy "workspace admins can delete project_milestones"
  on public.project_milestones for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

-- ── raid_items ──────────────────────────────────────────────────────────────
drop policy "workspace members can insert raid_items" on public.raid_items;
drop policy "workspace members can update raid_items" on public.raid_items;

create policy "workspace writers can insert raid_items"
  on public.raid_items for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and (
      raid_items.project_id is null
      or exists (select 1 from public.projects p where p.id = raid_items.project_id and p.workspace_id = raid_items.workspace_id)
    )
    and exists (select 1 from public.vault_documents d where d.id = raid_items.source_document_id and d.workspace_id = raid_items.workspace_id)
  );

create policy "workspace writers can update raid_items"
  on public.raid_items for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and (
      raid_items.project_id is null
      or exists (select 1 from public.projects p where p.id = raid_items.project_id and p.workspace_id = raid_items.workspace_id)
    )
    and exists (select 1 from public.vault_documents d where d.id = raid_items.source_document_id and d.workspace_id = raid_items.workspace_id)
  );

-- ── execution_task_dependencies ─────────────────────────────────────────────
drop policy "workspace members can insert execution_task_dependencies" on public.execution_task_dependencies;
drop policy "workspace members can update execution_task_dependencies" on public.execution_task_dependencies;
drop policy "workspace members can delete execution_task_dependencies" on public.execution_task_dependencies;

create policy "workspace writers can insert execution_task_dependencies"
  on public.execution_task_dependencies for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.projects p where p.id = execution_task_dependencies.project_id and p.workspace_id = execution_task_dependencies.workspace_id)
    and exists (select 1 from public.execution_tasks t where t.id = execution_task_dependencies.predecessor_task_id and t.workspace_id = execution_task_dependencies.workspace_id)
    and exists (select 1 from public.execution_tasks t where t.id = execution_task_dependencies.successor_task_id and t.workspace_id = execution_task_dependencies.workspace_id)
  );

create policy "workspace writers can update execution_task_dependencies"
  on public.execution_task_dependencies for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (select 1 from public.projects p where p.id = execution_task_dependencies.project_id and p.workspace_id = execution_task_dependencies.workspace_id)
    and exists (select 1 from public.execution_tasks t where t.id = execution_task_dependencies.predecessor_task_id and t.workspace_id = execution_task_dependencies.workspace_id)
    and exists (select 1 from public.execution_tasks t where t.id = execution_task_dependencies.successor_task_id and t.workspace_id = execution_task_dependencies.workspace_id)
  );

create policy "workspace admins can delete execution_task_dependencies"
  on public.execution_task_dependencies for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

-- ── grants ──────────────────────────────────────────────────────────────────
revoke truncate, references, trigger on table
  public.projects, public.execution_tasks, public.project_milestones, public.raid_items, public.execution_task_dependencies
  from authenticated;
revoke all on table
  public.projects, public.execution_tasks, public.project_milestones, public.raid_items, public.execution_task_dependencies
  from anon;

commit;
