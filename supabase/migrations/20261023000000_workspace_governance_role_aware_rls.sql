-- PR-3 — workspace governance is written by workspace owners/admins only (F5, RLS half).
--
-- "workspace_governance_member_access" (20260527091000, re-created by 20260601000000) is a
-- FOR ALL policy that only tests workspace membership, so any member — a viewer included —
-- could insert, rewrite or delete the workspace's governance configuration directly through
-- PostgREST, regardless of the application's server-side checks.
--
-- After this migration:
--   * every member may still READ their workspace's governance (load paths are unchanged);
--   * INSERT / UPDATE / DELETE require an owner or admin membership in that workspace — the
--     same rule the server actions (savePmoTenant, saveWorkspaceGovernance) now enforce
--     with requireWorkspaceRole(workspaceId, "admin");
--   * the client roles lose TRUNCATE / REFERENCES / TRIGGER, and anon loses everything (no
--     policy ever matched anon: auth.uid() is null).
--
-- The application writes this table through the service role after authorizing the caller,
-- so the old and new application code both keep working once this applies; only direct
-- client writes by non-admins are removed. No rows change.

begin;

drop policy "workspace_governance_member_access" on public.workspace_governance;

create policy "workspace_governance_member_read"
  on public.workspace_governance
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_memberships wm
      where wm.workspace_id = workspace_governance.workspace_id::uuid
        and wm.user_id = auth.uid()
    )
  );

create policy "workspace_governance_admin_insert"
  on public.workspace_governance
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.workspace_memberships wm
      where wm.workspace_id = workspace_governance.workspace_id::uuid
        and wm.user_id = auth.uid()
        and wm.role in ('owner', 'admin')
    )
  );

create policy "workspace_governance_admin_update"
  on public.workspace_governance
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_memberships wm
      where wm.workspace_id = workspace_governance.workspace_id::uuid
        and wm.user_id = auth.uid()
        and wm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1
      from public.workspace_memberships wm
      where wm.workspace_id = workspace_governance.workspace_id::uuid
        and wm.user_id = auth.uid()
        and wm.role in ('owner', 'admin')
    )
  );

create policy "workspace_governance_admin_delete"
  on public.workspace_governance
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_memberships wm
      where wm.workspace_id = workspace_governance.workspace_id::uuid
        and wm.user_id = auth.uid()
        and wm.role in ('owner', 'admin')
    )
  );

revoke truncate, references, trigger on table public.workspace_governance from authenticated;
revoke all on table public.workspace_governance from anon;

commit;
