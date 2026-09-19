-- P2 Recommendation -> Decision terminal-integrity repair.
--
-- Forward-only hardening of public.record_operational_decision. Same signature, same
-- security model (SECURITY DEFINER, search_path = public), same grants. No table, index,
-- constraint, RLS policy or historical row is changed.
--
-- Normative lifecycle (20260611000000_operational_evidence_decision_loop.sql and
-- src/modules/workspace/presentation/command-center/attention-read-model.ts):
--   * terminal:     accepted | rejected | modified — one per Recommendation, ever
--                   (operational_decision_terminal_recommendation_uidx);
--   * non-terminal: escalated | needs_more_evidence — record a real Decision and leave the
--                   Recommendation `proposed`, so it stays open.
--
-- Two defects in the previous definition:
--   A. A second terminal Decision reached the INSERT and died on the partial unique index.
--      The raw 23505 carried the index name and surfaced from the API as a generic 500.
--   B. A non-terminal Decision recorded AFTER a terminal one was accepted and rewrote the
--      Recommendation back to `proposed`: a final Decision existed while the
--      Recommendation looked undecided again.
--
-- Repair: once the governed Recommendation is resolved, the caller serialises on its row
-- (SELECT ... FOR UPDATE) and any further Decision — terminal or not — is refused with the
-- stable domain signal `operational_decision_already_terminal`. The lock makes the check
-- race-free: concurrent callers queue on the row, and under READ COMMITTED each waiter
-- re-reads the committed state after the winner commits and is refused. The partial unique
-- index stays in place, untouched, as the last line of defence; if it ever fires anyway
-- (a writer outside this RPC), that violation is translated into the same domain signal
-- instead of leaking the index name.
--
-- Decision history is read newest-first by created_at. That column defaulted to now() — the
-- transaction START — so a non-terminal Decision that committed before a concurrent terminal
-- one could still sort after it. created_at is now stamped after the lock is held.
--
-- Manual-evidence Decisions (p_recommendation_id is null) have no Recommendation to close
-- and are unaffected.

create or replace function public.record_operational_decision(
  p_recommendation_id uuid,
  p_manual_evidence_item_id uuid,
  p_decision text,
  p_decision_status text,
  p_rationale text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.recommended_actions; g public.governance_events; r public.risk_issue_records; s public.operational_signals; e public.evidence_items;
  d public.operational_decision_records; authority jsonb; target_status text; authority_required text := 'baseline review';
  violated_constraint text;
begin
  if p_decision_status not in ('accepted','rejected','modified','escalated','needs_more_evidence') then raise exception 'invalid_decision_status'; end if;
  if nullif(trim(p_decision),'') is null or nullif(trim(p_rationale),'') is null then raise exception 'decision_and_rationale_required'; end if;

  if p_recommendation_id is not null then
    select * into a from public.recommended_actions where id=p_recommendation_id and governance_event_id is not null;
    if a.id is null then raise exception 'governed_recommendation_not_found'; end if;
    if not public.can_access_operational_project(a.workspace_id,a.project_id) then raise exception 'decision_access_denied'; end if;
    select * into g from public.governance_events where id=a.governance_event_id and related_entity_id=a.risk_issue_id;
    select * into r from public.risk_issue_records where id=a.risk_issue_id;
    select * into s from public.operational_signals where id=r.signal_id;
    select * into e from public.evidence_items where id=s.evidence_item_id;
    if g.id is null or r.id is null or s.id is null or e.id is null then raise exception 'governed_lineage_incomplete'; end if;
    if p_manual_evidence_item_id is not null and p_manual_evidence_item_id <> e.id then raise exception 'decision_evidence_lineage_mismatch'; end if;
    authority_required := g.authority_required;
  else
    select * into e from public.evidence_items where id=p_manual_evidence_item_id;
    if e.id is null or not public.can_access_operational_project(e.workspace_id,e.project_id) then raise exception 'manual_decision_evidence_not_found'; end if;
  end if;

  authority := public.operational_authority_evaluation(e.workspace_id,authority_required,p_decision_status);
  if not coalesce((authority->>'allowed')::boolean,false) then raise exception 'operational_decision_authority_denied:%',authority->>'reason'; end if;

  if a.id is not null then
    -- Serialise every Decision on this Recommendation, then re-read its committed state.
    select * into a from public.recommended_actions where id=a.id for update;
    -- A terminal Decision closes the Recommendation for good. Either signal is sufficient:
    -- the canonical terminal Decision row, or a Recommendation no longer `proposed`. The row
    -- check also covers a Recommendation reopened by the pre-repair defect.
    if a.status is distinct from 'proposed' or exists (
      select 1 from public.operational_decision_records x
      where x.recommendation_id=a.id and x.decision_status in ('accepted','rejected','modified')
    ) then
      raise exception 'operational_decision_already_terminal';
    end if;
  end if;

  begin
    -- created_at is taken AFTER the row lock (clock_timestamp, not the transaction-start
    -- now()), so the Decision history orders by the serialised commit order: a non-terminal
    -- Decision that won the lock before the terminal one can never sort after it.
    insert into public.operational_decision_records(workspace_id,project_id,recommendation_id,governance_event_id,decided_by,decision,decision_status,rationale,authority_basis,authority_evaluation,created_at)
    values(e.workspace_id,e.project_id,a.id,g.id,auth.uid(),trim(p_decision),p_decision_status,trim(p_rationale),authority->>'authority_basis',authority,clock_timestamp())
    returning * into d;
  exception when unique_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint = 'operational_decision_terminal_recommendation_uidx' then
      raise exception 'operational_decision_already_terminal';
    end if;
    raise;
  end;
  insert into public.decision_evidence_links(decision_record_id,evidence_item_id,link_reason,evidence_hash_at_decision,evidence_version_at_decision,evidence_title_snapshot,evidence_source_reference_snapshot)
  values(d.id,e.id,'Evidence derived from the governed recommendation lineage.',e.evidence_hash,e.version,e.title,e.source_reference);

  if a.id is not null then
    -- Only reachable while the Recommendation is still open, so a non-terminal Decision
    -- keeps it `proposed` and can never reopen a closed one.
    target_status := case when p_decision_status in ('escalated','needs_more_evidence') then 'proposed' else p_decision_status end;
    perform set_config('pmfreak.governed_decision_rpc','on',true);
    update public.recommended_actions set status=target_status,decision_reason=p_rationale,decided_by=auth.uid(),decided_at=d.created_at,updated_at=d.created_at where id=a.id;
  end if;
  return jsonb_build_object('decision',to_jsonb(d),'evidenceLinked',1,'authorityEvaluation',authority);
end $$;

-- CREATE OR REPLACE preserves the ACL; restated so the effective grant stays explicit
-- (20260910000000_security_definer_effective_grant_hardening.sql).
revoke execute on function public.record_operational_decision(uuid,uuid,text,text,text) from public, anon;
grant execute on function public.record_operational_decision(uuid,uuid,text,text,text) to authenticated, service_role;
