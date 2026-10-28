-- PR-2 — upload quota authority is server-only (F3, F20).
--
-- F20: reserve_upload_quota / commit_upload_quota / cancel_upload_quota are SECURITY DEFINER
--      and were executable by `authenticated`. C1 (20261019000000) bound them to the caller's
--      own company, but a signed-in user could still call reserve_upload_quota directly
--      through PostgREST with their own p_upload_limit (NULL = unlimited).
-- F3:  company_usage and quota_reservations carried a FOR ALL tenant policy plus full table
--      privileges, so a signed-in user could reset their own upload_count, delete their own
--      pending reservations or rewrite their own month directly.
--
-- After this migration:
--   * EXECUTE on the three quota RPCs belongs to service_role only. The application calls
--     them from src/lib/quota/upload-quota.ts through a registered, context-tagged
--     service-role client, after authenticating the user, with the limit derived from the
--     company's own subscription row (server-written, see 20260818000000). C1's in-function
--     guard stays as defense in depth.
--   * authenticated keeps SELECT on its own company_usage / quota_reservations rows (usage is
--     displayed in billing state); INSERT / UPDATE / DELETE / TRUNCATE are revoked from the
--     client roles and the FOR ALL policies are replaced by own-row SELECT policies. The
--     only writers are the SECURITY DEFINER RPCs (owner privileges) and service_role.
--
-- No function body, constraint or row changes. B1's month-key checks and F1's
-- current_company_id() are untouched.
--
-- DEPLOYMENT ORDER: the application code that calls these RPCs through the service role and
-- reads usage without writing it MUST be live before this migration is applied. That code is
-- compatible with the pre-migration grants; the previous code (authenticated RPC calls,
-- user-client usage upserts) is NOT compatible with this migration.

begin;

-- ── Quota RPCs: service_role only ───────────────────────────────────────────

revoke execute on function public.reserve_upload_quota(text,integer,integer,text,text) from public, anon, authenticated;
grant execute on function public.reserve_upload_quota(text,integer,integer,text,text) to service_role;

revoke execute on function public.commit_upload_quota(uuid,text) from public, anon, authenticated;
grant execute on function public.commit_upload_quota(uuid,text) to service_role;

revoke execute on function public.cancel_upload_quota(uuid,text) from public, anon, authenticated;
grant execute on function public.cancel_upload_quota(uuid,text) to service_role;

-- ── company_usage: clients read their own row, never write ──────────────────

drop policy "tenant access company_usage" on public.company_usage;

create policy "tenant read company_usage"
  on public.company_usage
  for select
  to authenticated
  using (current_company_id() = company_id);

revoke insert, update, delete, truncate, references, trigger on table public.company_usage from anon, authenticated;
revoke select on table public.company_usage from anon;

-- ── quota_reservations: clients read their own rows, never write ────────────

drop policy "tenant access quota_reservations" on public.quota_reservations;

create policy "tenant read quota_reservations"
  on public.quota_reservations
  for select
  to authenticated
  using (current_company_id() = company_id);

revoke insert, update, delete, truncate, references, trigger on table public.quota_reservations from anon, authenticated;
revoke select on table public.quota_reservations from anon;

commit;
