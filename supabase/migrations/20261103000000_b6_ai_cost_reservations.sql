-- B6 — AI spend is reserved before a billable request and settled after it, atomically.
--
-- The daily cost ceiling (AI_DAILY_COST_LIMIT_USD) summed ai_usage_events.estimated_cost_usd
-- AFTER each call and was checked by a separate read BEFORE the next one:
--   * a returned dated model id (gpt-4.1-mini-2025-04-14) missed the exact-match price table,
--     so every production call recorded NULL cost and the ceiling never fired;
--   * the read FAILED OPEN when accounting was unavailable;
--   * concurrent requests all passed the read before any of them recorded a cost;
--   * requests without a workspace (meta-intelligence, copilot, message-nudges) skipped it.
--
-- ai_cost_reservations is the ledger the ceiling now reads. src/lib/ai/providers/router.ts
-- reserves the WORST-CASE cost of a provider call (an upper bound on input tokens from the
-- request bytes, the output-token cap, every allowed attempt) before calling the provider,
-- and settles it afterwards:
--   * settled  — the call finished; settled_usd is the cost of the reported usage, or the
--                full reservation when usage, the returned model or the outcome is unknown;
--   * released — the provider definitively did not generate (never contacted, or refused
--                with a 4xx/429 on the only attempt); settled_usd = 0;
--   * reserved — still in flight, or the settle never happened (crash, lost connection):
--                it keeps counting at the full reserved amount. Unknown never becomes free.
--
-- reserve_ai_cost() and settle_ai_cost() run under ONE transaction-scoped advisory lock, so
-- the per-workspace, per-user and deployment-wide daily totals are evaluated and updated as a
-- single critical section: concurrent reservations cannot both pass a check that only one of
-- them fits under. A reservation key makes a replayed request idempotent: while a key is
-- in flight ('reserved') or has succeeded, another reservation for it is refused (no second
-- spend). A key whose call failed keeps its row and its charge; an explicit retry of it
-- reserves a NEW row, so a failed attempt is never refunded by retrying.
--
-- Service-role only, like ai_usage_events and abuse_rate_limits: RLS on with a service_role
-- policy, nothing granted to anon or authenticated, and EXECUTE on both functions revoked
-- from public/anon/authenticated. The functions are SECURITY INVOKER: the only caller is
-- the service role, which already owns the table's privileges. No existing object changes.

begin;

create table if not exists public.ai_cost_reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_key text not null,
  usage_day date not null default ((now() at time zone 'utc')::date),
  workspace_id uuid,
  user_id uuid,
  operation text not null,
  provider text not null,
  model text not null,
  price_version text not null,
  reserved_usd numeric(14, 8) not null check (reserved_usd > 0 and reserved_usd <= 1000),
  settled_usd numeric(14, 8) check (settled_usd is null or settled_usd >= 0),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released')),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  response_model text,
  settle_reason text check (settle_reason is null or settle_reason in (
    'success', 'success_usage_unknown', 'success_model_unrecognized',
    'provider_not_contacted', 'provider_refused', 'provider_failed', 'outcome_unknown', 'circuit_open'
  )),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint ai_cost_reservations_scope_present check (workspace_id is not null or user_id is not null),
  constraint ai_cost_reservations_settlement_shape check (
    (status = 'reserved' and settled_usd is null and settled_at is null)
    or (status = 'settled' and settled_usd is not null and settled_at is not null)
    or (status = 'released' and settled_usd = 0 and settled_at is not null)
  )
);

-- At most one in-flight or successful reservation per key.
create unique index if not exists ai_cost_reservations_live_key
  on public.ai_cost_reservations (reservation_key)
  where status = 'reserved' or (status = 'settled' and settle_reason like 'success%');

create index if not exists ai_cost_reservations_day_workspace on public.ai_cost_reservations (usage_day, workspace_id);
create index if not exists ai_cost_reservations_day_user on public.ai_cost_reservations (usage_day, user_id);

alter table public.ai_cost_reservations enable row level security;

drop policy if exists "service role manages ai_cost_reservations" on public.ai_cost_reservations;
create policy "service role manages ai_cost_reservations"
  on public.ai_cost_reservations
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.ai_cost_reservations from anon;
revoke all on public.ai_cost_reservations from authenticated;

