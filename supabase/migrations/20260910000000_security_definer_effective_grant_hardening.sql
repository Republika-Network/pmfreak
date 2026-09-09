-- ============================================================================
-- Gate-3 remediation: SECURITY DEFINER effective EXECUTE-grant hardening.
--
-- Forward-only. No historical migration is edited. Idempotent and re-runnable.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- PUBLIC, anon, authenticated and service_role are FOUR DISTINCT privilege
-- principals. On Supabase the platform bootstrap runs, in effect:
--
--     alter default privileges in schema public
--       grant execute on functions to anon, authenticated, service_role;
--
-- (certified verbatim by this repository's own STOCK_DEFAULT_ACL fixture in
-- scripts/check-fresh-db-migrations.mjs, which records
-- "anon=X/postgres,authenticated=X/postgres,..." for objtype "f" in schema
-- public). Every function created in schema public therefore receives its own
-- EXPLICIT per-role ACL entries for anon and authenticated, separate from the
-- PUBLIC pseudo-role entry.
--
-- Consequently:
--
--     revoke ... on function f() from public;   -- removes ONLY "=X/owner"
--                                               -- leaves anon=X/owner AND
--                                               -- authenticated=X/owner intact
--
-- 26 of the 30 canonical SECURITY DEFINER functions revoked only FROM PUBLIC.
-- The 4 that also revoked FROM anon (20260819000000, 20260828000000 and
-- 20260903000000 x2) are exactly the 4 that a live hosted Security Advisor run
-- against the freshly migrated canonical project did NOT flag. The hosted
-- findings (26 anon-executable, 28 authenticated-executable) are reproduced
-- exactly by replaying this migration chain from source, so they are the
-- designed-in result of the chain, not manual drift.
--
-- This repository had already identified the same mechanism for TABLES in
-- 20260826000000_fix_agent_attestation_nonces_grants.sql ("on a hosted
-- Supabase project, default privileges give anon/authenticated full DML on
-- newly created public tables ... Verified live"), and fixed it there with an
-- explicit "revoke ... from anon, authenticated". That insight was never
-- carried across to functions. This migration carries it across.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Declares the complete intended EXECUTE matrix for all 30 final SECURITY
-- DEFINER functions in schema public, as an explicit revoke-then-grant pair
-- per function, addressing every function by its exact identity signature.
-- The authority for this matrix is supabase/security/security-definer-grant-
-- matrix.json; scripts/check-security-definer-hardening.mjs reconstructs the
-- effective ACL from the whole migration chain and fails if the two disagree.
--
-- Final intended state:
--     SECURITY_DEFINER_TOTAL     = 30
--     PUBLIC_EXECUTABLE          = 0
--     ANON_EXECUTABLE            = 0
--     AUTHENTICATED_EXECUTABLE   = 23
--     SERVICE_ROLE_EXECUTABLE    = 30
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- --------------------------------------------
--   * It does not revoke authenticated from any of the 23 functions that
--     intentionally serve authenticated callers. Seven of those are RLS-policy
--     helpers whose authenticated EXECUTE is load-bearing: an RLS policy
--     expression is evaluated with the CALLER's privileges, so revoking them
--     would break tenant isolation rather than tighten it.
--   * It does not touch the 43 SECURITY INVOKER functions with an unpinned
--     search_path. That audit returned CRITICAL=0 (no SECURITY DEFINER
--     function has an unpinned search_path; all 30 pin it), so those are a
--     disjoint, non-blocking concern tracked as separate follow-up work.
--   * It does not enable RLS on public.agent_attestation_nonces, which is
--     intentionally service-role-only by design (20260826000000). Note that
--     the purge_expired_nonces revoke below is what actually closes the
--     SECURITY DEFINER bypass of that table's grant boundary.
-- ============================================================================

-- --------------------------------------------------------------------------
-- RLS-POLICY HELPERS — authenticated EXECUTE IS LOAD-BEARING (7)
-- --------------------------------------------------------------------------

-- public.can_access_operational_project(uuid,uuid)
-- RLS-policy helper referenced by 9 policy clauses. Policy expressions
-- evaluate with the CALLER's privileges, so authenticated EXECUTE is
-- load-bearing: revoking it breaks tenant isolation. Authorizes via
-- wm.user_id = auth.uid().
revoke execute on function public.can_access_operational_project(uuid,uuid) from public, anon;
grant execute on function public.can_access_operational_project(uuid,uuid) to authenticated, service_role;

-- public.can_write_operational_project(uuid,uuid)
-- RLS-policy helper referenced by 8 policy clauses, and the write-authority
-- gate used inside most SECURITY DEFINER RPCs. authenticated EXECUTE is
-- load-bearing. Chains can_access_operational_project with
-- operational_workspace_role in (owner,admin,pm).
revoke execute on function public.can_write_operational_project(uuid,uuid) from public, anon;
grant execute on function public.can_write_operational_project(uuid,uuid) to authenticated, service_role;

-- public.is_bridge_owner(uuid,uuid)
-- RLS-policy helper referenced by 6 policy clauses. authenticated EXECUTE is
-- load-bearing. Boolean membership check against auth.uid() with role in
-- (owner,admin,pm).
revoke execute on function public.is_bridge_owner(uuid,uuid) from public, anon;
grant execute on function public.is_bridge_owner(uuid,uuid) to authenticated, service_role;

-- public.is_decision_effectiveness_governor(uuid)
-- RLS-policy helper referenced by 2 policy clauses. authenticated EXECUTE is
-- load-bearing. Boolean membership check against auth.uid().
revoke execute on function public.is_decision_effectiveness_governor(uuid) from public, anon;
grant execute on function public.is_decision_effectiveness_governor(uuid) to authenticated, service_role;

-- public.is_organizational_memory_governor(uuid)
-- RLS-policy helper referenced by 2 policy clauses. authenticated EXECUTE is
-- load-bearing. Boolean membership check against auth.uid().
revoke execute on function public.is_organizational_memory_governor(uuid) from public, anon;
grant execute on function public.is_organizational_memory_governor(uuid) to authenticated, service_role;

-- public.is_organizational_pattern_governor(uuid)
-- RLS-policy helper referenced by 4 policy clauses. authenticated EXECUTE is
-- load-bearing. Boolean membership check against auth.uid().
revoke execute on function public.is_organizational_pattern_governor(uuid) from public, anon;
grant execute on function public.is_organizational_pattern_governor(uuid) to authenticated, service_role;

-- public.is_workspace_admin(uuid)
-- RLS-policy helper referenced by 3 policy clauses; introduced to break
-- workspace_memberships RLS recursion. authenticated EXECUTE is
-- load-bearing. Checks auth.uid() with role in (owner,admin).
revoke execute on function public.is_workspace_admin(uuid) from public, anon;
grant execute on function public.is_workspace_admin(uuid) to authenticated, service_role;

-- --------------------------------------------------------------------------
-- APPLICATION RPCs — intentionally callable by authenticated (16)
-- --------------------------------------------------------------------------

-- public.cancel_upload_quota(uuid,text)
-- Authenticated upload-quota RPC. Called from
-- src/lib/quota/upload-quota.ts:215 via createSupabaseServerClient
-- (authenticated). Re-validates p_company_id against the reservation row
-- before acting.
revoke execute on function public.cancel_upload_quota(uuid,text) from public, anon;
grant execute on function public.cancel_upload_quota(uuid,text) to authenticated, service_role;

-- public.capture_live_operational_input(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid,text)
-- Authenticated intake RPC
-- (src/lib/operational-flow/operational-flow-service.ts:147). Rejects
-- anonymous callers at the first statement: 'if v_actor is null then raise
-- exception intake_unauthenticated', then gates on
-- can_write_operational_project.
revoke execute on function public.capture_live_operational_input(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid,text) from public, anon;
grant execute on function public.capture_live_operational_input(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid,text) to authenticated, service_role;

-- public.capture_operational_input(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid,text)
-- Authenticated intake RPC (operational-flow-service.ts:111). Same
-- null-actor rejection then can_write_operational_project gate.
revoke execute on function public.capture_operational_input(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid,text) from public, anon;
grant execute on function public.capture_operational_input(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid,text) to authenticated, service_role;

-- public.commit_upload_quota(uuid,text)
-- Authenticated upload-quota RPC (upload-quota.ts:161). Re-validates
-- p_company_id against the reservation row.
revoke execute on function public.commit_upload_quota(uuid,text) from public, anon;
grant execute on function public.commit_upload_quota(uuid,text) to authenticated, service_role;

-- public.derive_operational_evidence(uuid,uuid,uuid,text,text,text,numeric,text,timestamptz,timestamptz)
-- Authenticated evidence-derivation RPC (operational-flow-service.ts:96).
-- Rejects anonymous callers with evidence_unauthenticated, then
-- evidence_access_denied via can_write_operational_project.
revoke execute on function public.derive_operational_evidence(uuid,uuid,uuid,text,text,text,numeric,text,timestamptz,timestamptz) from public, anon;
grant execute on function public.derive_operational_evidence(uuid,uuid,uuid,text,text,text,numeric,text,timestamptz,timestamptz) to authenticated, service_role;

-- public.dispatch_governed_action_to_internal_task(uuid,uuid,uuid,text)
-- Authenticated governed-action-to-task RPC
-- (operational-flow-service.ts:452). Rejects anonymous callers with
-- action_task_unauthenticated, then can_write_operational_project.
revoke execute on function public.dispatch_governed_action_to_internal_task(uuid,uuid,uuid,text) from public, anon;
grant execute on function public.dispatch_governed_action_to_internal_task(uuid,uuid,uuid,text) to authenticated, service_role;

-- public.dispatch_internal_task_execution(uuid)
-- Authenticated internal-execution RPC
-- (src/lib/execution-tasks/internal-execution-provider.ts:63, reached
-- through an API route using createSupabaseServerClient). Rejects anonymous
-- callers with internal_execution_unauthenticated.
revoke execute on function public.dispatch_internal_task_execution(uuid) from public, anon;
grant execute on function public.dispatch_internal_task_execution(uuid) to authenticated, service_role;

-- public.ensure_expected_task_outcome(uuid,uuid,uuid,text,jsonb,text,text)
-- Authenticated outcome-contract RPC (operational-flow-service.ts:505).
-- Null-actor rejection then can_write_operational_project.
revoke execute on function public.ensure_expected_task_outcome(uuid,uuid,uuid,text,jsonb,text,text) from public, anon;
grant execute on function public.ensure_expected_task_outcome(uuid,uuid,uuid,text,jsonb,text,text) to authenticated, service_role;

-- public.materialize_operational_chain(uuid)
-- Authenticated evidence-to-chain RPC (operational-flow-service.ts:158).
-- Gates on can_write_operational_project or raises operational_write_denied.
revoke execute on function public.materialize_operational_chain(uuid) from public, anon;
grant execute on function public.materialize_operational_chain(uuid) to authenticated, service_role;

-- public.persist_governed_material_action(jsonb,jsonb)
-- Authenticated governed-action RPC (operational-flow-service.ts:318).
-- Already correct on hosted: 20260903000000 revoked PUBLIC and anon
-- explicitly. Rejects anonymous callers with
-- material_action_unauthenticated.
revoke execute on function public.persist_governed_material_action(jsonb,jsonb) from public, anon;
grant execute on function public.persist_governed_material_action(jsonb,jsonb) to authenticated, service_role;

-- public.record_canonical_outcome_observation(uuid,uuid,uuid,text,text,uuid[],numeric,text,timestamptz,timestamptz,timestamptz,text,text,text)
-- Authenticated outcome-observation RPC (operational-flow-service.ts:557).
-- Null-actor rejection then can_write_operational_project.
revoke execute on function public.record_canonical_outcome_observation(uuid,uuid,uuid,text,text,uuid[],numeric,text,timestamptz,timestamptz,timestamptz,text,text,text) from public, anon;
grant execute on function public.record_canonical_outcome_observation(uuid,uuid,uuid,text,text,uuid[],numeric,text,timestamptz,timestamptz,timestamptz,text,text,text) to authenticated, service_role;

-- public.record_operational_chain_failure(uuid,text)
-- Authenticated chain-failure RPC (operational-flow-service.ts:160). Gates
-- on can_write_operational_project or raises operational_write_denied.
revoke execute on function public.record_operational_chain_failure(uuid,text) from public, anon;
grant execute on function public.record_operational_chain_failure(uuid,text) to authenticated, service_role;

-- public.record_operational_decision(uuid,uuid,text,text,text)
-- Authenticated human-decision RPC (operational-flow-service.ts:173). Gates
-- on can_access_operational_project and operational_authority_evaluation.
revoke execute on function public.record_operational_decision(uuid,uuid,text,text,text) from public, anon;
grant execute on function public.record_operational_decision(uuid,uuid,text,text,text) to authenticated, service_role;

-- public.reserve_upload_quota(text,integer,integer,text,text)
-- Authenticated upload-quota RPC (upload-quota.ts:90).
revoke execute on function public.reserve_upload_quota(text,integer,integer,text,text) from public, anon;
grant execute on function public.reserve_upload_quota(text,integer,integer,text,text) to authenticated, service_role;

-- public.revoke_governed_material_action(uuid,uuid,timestamptz,text)
-- Authenticated governed-action revocation RPC
-- (operational-flow-service.ts:483). Already correct on hosted:
-- 20260903000000 revoked PUBLIC and anon explicitly.
revoke execute on function public.revoke_governed_material_action(uuid,uuid,timestamptz,text) from public, anon;
grant execute on function public.revoke_governed_material_action(uuid,uuid,timestamptz,text) to authenticated, service_role;

-- public.transition_internal_task_execution(uuid,text)
-- Authenticated internal-execution transition RPC
-- (internal-execution-provider.ts:74). Rejects anonymous callers with
-- internal_execution_unauthenticated.
revoke execute on function public.transition_internal_task_execution(uuid,text) from public, anon;
grant execute on function public.transition_internal_task_execution(uuid,text) to authenticated, service_role;

-- --------------------------------------------------------------------------
-- SERVICE-ROLE-ONLY (3)
-- --------------------------------------------------------------------------

-- public.abuse_rate_limit_increment(text,text,timestamptz,jsonb)
-- Abuse rate-limit counter. Invoked only by the privileged server store
-- (src/lib/security/abuse-protection.ts createPrivilegedSupabaseClient).
-- Already correct on hosted: 20260819000000 revoked PUBLIC, anon and
-- authenticated explicitly.
revoke execute on function public.abuse_rate_limit_increment(text,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.abuse_rate_limit_increment(text,text,timestamptz,jsonb) to service_role;

-- public.founder_program_transition(uuid,text,text,text,uuid,text,text,boolean)
-- Founder-program state machine. Invoked only via
-- createSupabaseServiceRoleClient (src/lib/founder-program/db.ts:16).
-- Already correct on hosted: 20260828000000 revoked PUBLIC, anon and
-- authenticated explicitly.
revoke execute on function public.founder_program_transition(uuid,text,text,text,uuid,text,text,boolean) from public, anon, authenticated;
grant execute on function public.founder_program_transition(uuid,text,text,text,uuid,text,text,boolean) to service_role;

-- public.purge_expired_nonces()
-- SERVICE_ROLE / FUTURE CRON ONLY. Deletes expired rows from
-- public.agent_attestation_nonces. Has no internal authorization check of
-- any kind and zero call sites in src/. Because it is SECURITY DEFINER it
-- executes as the owner and therefore bypassed the table-level revoke that
-- 20260826000000 applied to agent_attestation_nonces; the anon grant made
-- that bypass reachable with only the publishable anon key. Direct client
-- EXECUTE denied.
revoke execute on function public.purge_expired_nonces() from public, anon, authenticated;
grant execute on function public.purge_expired_nonces() to service_role;

-- --------------------------------------------------------------------------
-- INTERNAL SECURITY-DEFINER-CALL-ONLY (3)
-- --------------------------------------------------------------------------

-- public.operational_authority_evaluation(uuid,text,text)
-- INTERNAL SECURITY-DEFINER-CALL-ONLY. Its primary legitimate invocation
-- path is from other SECURITY DEFINER functions
-- (record_operational_decision), which execute as the function owner and
-- therefore do not need a client-role grant. 20260611000000 revoked PUBLIC
-- and deliberately issued no grant. Direct client EXECUTE denied;
-- service_role EXECUTE retained for operational/administrative access.
revoke execute on function public.operational_authority_evaluation(uuid,text,text) from public, anon, authenticated;
grant execute on function public.operational_authority_evaluation(uuid,text,text) to service_role;

-- public.operational_workspace_role(uuid)
-- INTERNAL SECURITY-DEFINER-CALL-ONLY. Primary legitimate invocation path is
-- from other SECURITY DEFINER functions (can_write_operational_project,
-- persist_governed_material_action, revoke_governed_material_action), which
-- execute as the function owner. Zero RLS-policy references. 20260611000000
-- revoked PUBLIC and deliberately issued no grant. Direct client EXECUTE
-- denied; service_role EXECUTE retained.
revoke execute on function public.operational_workspace_role(uuid) from public, anon, authenticated;
grant execute on function public.operational_workspace_role(uuid) to service_role;

-- public.p2_08_validate_execution_governance(uuid,uuid)
-- INTERNAL SECURITY-DEFINER-CALL-ONLY. 20260905000000 states verbatim:
-- 'intentionally no authenticated grant: only the bounded SECURITY DEFINER
-- RPCs call it.' Primary legitimate invocation path is from
-- dispatch_internal_task_execution and transition_internal_task_execution.
-- Direct client EXECUTE denied; service_role EXECUTE retained.
revoke execute on function public.p2_08_validate_execution_governance(uuid,uuid) from public, anon, authenticated;
grant execute on function public.p2_08_validate_execution_governance(uuid,uuid) to service_role;

-- --------------------------------------------------------------------------
-- TRIGGER-ONLY (privilege hygiene, not an exploitable RPC) (1)
-- --------------------------------------------------------------------------

-- public.prepare_decision_evidence_link()
-- TRIGGER-ONLY. RETURNS TRIGGER, bound to trg_prepare_decision_evidence_link
-- (BEFORE INSERT on public.decision_evidence_links). PostgreSQL refuses
-- direct invocation of a trigger function regardless of EXECUTE ('trigger
-- functions can only be called as triggers'), and PostgREST excludes
-- trigger-returning functions from the /rpc/ surface entirely, so the
-- historical PUBLIC grant was never a callable privilege boundary. Revoked
-- here as privilege hygiene, NOT as remediation of an exploitable RPC.
-- Trigger execution is unaffected: triggers run as the table owner and do
-- not consult the client role's EXECUTE privilege.
revoke execute on function public.prepare_decision_evidence_link() from public, anon, authenticated;
grant execute on function public.prepare_decision_evidence_link() to service_role;

