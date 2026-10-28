-- SEC-W3-1 — the project governance brief is written by workspace owners/admins/pms only.
--
-- operational_governance_briefs (20260602000000) let ANY workspace member insert and update
-- a brief, and POST /api/projects/[id]/operational-governance-brief only authenticated, so a
-- viewer could regenerate and overwrite the project's brief (five-persona QA, Wave 3). The
-- policies also checked workspace_id alone: the row's project_id was not tied to that
-- workspace, so a writer could insert a brief carrying ANOTHER tenant's project_id under its
-- own workspace — occupying the unique project_id slot that the other tenant's upsert needs.
--
-- After this migration (same rule as the F21 project-data policies, 20261024000000):
--   * every member may still READ (the select policy is unchanged);
--   * INSERT / UPDATE require an owner, admin or pm membership in the row's workspace, on the
--     existing row (USING) and on the new row (WITH CHECK);
--   * the row's project must belong to the row's workspace.
-- The application route now requires the project write permission before generating
-- (src/app/api/projects/[id]/operational-governance-brief/route.ts). The project-creation
-- flows that write the first brief run as the creating owner/admin/pm, and the session-less
-- background path uses the service role, so neither is affected. No rows change.

begin;

drop policy "workspace members can insert operational_governance_briefs" on public.operational_governance_briefs;
drop policy "workspace members can update operational_governance_briefs" on public.operational_governance_briefs;

create policy "workspace writers can insert operational_governance_briefs"
  on public.operational_governance_briefs
  for insert to authenticated
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (
      select 1 from public.projects p
      where p.id = operational_governance_briefs.project_id
        and p.workspace_id = operational_governance_briefs.workspace_id
    )
  );

create policy "workspace writers can update operational_governance_briefs"
  on public.operational_governance_briefs
  for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm']))
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin', 'pm'])
    and exists (
      select 1 from public.projects p
      where p.id = operational_governance_briefs.project_id
        and p.workspace_id = operational_governance_briefs.workspace_id
    )
  );

commit;
