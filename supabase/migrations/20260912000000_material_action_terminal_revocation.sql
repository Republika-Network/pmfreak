-- Terminal revocation for canonical Material Actions.
--
-- Replaces two functions and nothing else. No table, column, index, RLS policy,
-- trigger or grant semantics change; the grants below re-assert exactly what
-- 20260910000000_security_definer_effective_grant_hardening.sql already established,
-- so a CREATE OR REPLACE cannot silently widen them.
--
-- Defect this closes, reproduced deterministically on a disposable local stack:
--   * revoke the Action with a descriptive `evaluatedAt` that sorts before the
--     authorization, with the revocation committed and visible first;
--   * P2-07 `dispatch_governed_action_to_internal_task` returned 201 and created a
--     canonical Task for the revoked Action (a real Frontera ALLOW was minted);
--   * P2-08 `p2_08_validate_execution_governance` allowed `start` on the revoked
--     queued execution (HTTP 200 instead of 409).
--
-- Both boundaries now refuse on the EXISTENCE of a revoked evaluation for the exact
-- canonical scope (action, workspace, project, proposal digest), using each
-- boundary's existing denial vocabulary. Nothing else about governance selection,
-- idempotent Task replay, actor/digest/tenancy checks or execution transitions moves.

CREATE OR REPLACE FUNCTION public.dispatch_governed_action_to_internal_task(p_workspace_id uuid, p_project_id uuid, p_action_id uuid, p_expected_proposal_digest text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_action public.material_action_proposals;
  v_evaluation public.material_action_governance_evaluations;
  v_decision public.operational_decision_records;
  v_project public.projects;
  v_existing public.execution_tasks;
  v_task public.execution_tasks;
  v_priority text;
  v_title text;
  v_description text;
  v_source_payload jsonb;
begin
  if v_actor is null then
    raise exception 'action_task_unauthenticated';
  end if;

  if p_action_id is null or p_workspace_id is null or p_project_id is null then
    raise exception 'action_task_scope_required';
  end if;

  -- Scope is part of the lookup so wrong-tenant and wrong-project IDs do not
  -- expose whether the Action exists elsewhere.
  select *
    into v_action
    from public.material_action_proposals
   where id = p_action_id
     and workspace_id = p_workspace_id
     and project_id = p_project_id;

  if v_action.id is null then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'not_found',
      'reason', 'action_not_dispatchable'
    );
  end if;

  if not public.can_write_operational_project(v_action.workspace_id, v_action.project_id) then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'unauthorized',
      'reason', 'action_not_dispatchable'
    );
  end if;

  -- The P2-06 in-process grant is actor-scoped. Do not silently transfer it.
  if v_action.proposed_by <> v_actor then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'actor_mismatch',
      'reason', 'governed_action_actor_mismatch'
    );
  end if;

  if p_expected_proposal_digest is not null
     and p_expected_proposal_digest <> v_action.proposal_digest then
    return jsonb_build_object(
      'disposition', 'conflict',
      'failureClass', 'idempotency_conflict',
      'actionId', v_action.id,
      'proposalDigest', v_action.proposal_digest,
      'reason', 'action_task_proposal_digest_conflict'
    );
  end if;

  -- Serialize every dispatch attempt for one Action. Combined with the unique
  -- expression index this makes sequential and concurrent replay converge.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_action.workspace_id::text || ':action-task:' || v_action.id::text,
      0
    )
  );

  select *
    into v_existing
    from public.execution_tasks
   where workspace_id = v_action.workspace_id
     and source_payload ->> 'source' = 'governed_action'
     and source_payload ->> 'sourceActionId' = v_action.id::text
   limit 1;

  if v_existing.id is not null then
    insert into public.execution_task_events(
      workspace_id,
      project_id,
      task_id,
      event_type,
      event_payload,
      actor_user_id
    )
    values(
      v_existing.workspace_id,
      v_existing.project_id,
      v_existing.id,
      'governed_action_task_replayed',
      jsonb_build_object(
        'sourceActionId', v_action.id,
        'proposalDigest', v_action.proposal_digest,
        'correlationId', v_action.correlation_id,
        'causationId', v_action.causation_id,
        'idempotentReplay', true
      ),
      v_actor
    );

    return jsonb_build_object(
      'disposition', 'existing',
      'task', to_jsonb(v_existing),
      'sourceActionId', v_action.id,
      'idempotentReplay', true
    );
  end if;

  -- TERMINAL REVOCATION (P2-06 contract).
  --
  -- Revocation is terminal for THIS Action: the contract has no reauthorize,
  -- unrevoke or resurrect operation, and `revoke_governed_material_action` is itself
  -- replay-guarded. Recovery is a NEW Action, exactly as an expired authorization is
  -- recovered (P2-12 M2).
  --
  -- So it is asserted by EXISTENCE, never by recency. `evaluated_at` is a descriptive
  -- time supplied by the writer -- the revoke API accepts one from the caller, while a
  -- proposal's authorization is stamped separately server-side -- so it is not a
  -- monotonic database sequence and cannot order two independent transactions.
  -- Selecting governance by `order by evaluated_at desc` alone therefore let a
  -- committed, visible revocation be masked by an authorization that merely sorted
  -- newer: a revoked Action could still be dispatched into a canonical Task (P2-07)
  -- and a revoked queued execution could still start (P2-08). Existence of a revoked
  -- evaluation for this exact canonical scope now ends the question, whatever the
  -- timestamps say.
  if exists (
    select 1
    from public.material_action_governance_evaluations
    where action_id = v_action.id
      and workspace_id = v_action.workspace_id
      and project_id = v_action.project_id
      and proposal_digest = v_action.proposal_digest
      and governance_state = 'revoked'
  ) then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'governance_not_dispatchable',
      'governanceState', 'revoked',
      'reason', 'governed_action_not_dispatchable'
    );
  end if;

  -- Past the terminal check, the latest persisted evaluation is authoritative for
  -- every NON-terminal state (authorized, not_required, denied, degraded,
  -- unavailable, stale, requires_approval).
  select *
    into v_evaluation
    from public.material_action_governance_evaluations
   where action_id = v_action.id
     and workspace_id = v_action.workspace_id
     and project_id = v_action.project_id
     and proposal_digest = v_action.proposal_digest
   order by evaluated_at desc, recorded_at desc
   limit 1;

  if v_evaluation.id is null then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'governance_missing',
      'reason', 'governance_evaluation_missing'
    );
  end if;

  if v_action.expires_at <= pg_catalog.now() then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'expired',
      'governanceState', v_evaluation.governance_state,
      'reason', 'action_expired'
    );
  end if;

  if v_evaluation.valid_until is not null
     and v_evaluation.valid_until <= pg_catalog.now() then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'stale',
      'governanceState', v_evaluation.governance_state,
      'reason', 'governance_evaluation_stale'
    );
  end if;

  if not v_evaluation.can_commit_action
     or v_evaluation.governance_state not in ('authorized', 'not_required') then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'governance_not_dispatchable',
      'governanceState', v_evaluation.governance_state,
      'reason', 'governed_action_not_dispatchable'
    );
  end if;

  -- Authorized material work must retain the policy/grant evidence that made it
  -- allowable. Ordinary "not_required" work still carries any available refs.
  if v_evaluation.governance_state = 'authorized'
     and (
       v_evaluation.policy_decision_reference is null
       or coalesce(pg_catalog.array_length(v_evaluation.grant_references, 1), 0) = 0
     ) then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'governance_evidence_incomplete',
      'governanceState', v_evaluation.governance_state,
      'reason', 'policy_or_grant_reference_missing'
    );
  end if;

  select *
    into v_decision
    from public.operational_decision_records
   where id = v_action.source_decision_id
     and workspace_id = v_action.workspace_id
     and project_id = v_action.project_id
     and decision_status in ('accepted', 'modified');

  if v_decision.id is null then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'source_decision_ineligible',
      'reason', 'source_decision_ineligible'
    );
  end if;

  if not exists (
    select 1
      from public.decision_evidence_links l
     where l.decision_record_id = v_decision.id
  ) then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'lineage_incomplete',
      'reason', 'decision_evidence_lineage_missing'
    );
  end if;

  select *
    into v_project
    from public.projects
   where id = v_action.project_id
     and workspace_id = v_action.workspace_id;

  if v_project.id is null or v_project.status = 'archived' then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'project_not_dispatchable',
      'reason', 'project_not_dispatchable'
    );
  end if;

  if not exists (
    select 1
      from public.workspace_memberships wm
     where wm.workspace_id = v_action.workspace_id
       and wm.user_id = v_action.proposed_by
  ) then
    return jsonb_build_object(
      'disposition', 'denied',
      'failureClass', 'actor_not_member',
      'reason', 'governed_action_actor_not_workspace_member'
    );
  end if;

  v_priority := case v_action.proposal ->> 'risk'
    when 'critical' then 'critical'
    when 'high' then 'high'
    when 'low' then 'low'
    else 'medium'
  end;

  v_title := pg_catalog.left(
    coalesce(
      nullif(pg_catalog.btrim(v_action.proposal ->> 'intendedEffect'), ''),
      nullif(pg_catalog.btrim(v_action.proposal ->> 'actionType'), ''),
      'Governed action task'
    ),
    200
  );

  v_description := pg_catalog.concat_ws(
    E'\n\n',
    nullif('Operation: ' || coalesce(v_action.proposal ->> 'intendedOperation', ''), 'Operation: '),
    nullif('Effect: ' || coalesce(v_action.proposal ->> 'intendedEffect', ''), 'Effect: '),
    nullif('Justification: ' || coalesce(v_action.proposal ->> 'justification', ''), 'Justification: ')
  );

  v_source_payload := jsonb_build_object(
    'source', 'governed_action',
    'schemaVersion', 'pmfreak.action-to-task.v1',
    'sourceActionId', v_action.id,
    'sourceDecisionId', v_action.source_decision_id,
    'sourceRecommendationId', v_decision.recommendation_id,
    'proposalDigest', v_action.proposal_digest,
    'governanceEvaluationId', v_evaluation.id,
    'governanceState', v_evaluation.governance_state,
    'governanceContractVersion', v_evaluation.contract_version,
    'policyReference', v_evaluation.policy_decision_reference,
    'grantReferences', to_jsonb(v_evaluation.grant_references),
    'obligationReferences', to_jsonb(v_evaluation.obligation_references),
    'approvalReferences', to_jsonb(v_evaluation.approval_references),
    'evidenceReferences', coalesce(v_action.proposal -> 'evidenceReferenceIds', '[]'::jsonb),
    'proposedActorId', v_action.proposed_by,
    'accountableActorId', v_action.proposal ->> 'accountableActorId',
    'actionType', v_action.proposal ->> 'actionType',
    'intendedOperation', v_action.proposal ->> 'intendedOperation',
    'intendedEffect', v_action.proposal ->> 'intendedEffect',
    'justification', v_action.proposal ->> 'justification',
    'risk', v_action.proposal ->> 'risk',
    'correlationId', v_action.correlation_id,
    'causationId', v_action.causation_id,
    'actionCreatedAt', v_action.created_at,
    'governanceEvaluatedAt', v_evaluation.evaluated_at,
    'mappedAt', pg_catalog.now(),
    'authorizedDoesNotMeanExecuted', true,
    'taskCreatedDoesNotMeanOutcome', true
  );

  perform pg_catalog.set_config('pmfreak.p2_07_canonical_dispatch', '1', true);

  insert into public.execution_tasks(
    workspace_id,
    project_id,
    task_draft_id,
    recommended_action_id,
    raid_item_id,
    title,
    description,
    status,
    priority,
    owner_user_id,
    owner_name,
    due_date,
    acceptance_criteria,
    checklist,
    confidence_score,
    source_payload,
    created_by
  )
  values(
    v_action.workspace_id,
    v_action.project_id,
    null,
    v_decision.recommendation_id,
    null,
    v_title,
    coalesce(v_description, ''),
    'not_started',
    v_priority,
    v_action.proposed_by,
    null,
    null,
    '[]'::jsonb,
    '[]'::jsonb,
    null,
    v_source_payload,
    v_actor
  )
  returning * into v_task;

  insert into public.execution_task_events(
    workspace_id,
    project_id,
    task_id,
    event_type,
    event_payload,
    actor_user_id
  )
  values(
    v_task.workspace_id,
    v_task.project_id,
    v_task.id,
    'governed_action_task_created',
    jsonb_build_object(
      'sourceActionId', v_action.id,
      'sourceDecisionId', v_action.source_decision_id,
      'governanceEvaluationId', v_evaluation.id,
      'governanceState', v_evaluation.governance_state,
      'policyReference', v_evaluation.policy_decision_reference,
      'grantReferences', to_jsonb(v_evaluation.grant_references),
      'approvalReferences', to_jsonb(v_evaluation.approval_references),
      'proposalDigest', v_action.proposal_digest,
      'correlationId', v_action.correlation_id,
      'causationId', v_action.causation_id,
      'createdVsReplay', 'created',
      'executed', false,
      'outcomeCreated', false
    ),
    v_actor
  );

  return jsonb_build_object(
    'disposition', 'created',
    'task', to_jsonb(v_task),
    'sourceActionId', v_action.id,
    'governanceEvaluationId', v_evaluation.id,
    'governanceState', v_evaluation.governance_state,
    'nonExecution', jsonb_build_object(
      'taskCreated', true,
      'executed', false,
      'outcomeCreated', false,
      'observationCreated', false,
      'remoteAocWriteback', false
    )
  );
