-- PD-14 — duplicating a project obeys the plan's project limit, atomically.
--
-- POST /api/projects/[id]/duplicate inserted a new project with no project-limit check at
-- all, so a Free user (limit 3) could grow without bound by duplicating, while every create
-- path (createMinimalProject, saveProjectOnboarding, the Command Center) refused with
-- upgrade_required. The limit is the same one canCreateMoreProjects enforces: the number of
-- projects whose user_id is the user, across every workspace, against the plan derived from
-- the user's own company_subscriptions row (server-written).
--
-- duplicate_project_within_limit() performs the duplicate as ONE transaction:
--   * re-checks that the actor is an owner, admin or pm of the workspace (the same writer rule
--     as the projects insert policy, 20261024000000) and that the source project and target
--     PMO belong to that workspace — the function bypasses RLS, so it does not rely on the
--     caller's earlier checks alone;
--   * takes a transaction-scoped advisory lock keyed on the actor, so concurrent duplicates by
--     the same user are serialised: each one counts only after the previous one has committed;
--   * counts the actor's projects and refuses at the limit (NULL limit = unlimited plan);
--   * inserts the copy (identity, PMO, methodology, look — no operational history, as before).
-- A refusal or a failed insert leaves no row behind, and the count IS the set of rows, so a
-- failed or rolled-back duplicate never consumes quota.
--
-- EXECUTE belongs to service_role only (as for the upload quota RPCs, 20261022000000): the
-- limit is supplied by src/lib/quota/project-quota.ts from the user's own subscription, never
-- by a client. No existing function, policy or row changes.

begin;

create or replace function public.duplicate_project_within_limit(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_source_project_id uuid,
  p_target_pmo_id uuid,
  p_project_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.projects%rowtype;
  v_count integer;
  v_new_id uuid;
begin
  if p_actor_user_id is null or p_workspace_id is null or p_source_project_id is null then
    raise exception 'duplicate_project_within_limit: actor, workspace and source are required' using errcode = '22004';
  end if;
  if p_project_limit is not null and p_project_limit < 0 then
    raise exception 'duplicate_project_within_limit: invalid project limit' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.workspace_memberships wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_actor_user_id
      and wm.role in ('owner', 'admin', 'pm')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_role');
  end if;

  select * into v_source from public.projects
  where id = p_source_project_id and workspace_id = p_workspace_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'source_not_found');
  end if;

  if p_target_pmo_id is not null and not exists (
    select 1 from public.pmos where id = p_target_pmo_id and workspace_id = p_workspace_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'pmo_not_found');
  end if;

  -- One project-quota critical section per user; released at commit/rollback.
  perform pg_advisory_xact_lock(hashtextextended('pmfreak.project_quota:' || p_actor_user_id::text, 0));

  select count(*) into v_count from public.projects where user_id = p_actor_user_id;
  if p_project_limit is not null and v_count >= p_project_limit then
    return jsonb_build_object('ok', false, 'reason', 'project_limit_reached', 'project_count', v_count, 'project_limit', p_project_limit);
  end if;

  insert into public.projects (user_id, workspace_id, pmo_id, name, description, methodology, icon, color, onboarding_payload)
  values (p_actor_user_id, p_workspace_id, p_target_pmo_id, v_source.name || ' (copy)', v_source.description,
          v_source.methodology, v_source.icon, v_source.color, v_source.onboarding_payload)
  returning id into v_new_id;

  return jsonb_build_object('ok', true, 'project_id', v_new_id, 'project_count', v_count + 1, 'project_limit', p_project_limit);
end;
$$;

revoke execute on function public.duplicate_project_within_limit(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.duplicate_project_within_limit(uuid, uuid, uuid, uuid, integer) to service_role;

commit;
