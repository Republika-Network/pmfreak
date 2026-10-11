-- Atomic early-access invite activation.
--
-- acceptEarlyAccessInvite (src/lib/early-access.ts) used to activate an invite
-- as a sequence of independent PostgREST writes:
--
--   1. insert workspaces
--   2. upsert workspace_memberships (owner)
--   3. update trial_licenses  → workspace_id, dates, status 'active'
--   4. update early_access_invites → accepted_at, workspace_id
--   5. insert workspace_activations
--
-- None of them were rolled back when a later step failed. A failure at step 3
-- left the invitee with a membership in a workspace that has no linked trial
-- license — which the access-entitlement resolver
-- (src/lib/auth/resolve-onboarding-state.ts) cannot tell apart from a
-- self-serve Free account, so the trial was never started and could never
-- expire. Two concurrent acceptances could also both pass the "not yet
-- accepted" check and each create a workspace, with the license ending up
-- linked to whichever update ran last.
--
-- This function performs the whole activation in one transaction: either every
-- row exists (workspace, owner membership, linked active trial, accepted
-- invite, activation record) or none does. The invite row and its license are
-- locked FOR UPDATE, so concurrent acceptances serialize and every one after
-- the first fails with reused_token.
--
-- Every precondition the application checks before calling is re-checked here
-- under the lock (token hash, revocation, prior acceptance, expiry, approval,
-- email binding, license still pending and unlinked) so a state change between
-- the application's read and this call cannot be raced.
--
-- Errors use the application's `code::message` vocabulary so the accept route
-- can surface them unchanged; any other failure is reported generically.
--
-- SECURITY INVOKER (the default): the only caller is the service-role client in
-- src/lib/early-access.ts. Execute is granted to service_role ONLY and revoked
-- from PUBLIC, anon and authenticated explicitly — a PUBLIC revoke alone does
-- not remove Supabase's per-role default grants (see
-- scripts/check-security-definer-hardening.mjs).

create or replace function public.accept_early_access_invite(
  p_invite_id uuid,
  p_invite_token_hash text,
  p_user_id uuid,
  p_user_email text,
  p_workspace_name text,
  p_trial_days integer
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_invite public.early_access_invites%rowtype;
  v_trial public.trial_licenses%rowtype;
  v_workspace_id uuid;
  v_now timestamptz := now();
  v_trial_end timestamptz;
  v_email text := lower(btrim(coalesce(p_user_email, '')));
begin
  if p_invite_id is null or p_user_id is null then
    raise exception using errcode = 'P0001', message = 'invalid_token::Invalid invite token.';
  end if;
  if p_trial_days is null or p_trial_days < 1 or p_trial_days > 365 then
    raise exception using errcode = 'P0001', message = 'invalid_request::Invalid trial duration.';
  end if;

  select * into v_invite
  from public.early_access_invites
  where id = p_invite_id
  for update;

  if not found or v_invite.invite_token_hash is distinct from p_invite_token_hash then
    raise exception using errcode = 'P0001', message = 'invalid_token::Invalid invite token.';
  end if;
  if v_invite.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'revoked_token::Invite access is no longer active.';
  end if;
  if v_invite.accepted_at is not null then
    raise exception using errcode = 'P0001', message = 'reused_token::Invite has already been used.';
  end if;
  if v_invite.expires_at < v_now then
    raise exception using errcode = 'P0001', message = 'expired_token::Invite has expired.';
  end if;
  if v_invite.requires_approval and v_invite.approved_at is null then
    raise exception using errcode = 'P0001', message = 'pending_approval::Founder approval is required before activation.';
  end if;
  if v_email = '' or lower(btrim(coalesce(v_invite.invite_email, ''))) <> v_email then
    raise exception using errcode = 'P0001', message = 'email_mismatch::This invite was issued to a different email address.';
  end if;
  if exists (select 1 from public.workspace_activations where invite_id = p_invite_id) then
    raise exception using errcode = 'P0001', message = 'reused_token::Invite has already been used.';
  end if;

  select * into v_trial
  from public.trial_licenses
  where invite_id = p_invite_id
  for update;

  if not found or v_trial.trial_status <> 'pending' or v_trial.workspace_id is not null then
    raise exception using errcode = 'P0001', message = 'activation_unavailable::This invite can no longer be activated. Please contact the PMFreak team.';
  end if;

  insert into public.workspaces (name, created_by_user_id)
  values (coalesce(nullif(btrim(p_workspace_name), ''), 'PMFreak Early Access Workspace'), p_user_id)
  returning id into v_workspace_id;

  insert into public.workspace_memberships (workspace_id, user_id, role)
  values (v_workspace_id, p_user_id, 'owner');

  v_trial_end := v_now + make_interval(days => p_trial_days);

  update public.trial_licenses
  set workspace_id = v_workspace_id,
      trial_start_at = v_now,
      trial_end_at = v_trial_end,
      trial_status = 'active',
      updated_at = v_now
  where id = v_trial.id;

  update public.early_access_invites
  set accepted_at = v_now,
      workspace_id = v_workspace_id,
      updated_at = v_now
  where id = p_invite_id;

  insert into public.workspace_activations (
    invite_id,
    trial_license_id,
    workspace_id,
    activated_by_user_id,
    operational_memory_namespace,
    runtime_authority_linkage,
    governance_profile,
    explainability_defaults,
    machine_governance_defaults,
    starter_cognition_state
  ) values (
    p_invite_id,
    v_trial.id,
    v_workspace_id,
    p_user_id,
    'workspace:' || v_workspace_id::text,
    jsonb_build_object('authority', 'workspace_owner', 'linkedAt', v_now),
    jsonb_build_object('level', 'early_access', 'profile', 'default'),
    jsonb_build_object('style', 'high_trust', 'visibleRationales', true),
    jsonb_build_object('escalationMode', 'balanced', 'policyVersion', '2026-05'),
    jsonb_build_object('runtimeAuthorityVersion', 'v1', 'explainabilityMode', 'founder-guided', 'machineGovernanceMode', 'safety-default')
  );

  return jsonb_build_object(
    'workspace_id', v_workspace_id,
    'trial_license_id', v_trial.id,
    'trial_end_at', v_trial_end
  );
end;
$$;

revoke all on function public.accept_early_access_invite(uuid, text, uuid, text, text, integer) from public;
revoke all on function public.accept_early_access_invite(uuid, text, uuid, text, text, integer) from anon;
revoke all on function public.accept_early_access_invite(uuid, text, uuid, text, text, integer) from authenticated;
grant execute on function public.accept_early_access_invite(uuid, text, uuid, text, text, integer) to service_role;
