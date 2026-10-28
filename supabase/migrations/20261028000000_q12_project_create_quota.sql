-- Q12 — creating a project obeys the plan's project limit, atomically.
--
-- Every create path (createMinimalProject for POST /api/projects and the /projects inline
-- form, saveProjectOnboarding for the setup wizard, and the Command Center quick-create)
-- checked canCreateMoreProjects() and then inserted in a separate statement. Concurrent
-- requests by one user all passed the check before any of them inserted: a Free user (limit
-- 3) at 2 projects ended with 5 after three parallel creates. Duplication was made atomic in
-- 20261027000000_pd14_project_duplicate_quota.sql; creation now goes through the same
-- critical section.
--
-- create_project_within_limit() performs the create as ONE transaction:
--   * re-checks that the actor is an owner, admin or pm of the workspace (the projects insert
--     policy, 20261024000000) and that the PMO, when given, belongs to that workspace — the
--     function bypasses RLS, so it does not rely on the caller's earlier checks alone;
--   * takes the SAME transaction-scoped advisory lock as duplicate_project_within_limit
--     ('pmfreak.project_quota:' || actor), so creates and duplicates by one user are
--     serialised against each other: each counts only after the previous one has committed;
--   * counts the actor's projects and refuses at the limit (NULL limit = unlimited plan);
--   * inserts the project. status takes the column default ('active'), as before.
-- A refusal or a failed insert leaves no row behind, and the count IS the set of rows, so a
-- failed or rolled-back create never consumes quota.
--
-- EXECUTE belongs to service_role only: the limit is supplied by
-- src/lib/quota/project-quota.ts from the user's own subscription, never by a client.
-- No existing function, policy or row changes.

begin;

create or replace function public.create_project_within_limit(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_pmo_id uuid,
  p_name text,
  p_description text,
  p_onboarding_payload jsonb,
  p_project_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_project public.projects%rowtype;
begin
  if p_actor_user_id is null or p_workspace_id is null or nullif(btrim(p_name), '') is null then
    raise exception 'create_project_within_limit: actor, workspace and name are required' using errcode = '22004';
  end if;
  if p_project_limit is not null and p_project_limit < 0 then
    raise exception 'create_project_within_limit: invalid project limit' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.workspace_memberships wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_actor_user_id
      and wm.role in ('owner', 'admin', 'pm')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_role');
  end if;

  if p_pmo_id is not null and not exists (
    select 1 from public.pmos where id = p_pmo_id and workspace_id = p_workspace_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'pmo_not_found');
  end if;

  -- One project-quota critical section per user, shared with duplicate_project_within_limit;
  -- released at commit/rollback.
  perform pg_advisory_xact_lock(hashtextextended('pmfreak.project_quota:' || p_actor_user_id::text, 0));

  select count(*) into v_count from public.projects where user_id = p_actor_user_id;
  if p_project_limit is not null and v_count >= p_project_limit then
    return jsonb_build_object('ok', false, 'reason', 'project_limit_reached', 'project_count', v_count, 'project_limit', p_project_limit);
  end if;

  insert into public.projects (user_id, workspace_id, pmo_id, name, description, onboarding_payload)
  values (p_actor_user_id, p_workspace_id, p_pmo_id, p_name, p_description, p_onboarding_payload)
  returning * into v_project;

  return jsonb_build_object('ok', true, 'project', to_jsonb(v_project), 'project_count', v_count + 1, 'project_limit', p_project_limit);
end;
$$;

revoke execute on function public.create_project_within_limit(uuid, uuid, uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.create_project_within_limit(uuid, uuid, uuid, text, text, jsonb, integer) to service_role;

commit;