end;
$function$
;

revoke execute on function public.dispatch_governed_action_to_internal_task(uuid,uuid,uuid,text) from public, anon;
grant execute on function public.dispatch_governed_action_to_internal_task(uuid,uuid,uuid,text) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.p2_08_validate_execution_governance(p_task_id uuid, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_task public.execution_tasks;
  v_action public.material_action_proposals;
  v_evaluation public.material_action_governance_evaluations;
  v_action_id uuid;
begin
  select * into v_task
  from public.execution_tasks
  where id = p_task_id;

  if v_task.id is null then
    return jsonb_build_object('allowed', false, 'failureClass', 'not_found', 'reason', 'task_not_found');
  end if;

  if coalesce(v_task.source_payload ->> 'source', '') <> 'governed_action' then
    return jsonb_build_object('allowed', false, 'failureClass', 'not_governed', 'reason', 'internal_execution_requires_governed_task');
  end if;

  if not public.can_write_operational_project(v_task.workspace_id, v_task.project_id) then
    return jsonb_build_object('allowed', false, 'failureClass', 'unauthorized', 'reason', 'internal_execution_write_denied');
  end if;

  begin
    v_action_id := nullif(v_task.source_payload ->> 'sourceActionId', '')::uuid;
  exception when others then
    return jsonb_build_object('allowed', false, 'failureClass', 'lineage_invalid', 'reason', 'source_action_reference_invalid');
  end;

  select * into v_action
  from public.material_action_proposals
  where id = v_action_id
    and workspace_id = v_task.workspace_id
    and project_id = v_task.project_id;

  if v_action.id is null then
    return jsonb_build_object('allowed', false, 'failureClass', 'lineage_invalid', 'reason', 'source_action_not_found');
  end if;

  if v_action.proposed_by <> p_actor then
    return jsonb_build_object('allowed', false, 'failureClass', 'actor_mismatch', 'reason', 'governed_action_actor_mismatch');
  end if;

  -- TERMINAL REVOCATION (P2-06 contract).
  --
  -- Revocation is terminal for THIS Action: the contract has no reauthorize,
  -- unrevoke or resurrect operation, and `revoke_governed_material_action` is itself
  -- replay-guarded. Recovery is a NEW Action, exactly as an expired authorization is
  -- recovered (P2-12 M2).
  --
  -- So it is asserted by EXISTENCE, never by recency. `evaluated_at` is a descriptive
  -- time supplied by the writer -- the revoke API accepts one from the caller, while a
  -- proposal's authorization is stamped separately server-side -- so it is not a
  -- monotonic database sequence and cannot order two independent transactions.
  -- Selecting governance by `order by evaluated_at desc` alone therefore let a
  -- committed, visible revocation be masked by an authorization that merely sorted
  -- newer: a revoked Action could still be dispatched into a canonical Task (P2-07)
  -- and a revoked queued execution could still start (P2-08). Existence of a revoked
  -- evaluation for this exact canonical scope now ends the question, whatever the
  -- timestamps say.
  if exists (
    select 1
    from public.material_action_governance_evaluations
    where action_id = v_action.id
      and workspace_id = v_action.workspace_id
      and project_id = v_action.project_id
      and proposal_digest = v_action.proposal_digest
      and governance_state = 'revoked'
  ) then
    return jsonb_build_object(
      'allowed', false,
      'failureClass', 'governance_not_executable',
      'governanceState', 'revoked',
      'reason', 'governed_action_not_executable'
    );
  end if;

  select * into v_evaluation
  from public.material_action_governance_evaluations
  where action_id = v_action.id
    and workspace_id = v_action.workspace_id
    and project_id = v_action.project_id
    and proposal_digest = v_action.proposal_digest
  order by evaluated_at desc, recorded_at desc
  limit 1;

  if v_evaluation.id is null then
    return jsonb_build_object('allowed', false, 'failureClass', 'governance_missing', 'reason', 'governance_evaluation_missing');
  end if;

  if v_action.expires_at <= pg_catalog.now() then
    return jsonb_build_object(
      'allowed', false,
      'failureClass', 'expired',
      'governanceState', v_evaluation.governance_state,
      'reason', 'action_expired'
    );
  end if;

  if v_evaluation.valid_until is not null
     and v_evaluation.valid_until <= pg_catalog.now() then
    return jsonb_build_object(
      'allowed', false,
      'failureClass', 'stale',
      'governanceState', v_evaluation.governance_state,
      'reason', 'governance_evaluation_stale'
    );
  end if;

  if not v_evaluation.can_commit_action
     or v_evaluation.governance_state not in ('authorized','not_required') then
    return jsonb_build_object(
      'allowed', false,
      'failureClass', 'governance_not_executable',
      'governanceState', v_evaluation.governance_state,
      'reason', 'governed_action_not_executable'
    );
  end if;

  if v_evaluation.governance_state = 'authorized'
     and (
       v_evaluation.policy_decision_reference is null
       or coalesce(pg_catalog.array_length(v_evaluation.grant_references, 1), 0) = 0
     ) then
    return jsonb_build_object(
      'allowed', false,
      'failureClass', 'governance_evidence_incomplete',
      'governanceState', v_evaluation.governance_state,
      'reason', 'policy_or_grant_reference_missing'
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'workspaceId', v_task.workspace_id,
    'projectId', v_task.project_id,
    'taskId', v_task.id,
    'actionId', v_action.id,
    'governanceEvaluationId', v_evaluation.id,
    'governanceState', v_evaluation.governance_state,
    'proposalDigest', v_action.proposal_digest,
    'correlationId', v_action.correlation_id,
    'causationId', v_action.causation_id,
    'policyReference', v_evaluation.policy_decision_reference,
    'grantReferences', to_jsonb(v_evaluation.grant_references)
  );
end;
$function$
;

revoke execute on function public.p2_08_validate_execution_governance(uuid,uuid) from public, anon, authenticated;
grant execute on function public.p2_08_validate_execution_governance(uuid,uuid) to service_role;

comment on function public.dispatch_governed_action_to_internal_task(uuid,uuid,uuid,text) is 'P2-07 canonical Action-to-Task dispatch; a revoked Action is terminally non-dispatchable regardless of evaluation timestamps.';
comment on function public.p2_08_validate_execution_governance(uuid,uuid) is 'P2-08 execution governance gate; a revoked Action is terminally non-executable regardless of evaluation timestamps.';
