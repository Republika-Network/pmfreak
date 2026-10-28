-- PD-25 — an archived project takes no new operational-chain writes, enforced in the database.
--
-- can_write_operational_project() is the write-authority gate inside the operational chain's
-- SECURITY DEFINER RPCs (capture_*, derive_operational_evidence, materialize_operational_chain,
-- governed material actions, …) and an RLS helper on the operational tables' write policies.
-- It checked membership and the owner/admin/pm role but not the project's status, so captures
-- on an archived project succeeded (five-persona QA, Wave 3). An archived project is read-only
-- (docs/product-architecture/07-route-layout-and-navigation-architecture.md §7); reads go
-- through can_access_operational_project() and are unchanged, and reactivating the project
-- (status leaving 'archived') restores writes. The application refuses first with 409
-- project_archived (src/lib/projects/archived-project.ts); this is the database floor.
--
-- Same signature, language, volatility, SECURITY DEFINER and search_path; grants re-asserted
-- exactly as 20260910000000_security_definer_effective_grant_hardening.sql set them.

begin;

create or replace function public.can_write_operational_project(p_workspace_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.can_access_operational_project(p_workspace_id, p_project_id)
    and public.operational_workspace_role(p_workspace_id) in ('owner','admin','pm')
    and exists (
      select 1 from public.projects p
      where p.id = p_project_id
        and p.workspace_id = p_workspace_id
        and p.status <> 'archived'
    )
$$;

revoke execute on function public.can_write_operational_project(uuid,uuid) from public, anon;
grant execute on function public.can_write_operational_project(uuid,uuid) to authenticated, service_role;

commit;
