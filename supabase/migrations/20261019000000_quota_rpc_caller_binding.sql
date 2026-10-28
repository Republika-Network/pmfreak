-- C1 — bind upload-quota RPCs to the calling tenant (companion to B1).
--
-- reserve_upload_quota / commit_upload_quota / cancel_upload_quota are SECURITY DEFINER
-- and executable by `authenticated` (20260910000000). Until now they trusted the
-- caller-supplied p_company_id, so a signed-in user could reserve, commit or cancel quota
-- for ANY company. B1 (20261020000000) makes these functions work again, which would make
-- that cross-tenant path operational; this migration ships with it and is deliberately
-- ordered BEFORE B1, so a partially applied release can never leave B1 without this guard
-- (applied alone, the guard is inert: B1's defect still blocks every reservation).
--
-- Each function now starts with one guard:
--   * an explicit `service_role` JWT (the trusted server path) may act on any company;
--   * every other caller must be acting on its own company: p_company_id = auth.uid().
--     Company id equals the user id for every account (no code path writes another).
--   * no JWT at all (auth.uid() is null) is denied — a missing identity is never trusted.
-- auth.role()/auth.uid() read the request's JWT settings, which SECURITY DEFINER does not
-- change. `anon` already has no EXECUTE on these functions.
--
-- Bodies are otherwise byte-identical to 20260518000000_quota_atomicity.sql.
-- CREATE OR REPLACE preserves the existing ACL: no grant changes.

begin;

create or replace function public.reserve_upload_quota(
  p_company_id text,
  p_upload_amount integer,
  p_upload_limit integer,   -- NULL = unlimited
  p_month_key text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage_row public.company_usage%rowtype;
  v_committed_count integer;
  v_pending_count integer;
  v_effective_usage integer;
  v_reservation_id uuid;
begin
  -- C1: bind the quota operation to the calling tenant. Only an explicit service_role
  -- JWT (trusted server path) may act on an arbitrary company; any other caller — an
  -- authenticated user, or a session with no JWT at all — must be operating on its own
  -- company (company id = auth.uid()). Fails closed: a missing identity is never trusted.
  if coalesce(auth.role(), '') <> 'service_role'
     and (auth.uid() is null or p_company_id is distinct from auth.uid()::text) then
    raise exception 'upload quota operation is not permitted for this caller'
      using errcode = '42501';
  end if;

  -- Ensure company_usage row exists before attempting to lock it.
  -- ON CONFLICT DO NOTHING is safe under concurrent inserts.
  insert into public.company_usage (company_id, current_month, upload_count)
  values (p_company_id, p_month_key, 0)
  on conflict (company_id) do nothing;

  -- Acquire a row-level lock on company_usage for this company.
  -- All concurrent reservations for the same company will serialise here.
  select * into v_usage_row
  from public.company_usage
  where company_id = p_company_id
  for update;

  -- Monthly reset: if stored month differs from current month, reset the counter
  -- and purge stale pending reservations atomically within this transaction.
  if v_usage_row.current_month != p_month_key then
    update public.company_usage
    set current_month = p_month_key,
        upload_count  = 0,
        updated_at    = now()
    where company_id = p_company_id;

    delete from public.quota_reservations
    where company_id = p_company_id
      and month_key  != p_month_key
      and status      = 'pending';

    v_usage_row.upload_count  := 0;
    v_usage_row.current_month := p_month_key;
  end if;

  v_committed_count := v_usage_row.upload_count;

  -- Sum all non-expired pending reservations for this company in the current month.
  select coalesce(sum(amount), 0) into v_pending_count
  from public.quota_reservations
  where company_id = p_company_id
    and status     = 'pending'
    and month_key  = p_month_key
    and expires_at > now();

  v_effective_usage := v_committed_count + v_pending_count;

  -- Idempotency: if this request_id was already reserved, return the existing result
  -- without creating a duplicate reservation.
  select id into v_reservation_id
  from public.quota_reservations
  where request_id = p_request_id
  limit 1;

  if found then
    return jsonb_build_object(
      'allowed',         true,
      'reason',          'idempotent_replay',
      'reservation_id',  v_reservation_id,
      'previous_usage',  v_effective_usage,
      'new_usage',       v_effective_usage,
      'limit',           p_upload_limit,
      'reset_period',    p_month_key
    );
  end if;

  -- Quota check: NULL limit means unlimited.
  if p_upload_limit is not null and v_effective_usage + p_upload_amount > p_upload_limit then
    return jsonb_build_object(
      'allowed',         false,
      'reason',          'quota_exceeded',
      'reservation_id',  null,
      'previous_usage',  v_effective_usage,
      'new_usage',       v_effective_usage,
      'limit',           p_upload_limit,
      'reset_period',    p_month_key
    );
  end if;

  -- Create the pending reservation. The row is not committed to upload_count yet.
  insert into public.quota_reservations (
    company_id, amount, month_key, request_id, status, expires_at
  ) values (
    p_company_id, p_upload_amount, p_month_key, p_request_id, 'pending',
    now() + interval '5 minutes'
  ) returning id into v_reservation_id;

  return jsonb_build_object(
    'allowed',         true,
    'reason',          'quota_approved',
    'reservation_id',  v_reservation_id,
    'previous_usage',  v_effective_usage,
    'new_usage',       v_effective_usage + p_upload_amount,
    'limit',           p_upload_limit,
    'reset_period',    p_month_key
  );
end;
$$;

create or replace function public.commit_upload_quota(
  p_reservation_id uuid,
  p_company_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.quota_reservations%rowtype;
  v_usage_row public.company_usage%rowtype;
  v_new_count integer;
begin
  -- C1: bind the quota operation to the calling tenant. Only an explicit service_role
  -- JWT (trusted server path) may act on an arbitrary company; any other caller — an
  -- authenticated user, or a session with no JWT at all — must be operating on its own
  -- company (company id = auth.uid()). Fails closed: a missing identity is never trusted.
  if coalesce(auth.role(), '') <> 'service_role'
     and (auth.uid() is null or p_company_id is distinct from auth.uid()::text) then
    raise exception 'upload quota operation is not permitted for this caller'
      using errcode = '42501';
  end if;

  -- Lock the reservation row first to prevent concurrent commits of the same reservation.
  select * into v_reservation
  from public.quota_reservations
  where id         = p_reservation_id
    and company_id = p_company_id
  for update;

  if not found then
    return jsonb_build_object(
      'committed', false,
      'reason',    'reservation_not_found'
    );
  end if;

  if v_reservation.status = 'committed' then
    return jsonb_build_object(
      'committed', true,
      'reason',    'already_committed',
      'amount',    v_reservation.amount
    );
  end if;

  -- Lock the usage row for the final increment.
  select * into v_usage_row
  from public.company_usage
  where company_id = p_company_id
  for update;

  if not found then
    return jsonb_build_object(
      'committed', false,
      'reason',    'usage_row_not_found'
    );
  end if;

  -- If a monthly reset happened between reserve and commit, the reservation is stale.
  -- Delete it silently — the upload already succeeded, so we do not penalise the user.
  if v_usage_row.current_month != v_reservation.month_key then
    delete from public.quota_reservations where id = p_reservation_id;
    return jsonb_build_object(
      'committed', false,
      'reason',    'month_boundary_crossed'
    );
  end if;

  v_new_count := v_usage_row.upload_count + v_reservation.amount;

  update public.company_usage
  set upload_count = v_new_count,
      updated_at   = now()
  where company_id = p_company_id;

  -- Delete the committed reservation and clean up any other expired pending ones.
  delete from public.quota_reservations
  where company_id = p_company_id
    and (
      id = p_reservation_id
      or (status = 'pending' and expires_at <= now())
    );

  return jsonb_build_object(
    'committed', true,
    'reason',    'quota_committed',
    'amount',    v_reservation.amount,
    'new_usage', v_new_count
  );
end;
$$;

create or replace function public.cancel_upload_quota(
  p_reservation_id uuid,
  p_company_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.quota_reservations%rowtype;
begin
  -- C1: bind the quota operation to the calling tenant. Only an explicit service_role
  -- JWT (trusted server path) may act on an arbitrary company; any other caller — an
  -- authenticated user, or a session with no JWT at all — must be operating on its own
  -- company (company id = auth.uid()). Fails closed: a missing identity is never trusted.
  if coalesce(auth.role(), '') <> 'service_role'
     and (auth.uid() is null or p_company_id is distinct from auth.uid()::text) then
    raise exception 'upload quota operation is not permitted for this caller'
      using errcode = '42501';
  end if;

  delete from public.quota_reservations
  where id         = p_reservation_id
    and company_id = p_company_id
    and status     = 'pending'
  returning * into v_reservation;

  if not found then
    return jsonb_build_object(
      'cancelled', false,
      'reason',    'reservation_not_found_or_already_committed'
    );
  end if;

  return jsonb_build_object(
    'cancelled', true,
    'reason',    'reservation_cancelled',
    'amount',    v_reservation.amount
  );
end;
$$;

commit;