-- What a row counts against a ceiling: in-flight and never-settled rows at their full
-- reservation, settled rows at their settled cost, released rows at nothing.
create or replace function public.ai_cost_reservation_charge(p_status text, p_reserved numeric, p_settled numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_status when 'reserved' then p_reserved when 'settled' then p_settled else 0 end;
$$;

revoke execute on function public.ai_cost_reservation_charge(text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.ai_cost_reservation_charge(text, numeric, numeric) to service_role;

create or replace function public.reserve_ai_cost(
  p_reservation_key text,
  p_workspace_id uuid,
  p_user_id uuid,
  p_operation text,
  p_provider text,
  p_model text,
  p_price_version text,
  p_amount_usd numeric,
  p_workspace_limit_usd numeric,
  p_user_limit_usd numeric,
  p_global_limit_usd numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_existing_status text;
  v_spent numeric;
  v_id uuid;
begin
  if nullif(btrim(p_reservation_key), '') is null or nullif(btrim(p_operation), '') is null
     or nullif(btrim(p_provider), '') is null or nullif(btrim(p_model), '') is null
     or nullif(btrim(p_price_version), '') is null then
    raise exception 'reserve_ai_cost: key, operation, provider, model and price version are required' using errcode = '22004';
  end if;
  if p_workspace_id is null and p_user_id is null then
    raise exception 'reserve_ai_cost: a workspace or user budget scope is required' using errcode = '22004';
  end if;
  if p_amount_usd is null or p_amount_usd <= 0 or p_amount_usd > 1000 then
    raise exception 'reserve_ai_cost: invalid amount' using errcode = '22023';
  end if;
  -- Every ceiling is mandatory. A missing limit is a configuration error, never "unlimited".
  if p_global_limit_usd is null or p_global_limit_usd <= 0
     or p_workspace_limit_usd is null or p_workspace_limit_usd <= 0
     or p_user_limit_usd is null or p_user_limit_usd <= 0 then
    raise exception 'reserve_ai_cost: invalid limit' using errcode = '22023';
  end if;

  -- One ledger critical section for every scope; released at commit/rollback.
  perform pg_advisory_xact_lock(hashtextextended('pmfreak.ai_cost_ledger', 0));

  select status into v_existing_status from public.ai_cost_reservations
   where reservation_key = p_reservation_key
     and (status = 'reserved' or (status = 'settled' and settle_reason like 'success%'))
   limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_request', 'status', v_existing_status);
  end if;

  select coalesce(sum(public.ai_cost_reservation_charge(status, reserved_usd, settled_usd)), 0) into v_spent
    from public.ai_cost_reservations where usage_day = v_day;
  if v_spent + p_amount_usd > p_global_limit_usd then
    return jsonb_build_object('ok', false, 'reason', 'daily_cost_ceiling', 'scope', 'global', 'spent_usd', v_spent, 'limit_usd', p_global_limit_usd);
  end if;

  if p_workspace_id is not null then
    select coalesce(sum(public.ai_cost_reservation_charge(status, reserved_usd, settled_usd)), 0) into v_spent
      from public.ai_cost_reservations where usage_day = v_day and workspace_id = p_workspace_id;
    if v_spent + p_amount_usd > p_workspace_limit_usd then
      return jsonb_build_object('ok', false, 'reason', 'daily_cost_ceiling', 'scope', 'workspace', 'spent_usd', v_spent, 'limit_usd', p_workspace_limit_usd);
    end if;
  end if;

  if p_user_id is not null then
    select coalesce(sum(public.ai_cost_reservation_charge(status, reserved_usd, settled_usd)), 0) into v_spent
      from public.ai_cost_reservations where usage_day = v_day and user_id = p_user_id;
    if v_spent + p_amount_usd > p_user_limit_usd then
      return jsonb_build_object('ok', false, 'reason', 'daily_cost_ceiling', 'scope', 'user', 'spent_usd', v_spent, 'limit_usd', p_user_limit_usd);
    end if;
  end if;

  insert into public.ai_cost_reservations
    (reservation_key, usage_day, workspace_id, user_id, operation, provider, model, price_version, reserved_usd)
  values
    (p_reservation_key, v_day, p_workspace_id, p_user_id, p_operation, p_provider, p_model, p_price_version, p_amount_usd)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'reservation_id', v_id, 'reserved_usd', p_amount_usd);
end;
$$;

revoke execute on function public.reserve_ai_cost(text, uuid, uuid, text, text, text, text, numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.reserve_ai_cost(text, uuid, uuid, text, text, text, text, numeric, numeric, numeric, numeric) to service_role;

create or replace function public.settle_ai_cost(
  p_reservation_id uuid,
  p_outcome text,
  p_settled_usd numeric,
  p_input_tokens integer,
  p_output_tokens integer,
  p_response_model text,
  p_settle_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_row public.ai_cost_reservations%rowtype;
begin
  if p_reservation_id is null or p_outcome not in ('settled', 'released') then
    raise exception 'settle_ai_cost: reservation id and outcome (settled|released) are required' using errcode = '22023';
  end if;
  if nullif(btrim(p_settle_reason), '') is null then
    raise exception 'settle_ai_cost: a settle reason is required' using errcode = '22004';
  end if;
  -- Only a provider that definitively did not generate may release a reservation.
  if (p_outcome = 'released') <> (p_settle_reason in ('provider_not_contacted', 'provider_refused', 'circuit_open')) then
    raise exception 'settle_ai_cost: outcome % does not match reason %', p_outcome, p_settle_reason using errcode = '22023';
  end if;
  if p_outcome = 'settled' and (p_settled_usd is null or p_settled_usd < 0) then
    raise exception 'settle_ai_cost: a settled cost must be a non-negative amount' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pmfreak.ai_cost_ledger', 0));

  select * into v_row from public.ai_cost_reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  -- Final states are final: a repeated or late settle never lowers a recorded charge.
  if v_row.status <> 'reserved' then
    return jsonb_build_object('ok', false, 'reason', 'already_final', 'status', v_row.status);
  end if;

  update public.ai_cost_reservations
     set status = p_outcome,
         settled_usd = case when p_outcome = 'released' then 0 else p_settled_usd end,
         input_tokens = p_input_tokens,
         output_tokens = p_output_tokens,
         response_model = p_response_model,
         settle_reason = p_settle_reason,
         settled_at = now()
   where id = p_reservation_id;

  return jsonb_build_object('ok', true, 'status', p_outcome);
end;
$$;

revoke execute on function public.settle_ai_cost(uuid, text, numeric, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.settle_ai_cost(uuid, text, numeric, integer, integer, text, text) to service_role;

commit;
