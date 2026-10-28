-- F1 — tenant identity no longer read from user-editable metadata (PR-1).
--
-- 20260428120000_p0_state_tables.sql defined current_company_id() as
--   coalesce(auth.jwt() -> 'user_metadata' ->> 'company_id', auth.uid()::text)
-- and every legacy company-scoped RLS policy keys on it (company_subscriptions,
-- company_usage, quota_reservations, operational memory, governance_audit_events,
-- dashboard snapshots, ...). user_metadata is writable by the user through GoTrue
-- (auth.updateUser({ data })), so any signed-in user could name another company's id and
-- read, write or delete that company's rows.
--
-- The company id is now the authenticated user's own id — the value every account
-- already resolves to: no code path has ever written user_metadata.company_id, and the
-- application layer (src/lib/auth.ts, src/lib/feature-gates.ts) now derives it the same
-- way. No JWT (auth.uid() is null) still yields null, which matches no row.
--
-- Signature, return type, language, volatility and security (invoker) are unchanged, so
-- every dependent policy picks this up without being recreated, and CREATE OR REPLACE
-- preserves the existing ACL. No data is read, migrated or rewritten.
--
-- Workspace-membership authorization (workspace_memberships-based policies) does not use
-- this function and is unaffected. app_metadata (service-role writable only) is untouched.

begin;

create or replace function public.current_company_id()
returns text
language sql
stable
as $$
  select auth.uid()::text;
$$;

commit;
