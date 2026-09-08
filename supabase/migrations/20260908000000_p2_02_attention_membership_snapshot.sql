-- ============================================================================
-- CODEX-P2-02 — the attention snapshot needs a MEMBERSHIP token, not a clock.
--
-- `get_operational_assurance_summary` already returns `asOf` (= now(), i.e.
-- transaction_timestamp()) and `openRecommendations` from a single statement.
-- Consumers froze the attention root against those two values by filtering
-- `created_at <= asOf AND updated_at <= asOf`, and compared cardinality.
--
-- That is not a snapshot. `now()` is a wall-clock reading, not a token of MVCC
-- visibility. A transaction that BEGINS before `asOf` stamps its rows with
-- timestamps that predate `asOf`, yet may COMMIT after the assurance statement
-- took its snapshot — so such a row was never counted, and still satisfies the
-- timestamp predicate for every later read. Combined with a counted row closing
-- after the snapshot, a later read can load a SUBSTITUTED set of equal size:
--
--     snapshot   = { A, C, D }        (counted)
--     later read = { B, C, D }        (B committed late; A closed late)
--     |loaded| = |counted|, but loaded != counted.
--
-- Equal cardinality therefore does not prove equal membership. The fix is to
-- have the database name the members in the same statement that establishes
-- the count and the instant, so membership is decided by canonical identity
-- under one snapshot instead of by a timestamp range any later committer can
-- still satisfy.
--
-- This migration adds ONE key, `openRecommendationIds`, computed with exactly
-- the predicates `openRecommendations` already counts. Nothing else about the
-- function changes: same signature, same `stable security invoker`, same pinned
-- `search_path`, same access check, same existing keys. No table, column,
-- policy, trigger, decision semantics or authorization semantics are touched.
--
-- The id set is deliberately NOT capped in SQL. A silent cap would truncate
-- authoritative membership while still looking authoritative; consumers apply
-- their own explicit ceiling, and exceeding it makes completeness UNPROVEN
-- rather than truncating a set they then call complete.
-- ============================================================================

create or replace function public.get_operational_assurance_summary(p_workspace_id uuid,p_project_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare result jsonb;
begin
  if not public.can_access_operational_project(p_workspace_id,p_project_id) then raise exception 'assurance_access_denied'; end if;
  select jsonb_build_object(
    'scope','project','workspaceId',p_workspace_id,'projectId',p_project_id,'asOf',now(),
    'totalGovernanceEvents',(select count(*) from public.governance_events where workspace_id=p_workspace_id and project_id=p_project_id),
    'decisionRequiredCount',(select count(*) from public.governance_events where workspace_id=p_workspace_id and project_id=p_project_id and governance_status='decision_required'),
    'violationsCount',(select count(*) from public.governance_events where workspace_id=p_workspace_id and project_id=p_project_id and governance_status='violation'),
    'openRecommendations',(select count(*) from public.recommended_actions where workspace_id=p_workspace_id and project_id=p_project_id and governance_event_id is not null and status='proposed'),
    -- The authoritative membership set for that same count, from the same statement
    -- snapshot. Ordered so the projection is deterministic across reads.
    'openRecommendationIds',(select coalesce(jsonb_agg(r.id order by r.created_at desc, r.id asc),'[]'::jsonb) from public.recommended_actions r where r.workspace_id=p_workspace_id and r.project_id=p_project_id and r.governance_event_id is not null and r.status='proposed'),
    'unresolvedRisksIssues',(select count(*) from public.risk_issue_records where workspace_id=p_workspace_id and project_id=p_project_id and status not in ('resolved','closed')),
    'evidenceLinkedDecisionsCount',(select count(distinct d.id) from public.operational_decision_records d join public.decision_evidence_links l on l.decision_record_id=d.id where d.workspace_id=p_workspace_id and d.project_id=p_project_id),
    'evidenceWithoutSignalCount',(select count(*) from public.evidence_items e where e.workspace_id=p_workspace_id and e.project_id=p_project_id and not exists(select 1 from public.operational_signals s where s.evidence_item_id=e.id)),
    'incompleteChainCount',(select count(*) from public.operational_signals s where s.workspace_id=p_workspace_id and s.project_id=p_project_id and not exists(
      select 1 from public.risk_issue_records r join public.governance_events g on g.related_entity_id=r.id join public.recommended_actions a on a.governance_event_id=g.id and a.risk_issue_id=r.id where r.signal_id=s.id
    ))
  ) into result;
  return result;
end $$;

-- `create or replace` preserves the existing ACL; these are re-issued so a fresh
-- apply of this file alone lands the same grants the original migration set.
revoke all on function public.get_operational_assurance_summary(uuid,uuid) from public;
grant execute on function public.get_operational_assurance_summary(uuid,uuid) to authenticated;
