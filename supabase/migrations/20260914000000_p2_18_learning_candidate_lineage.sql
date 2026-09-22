-- =============================================================================
-- P2-18 — Learning Candidate Eligibility and Lineage.
--
-- WHY
--   P2-09's record_canonical_outcome_observation returns a
--   `canonical_outcome_learning_candidate.v1` payload with every Observation, but nothing
--   evaluates eligibility, persists it or emits it. P2-18 makes a complete canonical
--   outcome lineage able to create a scoped, NON-AUTHORITATIVE Learning Candidate
--   (PMFREAK_PRODUCT_BASELINE_V2: "Non-authoritative pattern hypothesis; pattern, cohort,
--   evidence, limitations, confidence, owner … no automatic elevation").
--
-- WHAT IT ADDS
--   canonical_learning_candidates        the hypothesis: one row per deterministic
--                                        pattern identity per project, holding bounded
--                                        summary fields only.
--   canonical_learning_candidate_sources the evidence membership: one row per qualifying
--                                        Observation, with relational references to the
--                                        canonical Outcome/Observation/Task/Execution/
--                                        Action/Governance/Decision/Recommendation/Finding/
--                                        Evidence. This table, not the aggregate, is
--                                        authoritative for lineage.
--   propose_canonical_learning_candidate an authenticated SECURITY DEFINER RPC that
--                                        derives eligibility, pattern identity, tier and
--                                        confidence from canonical rows alone, and in ONE
--                                        transaction writes the source link, the candidate
--                                        version and the platform event.
--
-- IDENTITY AND VERSIONING
--   candidate identity   (workspace, project, pattern_key); pattern_key is a digest of the
--                        exact typed classifiers already on the chain (Finding signal_type,
--                        Recommendation recommended_action_type, Action action_class). No
--                        free text, no fuzzy matching, no generalisation.
--   source identity      the qualifying Observation (unique per scope); at most one CURRENT
--                        source per Outcome. A newer Observation supersedes the previous
--                        source row; the old row is kept, never deleted.
--   version / digest     every material change (created, evidence linked, evidence
--                        superseded) increments `version` and recomputes `evidence_digest`
--                        over the current sources. A retry of the same Observation is a
--                        `duplicate`: no write, no event.
--
-- TIERS (structural descriptions of the evidence, never calibrated thresholds)
--   single_lineage                the current evidence traces to one Decision.
--   multiple_consistent_lineages  two or more structurally independent lineages (distinct
--                                 Decisions) that all record the same observed result.
--   conflicting_lineages          current sources record different observed results.
--   A tier never means "true", never implies review eligibility (P2-19 owns review) and is
--   never turned into a confidence score.
--
-- CONFIDENCE
--   The weakest recorded confidence among the current sources' Observations
--   (method `weakest_linked_observation:v1`). It states how certain the least certain
--   supporting Observation is; it is NOT a probability that the pattern holds.
--
-- CORRELATION VERSUS CAUSATION
--   Every lineage P2-18 can build is observational, so this function writes
--   causality_claim = 'correlation_only' itself and accepts no caller value. The column
--   carries no value constraint: the qualifier records current evidence capability, not a
--   universal rule for future candidates. Timing never implies causation.
--
-- RETENTION (no numeric TTL)
--   A source's `valid_until` is its Observation's own `stale_at` (nullable). Whether a
--   source is still current is derived on read from authoritative state (superseded,
--   Observation no longer latest, past valid_until, Evidence no longer current). Nothing
--   is deleted or rewritten; memory-tier and duration-based retention remain an owner
--   decision (baseline) and P2-19 scope.
--
-- TRUSTED WRITE BOUNDARY
--   The RPC is an ordinary authenticated SECURITY DEFINER function: the caller is
--   auth.uid(), authorised by can_write_operational_project — the same predicate that
--   gates record_canonical_outcome_observation, the operation that produces the reserved
--   candidate payload. It trusts no caller-supplied tier, pattern, confidence or lineage:
--   the caller names an Outcome and the Observation it evaluated, and everything else is
--   read from canonical rows. No service role is involved.
--
-- WHAT IT DOES NOT DO
--   No review, validation, rejection, elevation request, ratification, revocation,
--   organizational knowledge or AOC-E elevation (P2-19). `status` can only be 'proposed'.
--   It does not modify the P2-09 stub, any canonical chain row, or any existing learning
--   model (constitutional learning, organizational patterns, agent learning).
--
-- Forward-only and additive.
-- =============================================================================

create table if not exists public.canonical_learning_candidates (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null,
    project_id uuid not null,
    candidate_kind text not null default 'canonical_outcome_pattern'
        check (candidate_kind = 'canonical_outcome_pattern'),
    pattern_key text not null
        check (pattern_key ~ '^canonical-outcome-pattern:v1:[a-f0-9]{64}$'),
    pattern_signature jsonb not null
        check (
            jsonb_typeof(pattern_signature) = 'object'
            and pattern_signature ?& array['signalType', 'recommendedActionType', 'actionClass']
            and (pattern_signature - 'signalType' - 'recommendedActionType' - 'actionClass') = '{}'::jsonb
        ),
    -- P2-18 only ever proposes. Review/validation/rejection/elevation belong to P2-19.
    status text not null default 'proposed'
        check (status = 'proposed'),
    evidence_tier text not null
        check (evidence_tier in ('single_lineage', 'multiple_consistent_lineages', 'conflicting_lineages')),
    lineage_count integer not null check (lineage_count >= 1),
    independent_lineage_count integer not null
        check (independent_lineage_count >= 1 and independent_lineage_count <= lineage_count),
    result_counts jsonb not null
        check (
            jsonb_typeof(result_counts) = 'object'
            and (result_counts - 'achieved' - 'partial' - 'failed') = '{}'::jsonb
        ),
    confidence_score numeric(5,4) not null
        check (confidence_score >= 0 and confidence_score <= 1),
    confidence_method text not null
        check (confidence_method = 'weakest_linked_observation:v1'),
    causality_claim text not null
        check (length(btrim(causality_claim)) > 0),
    limitations text[] not null
        check (cardinality(limitations) between 1 and 8),
    version integer not null check (version >= 1),
    evidence_digest text not null
        check (evidence_digest ~ '^[a-f0-9]{64}$'),
    evaluator text not null
        check (evaluator = 'pmfreak/learning-candidate-eligibility:v1'),
    fixture_label text null
        check (fixture_label is null or fixture_label = 'DEMO / FIXTURE'),
    created_by uuid not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_evaluated_at timestamptz not null,
    last_evaluated_by uuid not null,
    constraint canonical_learning_candidates_scope_fk
        foreign key (workspace_id, project_id)
        references public.projects(workspace_id, id)
        on delete restrict,
    constraint canonical_learning_candidates_pattern_unique
        unique (workspace_id, project_id, pattern_key),
    constraint canonical_learning_candidates_scoped_id_unique
        unique (workspace_id, project_id, id)
);

comment on table public.canonical_learning_candidates is
'P2-18 Learning Candidate: a non-authoritative, project-local pattern hypothesis over canonical outcome lineages. Never organizational truth; never ratified here (P2-19). Bounded summary fields only; lineage membership lives in canonical_learning_candidate_sources.';
comment on column public.canonical_learning_candidates.evidence_tier is
'Structural description of the current evidence (single_lineage / multiple_consistent_lineages / conflicting_lineages). Not a confidence threshold, not a truth claim, not review eligibility.';
comment on column public.canonical_learning_candidates.causality_claim is
'Written by propose_canonical_learning_candidate. Every lineage P2-18 can build is observational, so the value is correlation_only; this reflects current evidence capability, not a universal rule.';
comment on column public.canonical_learning_candidates.confidence_score is
'Weakest recorded confidence among the current sources'' Observations (weakest_linked_observation:v1). Not a probability that the pattern holds.';

create table if not exists public.canonical_learning_candidate_sources (
    id uuid primary key default gen_random_uuid(),
    candidate_id uuid not null,
    workspace_id uuid not null,
    project_id uuid not null,
    outcome_id uuid not null references public.canonical_task_outcomes(id) on delete restrict,
    observation_id uuid not null references public.canonical_outcome_observations(id) on delete restrict,
    task_id uuid not null references public.execution_tasks(id) on delete restrict,
    internal_execution_id uuid not null references public.internal_task_executions(id) on delete restrict,
    action_id uuid not null references public.material_action_proposals(id) on delete restrict,
    governance_evaluation_id uuid not null references public.material_action_governance_evaluations(id) on delete restrict,
    decision_id uuid not null references public.operational_decision_records(id) on delete restrict,
    recommendation_id uuid not null references public.recommended_actions(id) on delete restrict,
    finding_id uuid not null references public.operational_signals(id) on delete restrict,
    finding_evidence_item_id uuid not null references public.evidence_items(id) on delete restrict,
    observation_evidence_ids uuid[] not null
        check (cardinality(observation_evidence_ids) >= 1),
    observed_result text not null
        check (observed_result in ('achieved', 'partial', 'failed')),
    observation_confidence numeric(5,4) not null
        check (observation_confidence >= 0 and observation_confidence <= 1),
    -- The Observation's own validity window; null when it has none. Never synthesised.
    valid_until timestamptz null,
    -- Lineage correlation/causation are carried per source, never on the aggregate.
    correlation_id text not null
        check (length(btrim(correlation_id)) > 0),
    causation_id text null,
    evaluated_at timestamptz not null,
    linked_by uuid not null,
    recorded_at timestamptz not null default now(),
    superseded_at timestamptz null,
    superseded_by_source_id uuid null,
    -- Deferred: the previous source is marked superseded by the new source's id just before
    -- that row is inserted, in the same transaction, so at most one source is ever current.
    constraint canonical_learning_candidate_sources_superseded_by_fk
        foreign key (superseded_by_source_id)
        references public.canonical_learning_candidate_sources(id)
        on delete restrict
        deferrable initially deferred,
    constraint canonical_learning_candidate_sources_candidate_fk
        foreign key (workspace_id, project_id, candidate_id)
        references public.canonical_learning_candidates(workspace_id, project_id, id)
        on delete restrict,
    constraint canonical_learning_candidate_sources_supersession_pair
        check ((superseded_at is null) = (superseded_by_source_id is null)),
    constraint canonical_learning_candidate_sources_observation_unique
        unique (workspace_id, project_id, observation_id)
);

-- At most one CURRENT source per Outcome: a concurrent retry cannot create two.
create unique index if not exists canonical_learning_candidate_sources_current_outcome_idx
    on public.canonical_learning_candidate_sources (workspace_id, project_id, outcome_id)
    where superseded_at is null;

create index if not exists canonical_learning_candidate_sources_candidate_idx
    on public.canonical_learning_candidate_sources (candidate_id, superseded_at, recorded_at desc);

create index if not exists canonical_learning_candidates_scope_idx
    on public.canonical_learning_candidates (workspace_id, project_id, updated_at desc);

comment on table public.canonical_learning_candidate_sources is
'P2-18 evidence membership of a Learning Candidate: one row per qualifying canonical Observation, with relational lineage references. Append-only except the one-time supersession mark; rows are never deleted.';
comment on column public.canonical_learning_candidate_sources.valid_until is
'The source Observation''s own stale_at. Null when the Observation records no validity window. No duration is synthesised.';

-- Provenance guard: candidates and sources are never deleted, and a source row may only
-- change once, to record its supersession. Applies to every role, including service_role.
create or replace function public.canonical_learning_candidate_provenance_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'learning_candidate_provenance_immutable';
    end if;
    if tg_table_name = 'canonical_learning_candidate_sources' then
        if old.superseded_at is not null
           or new.superseded_at is null
           or (to_jsonb(new) - 'superseded_at' - 'superseded_by_source_id')
              is distinct from (to_jsonb(old) - 'superseded_at' - 'superseded_by_source_id') then
            raise exception 'learning_candidate_provenance_immutable';
        end if;
    end if;
    if tg_table_name = 'canonical_learning_candidates' then
        if new.id <> old.id
           or new.workspace_id <> old.workspace_id
           or new.project_id <> old.project_id
           or new.pattern_key <> old.pattern_key
           or new.pattern_signature <> old.pattern_signature
           or new.created_by <> old.created_by
           or new.created_at <> old.created_at
           or new.version <> old.version + 1 then
            raise exception 'learning_candidate_provenance_immutable';
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists canonical_learning_candidates_provenance_guard on public.canonical_learning_candidates;
create trigger canonical_learning_candidates_provenance_guard
    before update or delete on public.canonical_learning_candidates
    for each row execute function public.canonical_learning_candidate_provenance_guard();

drop trigger if exists canonical_learning_candidate_sources_provenance_guard on public.canonical_learning_candidate_sources;
create trigger canonical_learning_candidate_sources_provenance_guard
    before update or delete on public.canonical_learning_candidate_sources
    for each row execute function public.canonical_learning_candidate_provenance_guard();

revoke all on function public.canonical_learning_candidate_provenance_guard() from public;

-- RLS: read-only for project members; every write goes through the RPC below.
alter table public.canonical_learning_candidates enable row level security;
alter table public.canonical_learning_candidate_sources enable row level security;

drop policy if exists canonical_learning_candidates_select on public.canonical_learning_candidates;
create policy canonical_learning_candidates_select
    on public.canonical_learning_candidates
    for select to authenticated
    using (public.can_access_operational_project(workspace_id, project_id));

drop policy if exists canonical_learning_candidate_sources_select on public.canonical_learning_candidate_sources;
create policy canonical_learning_candidate_sources_select
    on public.canonical_learning_candidate_sources
    for select to authenticated
    using (public.can_access_operational_project(workspace_id, project_id));

revoke insert, update, delete, truncate on public.canonical_learning_candidates from anon, authenticated;
revoke insert, update, delete, truncate on public.canonical_learning_candidate_sources from anon, authenticated;
grant select on public.canonical_learning_candidates to authenticated;
grant select on public.canonical_learning_candidate_sources to authenticated;

-- -----------------------------------------------------------------------------
-- propose_canonical_learning_candidate
--
-- The caller names the Outcome and the Observation it evaluated (stale-context guard) and
-- the explicit evaluation clock. Eligibility failures return disposition 'ineligible' with
-- every reason and write nothing. Authorization, scope and validation failures raise.
-- -----------------------------------------------------------------------------
create or replace function public.propose_canonical_learning_candidate(
    p_workspace_id uuid,
    p_project_id uuid,
    p_outcome_id uuid,
    p_observation_id uuid,
    p_evaluated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
    v_actor uuid;
    v_outcome public.canonical_task_outcomes%rowtype;
    v_observation public.canonical_outcome_observations%rowtype;
    v_latest_observation_id uuid;
    v_task public.execution_tasks%rowtype;
    v_execution public.internal_task_executions%rowtype;
    v_action public.material_action_proposals%rowtype;
    v_governance public.material_action_governance_evaluations%rowtype;
    v_decision public.operational_decision_records%rowtype;
    v_recommendation public.recommended_actions%rowtype;
    v_signal public.operational_signals%rowtype;
    v_finding_evidence public.evidence_items%rowtype;
    v_reasons text[] := array[]::text[];
    v_expected_outcome_state text;
    v_current_evidence integer;
    v_pattern_signature jsonb;
    v_pattern_key text;
    v_candidate public.canonical_learning_candidates%rowtype;
    v_candidate_created boolean := false;
    v_existing_source public.canonical_learning_candidate_sources%rowtype;
    v_previous_source public.canonical_learning_candidate_sources%rowtype;
    v_has_previous boolean := false;
    v_source public.canonical_learning_candidate_sources%rowtype;
    v_new_source_id uuid := gen_random_uuid();
    v_before jsonb;
    v_lineage_count integer;
    v_independent_count integer;
    v_distinct_results integer;
    v_result_counts jsonb;
    v_confidence numeric(5,4);
    v_digest text;
    v_tier text;
    v_limitations text[];
    v_transition text;
    v_event_id uuid;
begin
    v_actor := auth.uid();
    if v_actor is null then
        raise exception 'unauthenticated';
    end if;
    if p_workspace_id is null or p_project_id is null or p_outcome_id is null
       or p_observation_id is null or p_evaluated_at is null then
        raise exception 'learning_candidate_payload_invalid';
    end if;
    if not public.can_write_operational_project(p_workspace_id, p_project_id) then
        raise exception 'learning_candidate_write_denied';
    end if;
    if p_evaluated_at > now() + interval '5 minutes' then
        raise exception 'learning_candidate_evaluated_at_future';
    end if;

    select * into v_outcome
    from public.canonical_task_outcomes
    where id = p_outcome_id and workspace_id = p_workspace_id and project_id = p_project_id;
    if not found then
        raise exception 'learning_candidate_outcome_not_found';
    end if;

    select * into v_observation
    from public.canonical_outcome_observations
    where id = p_observation_id and outcome_id = v_outcome.id
      and workspace_id = p_workspace_id and project_id = p_project_id;
    if not found then
        raise exception 'learning_candidate_observation_not_found';
    end if;
    if p_evaluated_at < v_observation.recorded_at then
        raise exception 'learning_candidate_evaluated_at_before_observation';
    end if;

    -- ── Eligibility: every reason is collected; nothing is written if any applies ──
    if v_outcome.fixture_label is not null or v_observation.fixture_label is not null then
        v_reasons := array_append(v_reasons, 'lineage_fixture'::text);
    end if;
    if v_outcome.state = 'superseded' then
        v_reasons := array_append(v_reasons, 'outcome_superseded'::text);
    end if;

    -- Latest Observation, the same rule P2-10 applies (recorded_at desc), id as tiebreak.
    select o.id into v_latest_observation_id
    from public.canonical_outcome_observations o
    where o.outcome_id = v_outcome.id and o.workspace_id = p_workspace_id and o.project_id = p_project_id
    order by o.recorded_at desc, o.id desc
    limit 1;
    if v_latest_observation_id is distinct from v_observation.id then
        v_reasons := array_append(v_reasons, 'observation_not_latest'::text);
    end if;

    if v_observation.observation_state not in ('achieved', 'partial', 'failed') then
        v_reasons := array_append(v_reasons, 'observation_result_not_qualifying'::text);
    end if;
    v_expected_outcome_state := case v_observation.observation_state
        when 'achieved' then 'achieved'
        when 'partial' then 'partially_achieved'
        when 'failed' then 'not_achieved'
        else null end;
    if v_expected_outcome_state is not null and v_outcome.state <> v_expected_outcome_state
       and v_outcome.state <> 'superseded' then
        v_reasons := array_append(v_reasons, 'outcome_state_mismatch'::text);
    end if;
    -- The Outcome's WHOLE Observation history is judged as P2-10's lineage projection judges
    -- it: any disputed/inconclusive Observation makes the lineage disputed/inconclusive, any
    -- PARTIAL/UNKNOWN missing data leaves it incomplete, any fixture Observation marks it
    -- fixture. The database is never looser than the published projection.
    if exists (
        select 1 from public.canonical_outcome_observations o
        where o.outcome_id = v_outcome.id and o.workspace_id = p_workspace_id
          and o.project_id = p_project_id and o.observation_state = 'disputed'
    ) then
        v_reasons := array_append(v_reasons, 'lineage_disputed'::text);
    end if;
    if exists (
        select 1 from public.canonical_outcome_observations o
        where o.outcome_id = v_outcome.id and o.workspace_id = p_workspace_id
          and o.project_id = p_project_id and o.observation_state = 'inconclusive'
    ) then
        v_reasons := array_append(v_reasons, 'lineage_inconclusive'::text);
    end if;
    if exists (
        select 1 from public.canonical_outcome_observations o
        where o.outcome_id = v_outcome.id and o.workspace_id = p_workspace_id
          and o.project_id = p_project_id and o.missing_data_state <> 'COMPLETE'
    ) then
        v_reasons := array_append(v_reasons, 'observation_missing_data'::text);
    end if;
    if exists (
        select 1 from public.canonical_outcome_observations o
        where o.outcome_id = v_outcome.id and o.workspace_id = p_workspace_id
          and o.project_id = p_project_id and o.fixture_label is not null
    ) then
        v_reasons := array_append(v_reasons, 'lineage_fixture'::text);
    end if;
    if v_observation.stale_at is not null and v_observation.stale_at <= p_evaluated_at then
        v_reasons := array_append(v_reasons, 'observation_stale'::text);
    end if;

    -- The Observation's Evidence must still meet P2-09's own promotion rule at this clock.
    select count(distinct e.id) into v_current_evidence
    from public.evidence_items e
    where e.id = any(v_observation.evidence_reference_ids)
      and e.workspace_id = p_workspace_id
      and e.project_id = p_project_id
      and e.normalized_event_id is not null
      and e.fixture_state = 'LIVE'
      and e.freshness_state = 'CURRENT'
      and e.lifecycle = 'RECORDED'
      and e.rejection_reason is null
      and e.degraded_reason is null
      and e.evaluated_at is not null
      and (e.stale_at is null or e.stale_at > p_evaluated_at);
    if v_current_evidence <> (select count(distinct x) from unnest(v_observation.evidence_reference_ids) x) then
        v_reasons := array_append(v_reasons, 'observation_evidence_not_current'::text);
    end if;

    select * into v_task
    from public.execution_tasks
    where id = v_outcome.task_id and workspace_id = p_workspace_id and project_id = p_project_id;
    if not found then
        v_reasons := array_append(v_reasons, 'task_missing'::text);
    elsif v_task.status <> 'completed' then
        v_reasons := array_append(v_reasons, 'task_not_completed'::text);
    end if;

    select * into v_execution
    from public.internal_task_executions
    where id = v_outcome.internal_execution_id and task_id = v_outcome.task_id
      and workspace_id = p_workspace_id and project_id = p_project_id;
    if not found then
        v_reasons := array_append(v_reasons, 'execution_missing'::text);
    elsif v_execution.status <> 'completed' then
        v_reasons := array_append(v_reasons, 'execution_not_completed'::text);
    end if;

    select * into v_action
    from public.material_action_proposals
    where id = v_outcome.source_action_id and workspace_id = p_workspace_id and project_id = p_project_id;
    if not found then
        v_reasons := array_append(v_reasons, 'action_missing'::text);
    else
        if v_execution.id is not null and v_execution.source_action_id <> v_action.id then
            v_reasons := array_append(v_reasons, 'lineage_action_mismatch'::text);
        end if;
        if v_task.id is not null and coalesce(v_task.source_payload->>'sourceActionId', '') <> v_action.id::text then
            v_reasons := array_append(v_reasons, 'lineage_task_action_mismatch'::text);
        end if;
        -- Revocation is terminal: any denied/revoked evaluation disqualifies the lineage.
        if exists (
            select 1 from public.material_action_governance_evaluations g
            where g.action_id = v_action.id and g.governance_state in ('denied', 'revoked')
        ) then
            v_reasons := array_append(v_reasons, 'action_governance_revoked'::text);
        end if;
    end if;

    -- Governance is judged on the evaluation the execution was dispatched under (as P2-10 does).
    if v_execution.id is not null then
        select * into v_governance
        from public.material_action_governance_evaluations
        where id = v_execution.governance_evaluation_id and action_id = v_execution.source_action_id
          and workspace_id = p_workspace_id and project_id = p_project_id;
        if not found then
            v_reasons := array_append(v_reasons, 'governance_evaluation_missing'::text);
        elsif v_governance.governance_state not in ('authorized', 'not_required') then
            v_reasons := array_append(v_reasons, 'governance_not_authorized'::text);
        end if;
    end if;

    if v_action.id is not null then
        select * into v_decision
        from public.operational_decision_records
        where id = v_action.source_decision_id and workspace_id = p_workspace_id and project_id = p_project_id;
        if not found then
            v_reasons := array_append(v_reasons, 'decision_missing'::text);
        else
            if v_decision.decision_status not in ('accepted', 'modified') then
                v_reasons := array_append(v_reasons, 'decision_not_accepted'::text);
            end if;
            if exists (
                select 1 from public.operational_decision_records d
                where d.supersedes_decision_record_id = v_decision.id
            ) then
                v_reasons := array_append(v_reasons, 'decision_superseded'::text);
            end if;
        end if;
    end if;

    if v_decision.id is not null then
        select * into v_recommendation
        from public.recommended_actions
        where id = v_decision.recommendation_id and workspace_id = p_workspace_id and project_id = p_project_id;
        if not found then
            v_reasons := array_append(v_reasons, 'recommendation_missing'::text);
        end if;
    end if;

    if v_recommendation.id is not null then
        if coalesce(v_recommendation.source_signal_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            v_reasons := array_append(v_reasons, 'finding_missing'::text);
        else
            select * into v_signal
            from public.operational_signals
            where id = v_recommendation.source_signal_id::uuid
              and workspace_id = p_workspace_id and project_id = p_project_id;
            if not found then
                v_reasons := array_append(v_reasons, 'finding_missing'::text);
            end if;
        end if;
    end if;

    if v_signal.id is not null then
        select * into v_finding_evidence
        from public.evidence_items
        where id = v_signal.evidence_item_id and workspace_id = p_workspace_id and project_id = p_project_id;
        if not found then
            v_reasons := array_append(v_reasons, 'finding_evidence_missing'::text);
        else
            if v_finding_evidence.normalized_event_id is null then
                v_reasons := array_append(v_reasons, 'finding_evidence_not_canonical'::text);
            end if;
            if v_finding_evidence.fixture_state <> 'LIVE' then
                v_reasons := array_append(v_reasons, 'lineage_fixture'::text);
            end if;
            -- P2-10 treats stale or degraded Evidence as a degraded lineage.
            if v_finding_evidence.freshness_state = 'STALE' or v_finding_evidence.degraded_reason is not null then
                v_reasons := array_append(v_reasons, 'finding_evidence_degraded'::text);
            end if;
        end if;
    end if;

    if cardinality(v_reasons) > 0 then
        return jsonb_build_object(
            'disposition', 'ineligible',
            'reasons', to_jsonb(array(select distinct r from unnest(v_reasons) r order by r)),
            'candidate', null,
            'elevationInferred', false
        );
    end if;

    -- ── Pattern identity: exact typed classifiers, digested; never text ──
    v_pattern_signature := jsonb_build_object(
        'signalType', v_signal.signal_type,
        'recommendedActionType', v_recommendation.recommended_action_type,
        'actionClass', v_action.action_class
    );
    v_pattern_key := 'canonical-outcome-pattern:v1:' || encode(extensions.digest(
        v_signal.signal_type || '|' || v_recommendation.recommended_action_type || '|' || v_action.action_class,
        'sha256'), 'hex');

    -- Serialise every change to this hypothesis (candidate row, sources, version, event).
    perform pg_advisory_xact_lock(hashtextextended(
        'learning-candidate:' || p_workspace_id::text || ':' || p_project_id::text || ':' || v_pattern_key, 0));

    select * into v_candidate
    from public.canonical_learning_candidates
    where workspace_id = p_workspace_id and project_id = p_project_id and pattern_key = v_pattern_key
    for update;

    if found then
        select * into v_existing_source
        from public.canonical_learning_candidate_sources
        where workspace_id = p_workspace_id and project_id = p_project_id and observation_id = v_observation.id;
        if found then
            return jsonb_build_object(
                'disposition', 'duplicate',
                'candidate', to_jsonb(v_candidate),
                'source', to_jsonb(v_existing_source),
                'elevationInferred', false
            );
        end if;
        v_before := jsonb_build_object(
            'version', v_candidate.version,
            'evidenceTier', v_candidate.evidence_tier,
            'evidenceDigest', v_candidate.evidence_digest,
            'lineageCount', v_candidate.lineage_count
        );
    else
        v_candidate_created := true;
        v_before := null;
    end if;

    -- A newer Observation for an Outcome that already supports this hypothesis supersedes
    -- the previous source. The previous row is kept.
    select * into v_previous_source
    from public.canonical_learning_candidate_sources
    where workspace_id = p_workspace_id and project_id = p_project_id
      and outcome_id = v_outcome.id and superseded_at is null
    for update;
    v_has_previous := found;

    if v_candidate_created then
        -- A new hypothesis has exactly one source, so its summary is known before the source
        -- row exists; the digest uses the same formula as the recomputation below.
        insert into public.canonical_learning_candidates (
            workspace_id, project_id, pattern_key, pattern_signature, status, evidence_tier,
            lineage_count, independent_lineage_count, result_counts, confidence_score,
            confidence_method, causality_claim, limitations, version, evidence_digest,
            evaluator, fixture_label, created_by, last_evaluated_at, last_evaluated_by
        ) values (
            p_workspace_id, p_project_id, v_pattern_key, v_pattern_signature, 'proposed', 'single_lineage',
            1, 1, jsonb_build_object(v_observation.observation_state, 1), v_observation.confidence_score,
            'weakest_linked_observation:v1', 'correlation_only',
            array['correlation_only', 'structural_independence_only', 'confidence_is_weakest_observation', 'not_ratified'],
            1,
            encode(extensions.digest(
                v_outcome.id::text || ':' || v_observation.id::text || ':' || v_observation.observation_state,
                'sha256'), 'hex'),
            'pmfreak/learning-candidate-eligibility:v1', null, v_actor, p_evaluated_at, v_actor
        )
        returning * into v_candidate;
    end if;

    -- Supersede first, so the "one current source per Outcome" index is never violated.
    if v_has_previous then
        update public.canonical_learning_candidate_sources
        set superseded_at = now(), superseded_by_source_id = v_new_source_id
        where id = v_previous_source.id;
    end if;

    insert into public.canonical_learning_candidate_sources (
        id, candidate_id, workspace_id, project_id, outcome_id, observation_id, task_id,
        internal_execution_id, action_id, governance_evaluation_id, decision_id,
        recommendation_id, finding_id, finding_evidence_item_id, observation_evidence_ids,
        observed_result, observation_confidence, valid_until, correlation_id, causation_id,
        evaluated_at, linked_by
    ) values (
        v_new_source_id, v_candidate.id, p_workspace_id, p_project_id, v_outcome.id, v_observation.id, v_task.id,
        v_execution.id, v_action.id, v_governance.id, v_decision.id,
        v_recommendation.id, v_signal.id, v_finding_evidence.id, v_observation.evidence_reference_ids,
        v_observation.observation_state, v_observation.confidence_score, v_observation.stale_at,
        v_observation.correlation_id, v_observation.causation_id,
        p_evaluated_at, v_actor
    )
    returning * into v_source;

    v_transition := case
        when v_candidate_created then 'created'
        when v_has_previous then 'evidence_superseded'
        else 'evidence_linked' end;

    if not v_candidate_created then
    -- ── Recompute the bounded summary from the CURRENT sources only ──
    select count(*), count(distinct s.decision_id), count(distinct s.observed_result),
           min(s.observation_confidence),
           encode(extensions.digest(
               string_agg(s.outcome_id::text || ':' || s.observation_id::text || ':' || s.observed_result,
                          ',' order by s.outcome_id, s.observation_id),
               'sha256'), 'hex')
      into v_lineage_count, v_independent_count, v_distinct_results, v_confidence, v_digest
    from public.canonical_learning_candidate_sources s
    where s.candidate_id = v_candidate.id and s.superseded_at is null;

    select coalesce(jsonb_object_agg(r.observed_result, r.n), '{}'::jsonb) into v_result_counts
    from (
        select s.observed_result, count(*) as n
        from public.canonical_learning_candidate_sources s
        where s.candidate_id = v_candidate.id and s.superseded_at is null
        group by s.observed_result
    ) r;

    v_tier := case
        when v_distinct_results > 1 then 'conflicting_lineages'
        when v_independent_count >= 2 then 'multiple_consistent_lineages'
        else 'single_lineage' end;

    -- Bounded limitation codes; the statements live in the read contract.
    v_limitations := array['correlation_only', 'structural_independence_only', 'confidence_is_weakest_observation', 'not_ratified'];
    if v_lineage_count > v_independent_count then
        v_limitations := array_append(v_limitations, 'lineages_share_a_decision'::text);
    end if;
    if v_tier = 'conflicting_lineages' then
        v_limitations := array_append(v_limitations, 'conflicting_observed_results'::text);
    end if;

    update public.canonical_learning_candidates
    set evidence_tier = v_tier,
        lineage_count = v_lineage_count,
        independent_lineage_count = v_independent_count,
        result_counts = v_result_counts,
        confidence_score = v_confidence,
        limitations = v_limitations,
        version = v_candidate.version + 1,
        evidence_digest = v_digest,
        updated_at = now(),
        last_evaluated_at = p_evaluated_at,
        last_evaluated_by = v_actor
    where id = v_candidate.id
    returning * into v_candidate;
    end if;

    -- The candidate event, in the same transaction: if it fails, nothing above persists.
    insert into public.platform_events (
        workspace_id, project_id, actor_id, actor_type, event_type, event_category,
        event_payload, source, correlation_id, causation_id, visibility, sensitivity_level,
        learning_eligible, raw_reference_table, raw_reference_id, metadata, occurred_at
    ) values (
        p_workspace_id, p_project_id, v_actor, 'user', 'CANONICAL_OUTCOME_LEARNING_CANDIDATE_V1', 'learning',
        jsonb_build_object(
            'eventType', 'canonical_outcome_learning_candidate.v1',
            'eventVersion', 1,
            'transition', v_transition,
            'candidateId', v_candidate.id,
            'sourceId', v_source.id,
            'supersededSourceId', case when v_has_previous then v_previous_source.id else null end,
            'status', v_candidate.status,
            'patternKey', v_candidate.pattern_key,
            'patternSignature', v_candidate.pattern_signature,
            'evidenceTier', v_candidate.evidence_tier,
            'lineageCount', v_candidate.lineage_count,
            'independentLineageCount', v_candidate.independent_lineage_count,
            'resultCounts', v_candidate.result_counts,
            'confidence', jsonb_build_object('value', v_candidate.confidence_score, 'method', v_candidate.confidence_method, 'scale', 'unit_interval'),
            'causalityClaim', v_candidate.causality_claim,
            'limitations', to_jsonb(v_candidate.limitations),
            'before', v_before,
            'after', jsonb_build_object(
                'version', v_candidate.version,
                'evidenceTier', v_candidate.evidence_tier,
                'evidenceDigest', v_candidate.evidence_digest,
                'lineageCount', v_candidate.lineage_count
            ),
            'references', jsonb_build_object(
                'outcomeId', v_outcome.id,
                'observationId', v_observation.id,
                'taskId', v_task.id,
                'internalExecutionId', v_execution.id,
                'actionId', v_action.id,
                'governanceEvaluationId', v_governance.id,
                'decisionId', v_decision.id,
                'recommendationId', v_recommendation.id,
                'findingId', v_signal.id,
                'findingEvidenceItemId', v_finding_evidence.id,
                'observationEvidenceIds', to_jsonb(v_observation.evidence_reference_ids)
            ),
            'lineageCorrelationId', v_observation.correlation_id,
            'lineageCausationId', v_observation.causation_id,
            'observedAt', v_observation.observed_at,
            'evaluatedAt', p_evaluated_at,
            'evaluator', v_candidate.evaluator,
            'elevationInferred', false,
            'candidateIsNotOrganizationalTruth', true
        ),
        'user_action',
        -- Only a real canonical uuid correlation of the triggering Observation; never synthesised.
        case when v_observation.correlation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then v_observation.correlation_id::uuid else null end,
        null,
        'project', 'internal',
        -- A candidate is an OUTPUT of learning: it must not be re-extracted as pattern input.
        false,
        'canonical_learning_candidates', v_candidate.id,
        jsonb_build_object('correlationKind', 'correlation_not_causation', 'triggeringObservationId', v_observation.id),
        p_evaluated_at
    )
    returning id into v_event_id;

    return jsonb_build_object(
        'disposition', v_transition,
        'candidate', to_jsonb(v_candidate),
        'source', to_jsonb(v_source),
        'supersededSourceId', case when v_has_previous then v_previous_source.id else null end,
        'eventId', v_event_id,
        'elevationInferred', false
    );
end;
$$;

revoke all on function public.propose_canonical_learning_candidate(uuid, uuid, uuid, uuid, timestamptz) from public;
revoke execute on function public.propose_canonical_learning_candidate(uuid, uuid, uuid, uuid, timestamptz) from anon;
grant execute on function public.propose_canonical_learning_candidate(uuid, uuid, uuid, uuid, timestamptz) to authenticated;

comment on function public.propose_canonical_learning_candidate(uuid, uuid, uuid, uuid, timestamptz) is
'P2-18: evaluate one canonical outcome lineage and, if eligible, link it as evidence of a project-local Learning Candidate (status proposed). Authenticated; can_write_operational_project. Derives pattern, tier and confidence from canonical rows; writes the source link, candidate version and platform event atomically. Never ratifies, elevates or creates organizational knowledge.';
