-- B1 — company_usage.current_month rejected every real month key.
--
-- 20260428120000_p0_state_tables.sql declared
--   check (current_month ~ '^\\d{4}-\\d{2}$')
-- With standard_conforming_strings = on (the default, and the setting on production)
-- '\\' in a plain string literal is two backslashes, so the regex demanded a literal
-- backslash and rejected 'YYYY-MM'. No company_usage row could ever be created, and
-- reserve_upload_quota — which inserts the usage row before reserving — failed for every
-- company, so uploads and usage initialization always errored.
--
-- quota_reservations.month_key (20260518000000_quota_atomicity.sql) was written correctly
-- as '^\d{4}-\d{2}$'. reserve_upload_quota writes the SAME p_month_key into both tables,
-- so both now share one explicit, month-validated pattern: four ASCII digits, a hyphen,
-- and a month 01–12. `[0-9]` is used instead of `\d` so the expression cannot depend on
-- string-literal escaping again.
--
-- The constraints are dropped by exact name WITHOUT `if exists`: if a target ever drifted
-- from the expected definition this migration must fail loudly rather than add a second
-- check beside an unknown one. Production preflight (P0) confirmed both names exist and
-- company_usage is empty, so the re-added checks validate trivially there.

begin;

alter table public.company_usage
  drop constraint company_usage_current_month_check,
  add constraint company_usage_current_month_check
    check (current_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

alter table public.quota_reservations
  drop constraint quota_reservations_month_key_check,
  add constraint quota_reservations_month_key_check
    check (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

commit;
