-- =============================================================================
-- P2-19 — Governed Ratification, Revocation and Learning Review (Project scope).
--
-- WHY
--   P2-18 persists non-authoritative Learning Candidates (status 'proposed' only). Nothing
--   can review them, turn one into governed knowledge, or withdraw that knowledge. P2-19
--   adds the smallest governed path:
--
--       P2-18 Learning Candidate  →  terminal review  →  Project-scoped ratified knowledge
--                                                     →  revocation
--
--   The Candidate is never mutated into knowledge: what was proposed stays distinct from
--   what governance decided about it. `canonical_learning_candidates.status` stays
--   'proposed'; review state lives here.
--
-- WHAT IT ADDS
--   canonical_learning_candidate_reviews   one TERMINAL review ('ratified' | 'rejected') per
--                                          exact (candidate_id, candidate_version,
--                                          candidate_evidence_digest). Never updated,
--                                          never deleted.
--   canonical_project_knowledge_records    ratified, Project-scoped knowledge: bounded
--                                          content copied from the reviewed Candidate
--                                          version, provenance references, an explicit
--                                          validity choice and a one-way revocation.
--   ratify_canonical_learning_candidate    authenticated SECURITY DEFINER commands; the only
--   reject_canonical_learning_candidate    writers. Each writes its rows and its platform
--   revoke_canonical_project_knowledge     event in ONE transaction.
--   retrieve_project_knowledge             the authoritative read (SECURITY INVOKER, RLS):
--                                          active, in-scope, unexpired, non-fixture only.
--
-- AUTHORITY (owner decisions ratified for P2-19)
--   The application evaluates the PMFreak in-process governance actions knowledge.ratify /
--   knowledge.reject / knowledge.revoke (required permission manage_workspace, users only,
--   never agents or system actors) BEFORE calling these commands, and passes the ALLOW
--   decision reference. As P2-06 does for Material Actions, the database independently
--   re-derives the same authority projection — the caller (auth.uid()) is an owner or admin
--   member of the Candidate's Workspace, the roles holding manage_workspace — and refuses a
--   decision reference that does not state ALLOW for the exact action. A direct RPC call
--   therefore cannot exceed the authority the governance runtime would grant. The decision
--   reference itself is attested by the application layer (the in-process runtime has no
--   persisted decision to join against); it is recorded verbatim for audit.
--   There is no four-eyes rule: the reviewer may be the Candidate's creator. Both identities
--   are recorded and `reviewer_is_candidate_creator` keeps that visible; nothing here labels
--   a review "independent".
--
-- SCOPE AND APPLICABILITY
--   Project only. applicability_scope is fixed to 'source_project' (the Candidate's own
--   workspace_id/project_id). No Workspace/Enterprise elevation, no cross-Workspace read path.
--
-- STALE REVIEW
--   A reviewer acts on (candidateId, version, evidenceDigest). Under the Candidate row lock
--   (which serialises against P2-18's own evidence updates) a mismatch returns
--   'stale_review' and writes nothing. Ratification additionally requires the Candidate to be
--   operationally supported NOW: the sources valid at the database clock (P2-18's validity
--   predicate) must be non-empty and must digest to exactly the reviewed evidence_digest, so
--   a Candidate whose stored summary no longer describes current evidence cannot be ratified.
--
-- VALIDITY (no TTL)
--   The ratifier chooses explicitly: 'until_revoked' (effective_until null) or 'until_date'
--   (an explicit future effective_until). No default duration exists. Expiry is DERIVED at
--   read time (effective_until <= now()); no expiry transition is persisted.
--
-- REVOCATION
--   Terminal: active → revoked once. Content and provenance stay immutable; a revoked record
--   never becomes active again. Re-validating the same learning needs a new Candidate
--   version, a new review and a new record.
--
-- NOT IN P2-19
--   Correction/supersession of knowledge, Workspace elevation, Enterprise Intelligence,
--   cross-Workspace consent, memory tiers, automatic promotion. At most one ACTIVE record
--   exists per Candidate; ratifying a newer Candidate version while one is active is refused
--   ('already_ratified') until that record is revoked. The generic Material Action
--   knowledge_elevation class stays hard-denied (P2-06); this is a separate path.
--
-- Forward-only and additive.
-- =============================================================================

create table if not exists public.canonical_learning_candidate_reviews (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null,
    project_id uuid not null,
    candidate_id uuid not null,
    candidate_version integer not null check (candidate_version >= 1),
    candidate_evidence_digest text not null
        check (candidate_evidence_digest ~ '^[a-f0-9]{64}$'),
    review_outcome text not null
        check (review_outcome in ('ratified', 'rejected')),
    -- The attributable reviewer (auth.uid() inside the command) and the role it held.
    reviewed_by uuid not null,
    reviewer_role text not null
        check (reviewer_role in ('owner', 'admin')),
    reviewed_at timestamptz not null,
    -- Who created / last evaluated the Candidate, copied so lineage shows every actor.
    candidate_created_by uuid not null,
    candidate_last_evaluated_by uuid not null,
    reviewer_is_candidate_creator boolean not null,
    -- The bounded Candidate state the reviewer acted on (never Evidence payloads).
    reviewed_summary jsonb not null
        check (jsonb_typeof(reviewed_summary) = 'object'),
    causality_claim text not null
        check (length(btrim(causality_claim)) > 0),
    limitations text[] not null
        check (cardinality(limitations) between 1 and 8),
    rationale text not null
        check (char_length(btrim(rationale)) between 1 and 8000),
    governance_action text not null
        check (governance_action in ('knowledge.ratify', 'knowledge.reject')),
    governance_decision_id text not null
        check (char_length(btrim(governance_decision_id)) between 1 and 200),
    governance_decision_state text not null
        check (governance_decision_state = 'allow'),
    governance_contract text not null
        check (governance_contract = 'pmfreak.aoc-e.in-process-governance.v1'),
    governance_evaluated_at timestamptz not null,
    fixture_label text null
        check (fixture_label is null or fixture_label = 'DEMO / FIXTURE'),
    recorded_at timestamptz not null default now(),
    constraint canonical_learning_candidate_reviews_outcome_action
        check ((review_outcome = 'ratified') = (governance_action = 'knowledge.ratify')),
    constraint canonical_learning_candidate_reviews_candidate_fk
        foreign key (workspace_id, project_id, candidate_id)
        references public.canonical_learning_candidates(workspace_id, project_id, id)
        on delete restrict,
    -- ONE terminal outcome per exact reviewed Candidate state: never both ratified and rejected.
    constraint canonical_learning_candidate_reviews_terminal_unique
        unique (candidate_id, candidate_version, candidate_evidence_digest),
    constraint canonical_learning_candidate_reviews_lineage_unique
        unique (workspace_id, project_id, id, candidate_id, candidate_version, candidate_evidence_digest, review_outcome)
);

create index if not exists canonical_learning_candidate_reviews_scope_idx
    on public.canonical_learning_candidate_reviews (workspace_id, project_id, candidate_id, reviewed_at desc);

comment on table public.canonical_learning_candidate_reviews is
'P2-19 terminal review of one exact Learning Candidate state (candidate_id, version, evidence_digest): ratified or rejected, never both. Written only by ratify/reject_canonical_learning_candidate; never updated or deleted. The Candidate itself stays status proposed.';
comment on column public.canonical_learning_candidate_reviews.reviewer_is_candidate_creator is
'True when the reviewer also created the Candidate. P2-19 has no four-eyes rule; this keeps the overlap visible. A review is never labelled independent.';
comment on column public.canonical_learning_candidate_reviews.governance_decision_id is
'The ALLOW decision reference of the PMFreak in-process governance action (knowledge.ratify / knowledge.reject), attested by the application layer and recorded verbatim.';

create table if not exists public.canonical_project_knowledge_records (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null,
    project_id uuid not null,
    candidate_id uuid not null,
    candidate_version integer not null check (candidate_version >= 1),
    candidate_evidence_digest text not null
        check (candidate_evidence_digest ~ '^[a-f0-9]{64}$'),
    review_id uuid not null,
    review_outcome text not null default 'ratified'
        check (review_outcome = 'ratified'),
    knowledge_kind text not null
        check (knowledge_kind = 'canonical_outcome_pattern'),
    pattern_key text not null
        check (pattern_key ~ '^canonical-outcome-pattern:v1:[a-f0-9]{64}$'),
    pattern_signature jsonb not null
        check (jsonb_typeof(pattern_signature) = 'object'),
    statement text not null
        check (char_length(btrim(statement)) between 1 and 2000),
    evidence_tier text not null
        check (evidence_tier in ('single_lineage', 'multiple_consistent_lineages', 'conflicting_lineages')),
    lineage_count integer not null check (lineage_count >= 1),
    independent_lineage_count integer not null
        check (independent_lineage_count >= 1 and independent_lineage_count <= lineage_count),
    result_counts jsonb not null
        check (jsonb_typeof(result_counts) = 'object'),
    confidence_score numeric(5,4) not null
        check (confidence_score >= 0 and confidence_score <= 1),
    confidence_method text not null
        check (confidence_method = 'weakest_linked_observation:v1'),
    causality_claim text not null
        check (length(btrim(causality_claim)) > 0),
    limitations text[] not null
        check (cardinality(limitations) between 1 and 10),
    -- The Candidate sources that were current at ratification (full lineage references live
    -- on those source rows).
    source_ids uuid[] not null
        check (cardinality(source_ids) >= 1),
    applicability_scope text not null
        check (applicability_scope = 'source_project'),
    status text not null
        check (status in ('active', 'revoked')),
    validity_mode text not null
        check (validity_mode in ('until_revoked', 'until_date')),
    effective_from timestamptz not null,
    effective_until timestamptz null,
    ratified_at timestamptz not null,
    ratified_by uuid not null,
    ratification_governance_decision_id text not null
        check (char_length(btrim(ratification_governance_decision_id)) between 1 and 200),
    version integer not null check (version >= 1),
    revoked_at timestamptz null,
    revoked_by uuid null,
    revocation_reason text null
        check (revocation_reason is null or char_length(btrim(revocation_reason)) between 1 and 8000),
    revocation_governance_decision_id text null
        check (revocation_governance_decision_id is null
               or char_length(btrim(revocation_governance_decision_id)) between 1 and 200),
    revocation_governance_evaluated_at timestamptz null,
    fixture_label text null
        check (fixture_label is null or fixture_label = 'DEMO / FIXTURE'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint canonical_project_knowledge_validity
        check ((validity_mode = 'until_revoked') = (effective_until is null)
               and (effective_until is null or effective_until > effective_from)),
    constraint canonical_project_knowledge_revocation_shape
        check (
            (status = 'active' and revoked_at is null and revoked_by is null and revocation_reason is null
                and revocation_governance_decision_id is null and revocation_governance_evaluated_at is null)
            or (status = 'revoked' and revoked_at is not null and revoked_by is not null and revocation_reason is not null
                and revocation_governance_decision_id is not null and revocation_governance_evaluated_at is not null)
        ),
    constraint canonical_project_knowledge_scope_fk
        foreign key (workspace_id, project_id)
        references public.projects(workspace_id, id)
        on delete restrict,
    constraint canonical_project_knowledge_candidate_fk
        foreign key (workspace_id, project_id, candidate_id)
        references public.canonical_learning_candidates(workspace_id, project_id, id)
        on delete restrict,
    -- Knowledge exists only for a RATIFIED review of the same exact Candidate state.
    constraint canonical_project_knowledge_review_fk
        foreign key (workspace_id, project_id, review_id, candidate_id, candidate_version, candidate_evidence_digest, review_outcome)
        references public.canonical_learning_candidate_reviews(workspace_id, project_id, id, candidate_id, candidate_version, candidate_evidence_digest, review_outcome)
        on delete restrict,
    constraint canonical_project_knowledge_review_unique unique (review_id),
    constraint canonical_project_knowledge_scoped_id_unique unique (workspace_id, project_id, id)
);

-- At most one ACTIVE knowledge record per Candidate (no supersession in P2-19).
create unique index if not exists canonical_project_knowledge_active_candidate_idx
    on public.canonical_project_knowledge_records (candidate_id)
    where status = 'active';

create index if not exists canonical_project_knowledge_scope_idx
    on public.canonical_project_knowledge_records (workspace_id, project_id, status, ratified_at desc);

comment on table public.canonical_project_knowledge_records is
'P2-19 ratified Project-scoped knowledge. Created only from a ratified review of an exact Learning Candidate state; applicability fixed to the source Project. Content and provenance are immutable; the only change is a one-way revocation. Expiry (effective_until) is derived at read time.';
comment on column public.canonical_project_knowledge_records.causality_claim is
'Copied from the ratified Candidate state. Human ratification does not establish causation: a correlation_only Candidate yields correlation_only knowledge.';

-- Guards: reviews are immutable; knowledge may only be revoked, once, touching only the
-- revocation fields. Applies to every role, including owner-level paths.
create or replace function public.canonical_project_knowledge_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'project_knowledge_immutable';
    end if;
    if tg_table_name = 'canonical_learning_candidate_reviews' then
        raise exception 'project_knowledge_immutable';
    end if;
    if old.status <> 'active'
       or new.status <> 'revoked'
       or new.version <> old.version + 1
       or (to_jsonb(new) - 'status' - 'version' - 'updated_at' - 'revoked_at' - 'revoked_by'
              - 'revocation_reason' - 'revocation_governance_decision_id' - 'revocation_governance_evaluated_at')
          is distinct from
          (to_jsonb(old) - 'status' - 'version' - 'updated_at' - 'revoked_at' - 'revoked_by'
              - 'revocation_reason' - 'revocation_governance_decision_id' - 'revocation_governance_evaluated_at') then
        raise exception 'project_knowledge_immutable';
    end if;
    return new;
end;
$$;

drop trigger if exists canonical_learning_candidate_reviews_guard on public.canonical_learning_candidate_reviews;
create trigger canonical_learning_candidate_reviews_guard
    before update or delete on public.canonical_learning_candidate_reviews
    for each row execute function public.canonical_project_knowledge_guard();

drop trigger if exists canonical_project_knowledge_records_guard on public.canonical_project_knowledge_records;
create trigger canonical_project_knowledge_records_guard
    before update or delete on public.canonical_project_knowledge_records
    for each row execute function public.canonical_project_knowledge_guard();

revoke all on function public.canonical_project_knowledge_guard() from public;

-- RLS: read-only for project members; every write goes through the commands below.
alter table public.canonical_learning_candidate_reviews enable row level security;
alter table public.canonical_project_knowledge_records enable row level security;

drop policy if exists canonical_learning_candidate_reviews_select on public.canonical_learning_candidate_reviews;
create policy canonical_learning_candidate_reviews_select
    on public.canonical_learning_candidate_reviews
    for select to authenticated
    using (public.can_access_operational_project(workspace_id, project_id));

drop policy if exists canonical_project_knowledge_records_select on public.canonical_project_knowledge_records;
create policy canonical_project_knowledge_records_select
    on public.canonical_project_knowledge_records
    for select to authenticated
    using (public.can_access_operational_project(workspace_id, project_id));

-- The P2-18 security model: no role — not even service_role, which bypasses RLS and receives
-- full DML through Supabase's default privileges — may write these tables directly. A direct
-- write could otherwise create knowledge without a review, an ALLOW decision, a version/digest
-- check or an event. SELECT stays for members (under RLS) and service_role (verification).
revoke all on public.canonical_learning_candidate_reviews from anon, authenticated, service_role;
revoke all on public.canonical_project_knowledge_records from anon, authenticated, service_role;
grant select on public.canonical_learning_candidate_reviews to authenticated, service_role;
grant select on public.canonical_project_knowledge_records to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Current support of a Candidate at a clock: the sources P2-18 would count now (not
-- superseded, still their Outcome's latest Observation, inside their own validity window,
-- every Evidence item still canonical-live) and the digest P2-18's formula gives them.
-- Internal: executable only by the owner (the commands below).
-- -----------------------------------------------------------------------------
create or replace function public.canonical_learning_candidate_current_support(p_candidate_id uuid, p_at timestamptz)
returns table (source_ids uuid[], source_count integer, evidence_digest text)
language sql
stable
set search_path = pg_catalog, public, extensions
as $$
    with valid as (
        select s.*
        from public.canonical_learning_candidate_sources s
        where s.candidate_id = p_candidate_id
          and s.superseded_at is null
          and (s.valid_until is null or s.valid_until > p_at)
          and s.observation_id = (
              select o.id from public.canonical_outcome_observations o
              where o.outcome_id = s.outcome_id and o.workspace_id = s.workspace_id and o.project_id = s.project_id
              order by o.recorded_at desc, o.id desc
              limit 1)
          and not exists (
              select 1 from unnest(s.observation_evidence_ids) as ref(evidence_id)
              where not exists (
                  select 1 from public.evidence_items e
                  where e.id = ref.evidence_id
                    and e.workspace_id = s.workspace_id
                    and e.project_id = s.project_id
                    and e.normalized_event_id is not null
                    and e.fixture_state = 'LIVE'
                    and e.freshness_state = 'CURRENT'
                    and e.lifecycle = 'RECORDED'
                    and e.rejection_reason is null
                    and e.degraded_reason is null
                    and e.evaluated_at is not null
                    and (e.stale_at is null or e.stale_at > p_at)))
    )
    select coalesce(array_agg(v.id order by v.outcome_id, v.observation_id), array[]::uuid[]),
           count(*)::integer,
           case when count(*) = 0 then null else encode(extensions.digest(
               string_agg(v.outcome_id::text || ':' || v.observation_id::text || ':' || v.observed_result,
                          ',' order by v.outcome_id, v.observation_id),
               'sha256'), 'hex') end
    from valid v
$$;

revoke all on function public.canonical_learning_candidate_current_support(uuid, timestamptz) from public, anon, authenticated, service_role;

-- Governance projection shared by the three commands: the application's ALLOW decision for
-- the exact action, plus the database's own re-derivation of manage_workspace (owner/admin).
create or replace function public.canonical_project_knowledge_assert_authority(
    p_workspace_id uuid,
    p_project_id uuid,
    p_expected_action text,
    p_governance jsonb
)
returns text
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
    v_role text;
begin
    if auth.uid() is null then
        raise exception 'unauthenticated';
    end if;
    if not public.can_access_operational_project(p_workspace_id, p_project_id) then
        raise exception 'project_knowledge_scope_denied';
    end if;
    v_role := public.operational_workspace_role(p_workspace_id);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'project_knowledge_authority_denied';
    end if;
    if p_governance is null or jsonb_typeof(p_governance) <> 'object'
       or p_governance->>'action' is distinct from p_expected_action
       or p_governance->>'decision' is distinct from 'allow'
       or p_governance->>'contract' is distinct from 'pmfreak.aoc-e.in-process-governance.v1'
       or char_length(btrim(coalesce(p_governance->>'decisionId', ''))) not between 1 and 200
       or coalesce(p_governance->>'evaluatedAt', '') !~ '^\d{4}-\d{2}-\d{2}T' then
        raise exception 'project_knowledge_governance_projection_mismatch';
    end if;
    return v_role;
end;
$$;

revoke all on function public.canonical_project_knowledge_assert_authority(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- ratify_canonical_learning_candidate
--
-- Dispositions (no write unless 'ratified'):
--   ratified          review + knowledge + event written atomically
--   duplicate         this exact Candidate state was already ratified (retry): the
--                     committed review/knowledge is returned, no second event
--   already_finalized this exact Candidate state was already REJECTED; it never flips
--   stale_review      the Candidate's current version/digest differ from the reviewed ones
--   not_supported     no current source, or current sources no longer match the digest
--   already_ratified  another version of this Candidate already has ACTIVE knowledge
-- Authorization, scope, governance-projection and validation failures raise.
-- -----------------------------------------------------------------------------
create or replace function public.ratify_canonical_learning_candidate(
    p_workspace_id uuid,
    p_project_id uuid,
    p_candidate_id uuid,
    p_candidate_version integer,
    p_candidate_evidence_digest text,
    p_rationale text,
    p_validity_mode text,
    p_effective_until timestamptz,
    p_governance jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
    v_actor uuid;
    v_role text;
    v_now timestamptz := now();
    v_candidate public.canonical_learning_candidates%rowtype;
    v_review public.canonical_learning_candidate_reviews%rowtype;
    v_knowledge public.canonical_project_knowledge_records%rowtype;
    v_support record;
    v_limitations text[];
    v_results text;
    v_statement text;
    v_event_id uuid;
begin
    v_actor := auth.uid();
    if v_actor is null then
        raise exception 'unauthenticated';
    end if;
    if p_workspace_id is null or p_project_id is null or p_candidate_id is null
       or p_candidate_version is null or p_candidate_version < 1
       or coalesce(p_candidate_evidence_digest, '') !~ '^[a-f0-9]{64}$' then
        raise exception 'project_knowledge_payload_invalid';
    end if;
    if char_length(btrim(coalesce(p_rationale, ''))) not between 1 and 8000 then
        raise exception 'project_knowledge_rationale_required';
    end if;
    -- An explicit validity choice; never a default duration. The clock is the database's.
    if p_validity_mode is null or p_validity_mode not in ('until_revoked', 'until_date')
       or (p_validity_mode = 'until_revoked' and p_effective_until is not null)
       or (p_validity_mode = 'until_date' and (p_effective_until is null or p_effective_until <= v_now)) then
        raise exception 'project_knowledge_validity_invalid';
    end if;

    v_role := public.canonical_project_knowledge_assert_authority(p_workspace_id, p_project_id, 'knowledge.ratify', p_governance);

    -- The Candidate row lock serialises ratify/reject/retry and P2-18's own evidence updates.
    select * into v_candidate
    from public.canonical_learning_candidates
    where id = p_candidate_id and workspace_id = p_workspace_id and project_id = p_project_id
    for update;
    if not found then
        raise exception 'project_knowledge_candidate_not_found';
    end if;

    -- A terminal review of this exact state already exists: replay or refuse, never flip.
    select * into v_review
    from public.canonical_learning_candidate_reviews
    where candidate_id = v_candidate.id and candidate_version = p_candidate_version
      and candidate_evidence_digest = p_candidate_evidence_digest;
    if found then
        if v_review.review_outcome = 'ratified' then
            select * into v_knowledge from public.canonical_project_knowledge_records where review_id = v_review.id;
            return jsonb_build_object('disposition', 'duplicate', 'review', to_jsonb(v_review), 'knowledge', to_jsonb(v_knowledge));
        end if;
        return jsonb_build_object('disposition', 'already_finalized', 'review', to_jsonb(v_review), 'knowledge', null);
    end if;

    if v_candidate.version <> p_candidate_version or v_candidate.evidence_digest <> p_candidate_evidence_digest then
        return jsonb_build_object(
            'disposition', 'stale_review',
            'currentVersion', v_candidate.version,
            'currentEvidenceDigest', v_candidate.evidence_digest,
            'reviewedVersion', p_candidate_version,
            'reviewedEvidenceDigest', p_candidate_evidence_digest
        );
    end if;

    if v_candidate.fixture_label is not null then
        raise exception 'project_knowledge_fixture_not_ratifiable';
    end if;

    select * into v_support from public.canonical_learning_candidate_current_support(v_candidate.id, v_now);
    if v_support.source_count = 0 or v_support.evidence_digest is distinct from v_candidate.evidence_digest then
        return jsonb_build_object(
            'disposition', 'not_supported',
            'reason', case when v_support.source_count = 0 then 'no_current_sources' else 'summary_not_current' end,
            'currentSourceCount', v_support.source_count
        );
    end if;

    if exists (
        select 1 from public.canonical_project_knowledge_records k
        where k.candidate_id = v_candidate.id and k.status = 'active'
    ) then
        return jsonb_build_object('disposition', 'already_ratified');
    end if;

    insert into public.canonical_learning_candidate_reviews (
        workspace_id, project_id, candidate_id, candidate_version, candidate_evidence_digest,
        review_outcome, reviewed_by, reviewer_role, reviewed_at, candidate_created_by,
        candidate_last_evaluated_by, reviewer_is_candidate_creator, reviewed_summary,
        causality_claim, limitations, rationale, governance_action, governance_decision_id,
        governance_decision_state, governance_contract, governance_evaluated_at, fixture_label
    ) values (
        p_workspace_id, p_project_id, v_candidate.id, v_candidate.version, v_candidate.evidence_digest,
        'ratified', v_actor, v_role, v_now, v_candidate.created_by,
        v_candidate.last_evaluated_by, v_candidate.created_by = v_actor,
        jsonb_build_object(
            'pattern', v_candidate.pattern_signature,
            'evidenceTier', v_candidate.evidence_tier,
            'lineageCount', v_candidate.lineage_count,
            'independentLineageCount', v_candidate.independent_lineage_count,
            'resultCounts', v_candidate.result_counts,
            'confidence', jsonb_build_object('value', v_candidate.confidence_score, 'method', v_candidate.confidence_method),
            'summaryAsOf', v_candidate.last_evaluated_at,
            'currentSourceCount', v_support.source_count,
            'currentSourceIds', to_jsonb(v_support.source_ids),
            'operationallySupported', true
        ),
        v_candidate.causality_claim, v_candidate.limitations, btrim(p_rationale), 'knowledge.ratify',
        btrim(p_governance->>'decisionId'), 'allow', p_governance->>'contract',
        (p_governance->>'evaluatedAt')::timestamptz, null
    )
    returning * into v_review;

    -- Knowledge limitations: the Candidate's, minus the pre-ratification statement, plus the
    -- two statements every P2-19 record carries.
    v_limitations := array_append(array_append(
        array_remove(v_candidate.limitations, 'not_ratified'),
        'applies_to_source_project_only'::text),
        'ratification_is_not_causal_evidence'::text);

    select string_agg(r.k || ' ' || r.v, ', ' order by r.k) into v_results
    from jsonb_each_text(v_candidate.result_counts) as r(k, v);

    v_statement := left(format(
        'In this project, the pattern Finding %s -> recommended action %s -> action class %s was followed by observed results (%s) across %s lineage(s), %s structurally independent. %s.',
        v_candidate.pattern_signature->>'signalType',
        v_candidate.pattern_signature->>'recommendedActionType',
        v_candidate.pattern_signature->>'actionClass',
        coalesce(v_results, 'none'),
        v_candidate.lineage_count,
        v_candidate.independent_lineage_count,
        case when v_candidate.causality_claim = 'correlation_only'
             then 'Observed correlation only; it does not establish causation'
             else 'Causality claim: ' || v_candidate.causality_claim end), 2000);

    insert into public.canonical_project_knowledge_records (
        workspace_id, project_id, candidate_id, candidate_version, candidate_evidence_digest,
        review_id, review_outcome, knowledge_kind, pattern_key, pattern_signature, statement,
        evidence_tier, lineage_count, independent_lineage_count, result_counts, confidence_score,
        confidence_method, causality_claim, limitations, source_ids, applicability_scope, status,
        validity_mode, effective_from, effective_until, ratified_at, ratified_by,
        ratification_governance_decision_id, version, fixture_label
    ) values (
        p_workspace_id, p_project_id, v_candidate.id, v_candidate.version, v_candidate.evidence_digest,
        v_review.id, 'ratified', v_candidate.candidate_kind, v_candidate.pattern_key, v_candidate.pattern_signature, v_statement,
        v_candidate.evidence_tier, v_candidate.lineage_count, v_candidate.independent_lineage_count, v_candidate.result_counts,
        v_candidate.confidence_score, v_candidate.confidence_method, v_candidate.causality_claim, v_limitations,
        v_support.source_ids, 'source_project', 'active',
        p_validity_mode, v_now, p_effective_until, v_now, v_actor,
        v_review.governance_decision_id, 1, null
    )
    returning * into v_knowledge;

    insert into public.platform_events (
        workspace_id, project_id, actor_id, actor_type, event_type, event_category,
        event_payload, source, correlation_id, causation_id, visibility, sensitivity_level,
        learning_eligible, raw_reference_table, raw_reference_id, metadata, occurred_at
    ) values (
        p_workspace_id, p_project_id, v_actor, 'user', 'CANONICAL_LEARNING_CANDIDATE_RATIFIED_V1', 'learning',
        jsonb_build_object(
            'eventType', 'canonical_learning_candidate_ratified.v1',
            'eventVersion', 1,
            'candidateId', v_candidate.id,
            'candidateVersion', v_candidate.version,
            'candidateEvidenceDigest', v_candidate.evidence_digest,
            'reviewId', v_review.id,
            'knowledgeId', v_knowledge.id,
            'applicabilityScope', 'source_project',
            'validityMode', v_knowledge.validity_mode,
            'effectiveFrom', v_knowledge.effective_from,
            'effectiveUntil', v_knowledge.effective_until,
            'causalityClaim', v_knowledge.causality_claim,
            'actors', jsonb_build_object(
                'candidateCreatedBy', v_candidate.created_by,
                'candidateLastEvaluatedBy', v_candidate.last_evaluated_by,
                'reviewedBy', v_actor,
                'ratifiedBy', v_actor,
                'reviewerRole', v_role,
                'reviewerIsCandidateCreator', v_review.reviewer_is_candidate_creator),
            'governance', jsonb_build_object(
                'action', 'knowledge.ratify',
                'decision', 'allow',
                'decisionId', v_review.governance_decision_id,
                'contract', v_review.governance_contract,
                'evaluatedAt', v_review.governance_evaluated_at),
            'sourceIds', to_jsonb(v_knowledge.source_ids),
            'elevationInferred', false,
            'crossWorkspace', false
        ),
        'user_action', null, null, 'project', 'internal',
        -- Ratified knowledge is an OUTPUT of governance, never re-extracted as pattern input.
        false,
        'canonical_project_knowledge_records', v_knowledge.id,
        jsonb_build_object('reviewId', v_review.id),
        v_now
    )
    returning id into v_event_id;

    return jsonb_build_object('disposition', 'ratified', 'review', to_jsonb(v_review), 'knowledge', to_jsonb(v_knowledge), 'eventId', v_event_id);
end;
$$;

revoke all on function public.ratify_canonical_learning_candidate(uuid, uuid, uuid, integer, text, text, text, timestamptz, jsonb) from public;
revoke execute on function public.ratify_canonical_learning_candidate(uuid, uuid, uuid, integer, text, text, text, timestamptz, jsonb) from anon;
grant execute on function public.ratify_canonical_learning_candidate(uuid, uuid, uuid, integer, text, text, text, timestamptz, jsonb) to authenticated;

comment on function public.ratify_canonical_learning_candidate(uuid, uuid, uuid, integer, text, text, text, timestamptz, jsonb) is
'P2-19: ratify one exact Learning Candidate state (id, version, evidence_digest) into Project-scoped knowledge. Authenticated owner/admin with an ALLOW knowledge.ratify decision; stale-review and current-support checks under the Candidate lock; explicit validity (until_revoked | until_date); review + knowledge + event atomically. Never elevates beyond the source Project.';

-- -----------------------------------------------------------------------------
-- reject_canonical_learning_candidate
--
-- Dispositions: rejected | duplicate (already rejected, retry) | already_finalized (already
-- ratified; never flips) | stale_review. Creates no knowledge.
-- -----------------------------------------------------------------------------
create or replace function public.reject_canonical_learning_candidate(
    p_workspace_id uuid,
    p_project_id uuid,
    p_candidate_id uuid,
    p_candidate_version integer,
    p_candidate_evidence_digest text,
    p_rationale text,
    p_governance jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
    v_actor uuid;
    v_role text;
    v_now timestamptz := now();
    v_candidate public.canonical_learning_candidates%rowtype;
    v_review public.canonical_learning_candidate_reviews%rowtype;
    v_support record;
    v_event_id uuid;
begin
    v_actor := auth.uid();
    if v_actor is null then
        raise exception 'unauthenticated';
    end if;
    if p_workspace_id is null or p_project_id is null or p_candidate_id is null
       or p_candidate_version is null or p_candidate_version < 1
       or coalesce(p_candidate_evidence_digest, '') !~ '^[a-f0-9]{64}$' then
        raise exception 'project_knowledge_payload_invalid';
    end if;
    if char_length(btrim(coalesce(p_rationale, ''))) not between 1 and 8000 then
        raise exception 'project_knowledge_rationale_required';
    end if;

    v_role := public.canonical_project_knowledge_assert_authority(p_workspace_id, p_project_id, 'knowledge.reject', p_governance);

    select * into v_candidate
    from public.canonical_learning_candidates
    where id = p_candidate_id and workspace_id = p_workspace_id and project_id = p_project_id
    for update;
    if not found then
        raise exception 'project_knowledge_candidate_not_found';
    end if;

    select * into v_review
    from public.canonical_learning_candidate_reviews
    where candidate_id = v_candidate.id and candidate_version = p_candidate_version
      and candidate_evidence_digest = p_candidate_evidence_digest;
    if found then
        return jsonb_build_object(
            'disposition', case when v_review.review_outcome = 'rejected' then 'duplicate' else 'already_finalized' end,
            'review', to_jsonb(v_review));
    end if;

    if v_candidate.version <> p_candidate_version or v_candidate.evidence_digest <> p_candidate_evidence_digest then
        return jsonb_build_object(
            'disposition', 'stale_review',
            'currentVersion', v_candidate.version,
            'currentEvidenceDigest', v_candidate.evidence_digest,
            'reviewedVersion', p_candidate_version,
            'reviewedEvidenceDigest', p_candidate_evidence_digest
        );
    end if;

    -- Recorded (not required): a rejection is valid whether or not the evidence is current.
    select * into v_support from public.canonical_learning_candidate_current_support(v_candidate.id, v_now);

    insert into public.canonical_learning_candidate_reviews (
        workspace_id, project_id, candidate_id, candidate_version, candidate_evidence_digest,
        review_outcome, reviewed_by, reviewer_role, reviewed_at, candidate_created_by,
        candidate_last_evaluated_by, reviewer_is_candidate_creator, reviewed_summary,
        causality_claim, limitations, rationale, governance_action, governance_decision_id,
        governance_decision_state, governance_contract, governance_evaluated_at, fixture_label
    ) values (
        p_workspace_id, p_project_id, v_candidate.id, v_candidate.version, v_candidate.evidence_digest,
        'rejected', v_actor, v_role, v_now, v_candidate.created_by,
        v_candidate.last_evaluated_by, v_candidate.created_by = v_actor,
        jsonb_build_object(
            'pattern', v_candidate.pattern_signature,
            'evidenceTier', v_candidate.evidence_tier,
            'lineageCount', v_candidate.lineage_count,
            'independentLineageCount', v_candidate.independent_lineage_count,
            'resultCounts', v_candidate.result_counts,
            'confidence', jsonb_build_object('value', v_candidate.confidence_score, 'method', v_candidate.confidence_method),
            'summaryAsOf', v_candidate.last_evaluated_at,
            'currentSourceCount', v_support.source_count,
            'currentSourceIds', to_jsonb(v_support.source_ids),
            'operationallySupported', v_support.source_count > 0
                and v_support.evidence_digest is not distinct from v_candidate.evidence_digest
        ),
        v_candidate.causality_claim, v_candidate.limitations, btrim(p_rationale), 'knowledge.reject',
        btrim(p_governance->>'decisionId'), 'allow', p_governance->>'contract',
        (p_governance->>'evaluatedAt')::timestamptz, v_candidate.fixture_label
    )
    returning * into v_review;

    insert into public.platform_events (
        workspace_id, project_id, actor_id, actor_type, event_type, event_category,
        event_payload, source, correlation_id, causation_id, visibility, sensitivity_level,
        learning_eligible, raw_reference_table, raw_reference_id, metadata, occurred_at
    ) values (
        p_workspace_id, p_project_id, v_actor, 'user', 'CANONICAL_LEARNING_CANDIDATE_REJECTED_V1', 'learning',
        jsonb_build_object(
            'eventType', 'canonical_learning_candidate_rejected.v1',
            'eventVersion', 1,
            'candidateId', v_candidate.id,
            'candidateVersion', v_candidate.version,
            'candidateEvidenceDigest', v_candidate.evidence_digest,
            'reviewId', v_review.id,
            'actors', jsonb_build_object(
                'candidateCreatedBy', v_candidate.created_by,
                'candidateLastEvaluatedBy', v_candidate.last_evaluated_by,
                'reviewedBy', v_actor,
                'reviewerRole', v_role,
                'reviewerIsCandidateCreator', v_review.reviewer_is_candidate_creator),
            'governance', jsonb_build_object(
                'action', 'knowledge.reject',
                'decision', 'allow',
                'decisionId', v_review.governance_decision_id,
                'contract', v_review.governance_contract,
                'evaluatedAt', v_review.governance_evaluated_at),
            'knowledgeCreated', false,
            'elevationInferred', false
        ),
        'user_action', null, null, 'project', 'internal', false,
        'canonical_learning_candidate_reviews', v_review.id,
        '{}'::jsonb,
        v_now
    )
    returning id into v_event_id;

    return jsonb_build_object('disposition', 'rejected', 'review', to_jsonb(v_review), 'eventId', v_event_id);
end;
$$;

revoke all on function public.reject_canonical_learning_candidate(uuid, uuid, uuid, integer, text, text, jsonb) from public;
revoke execute on function public.reject_canonical_learning_candidate(uuid, uuid, uuid, integer, text, text, jsonb) from anon;
grant execute on function public.reject_canonical_learning_candidate(uuid, uuid, uuid, integer, text, text, jsonb) to authenticated;

comment on function public.reject_canonical_learning_candidate(uuid, uuid, uuid, integer, text, text, jsonb) is
'P2-19: reject one exact Learning Candidate state. Authenticated owner/admin with an ALLOW knowledge.reject decision; terminal for that (id, version, digest); creates no knowledge; review + event atomically.';

-- -----------------------------------------------------------------------------
-- revoke_canonical_project_knowledge
--
-- Dispositions: revoked | already_revoked (retry; no second event). Terminal; content and
-- provenance stay immutable; never reactivated.
-- -----------------------------------------------------------------------------
create or replace function public.revoke_canonical_project_knowledge(
    p_workspace_id uuid,
    p_project_id uuid,
    p_knowledge_id uuid,
    p_reason text,
    p_governance jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
    v_actor uuid;
    v_role text;
    v_now timestamptz := now();
    v_knowledge public.canonical_project_knowledge_records%rowtype;
    v_event_id uuid;
begin
    v_actor := auth.uid();
    if v_actor is null then
        raise exception 'unauthenticated';
    end if;
    if p_workspace_id is null or p_project_id is null or p_knowledge_id is null then
        raise exception 'project_knowledge_payload_invalid';
    end if;
    if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 8000 then
        raise exception 'project_knowledge_rationale_required';
    end if;

    v_role := public.canonical_project_knowledge_assert_authority(p_workspace_id, p_project_id, 'knowledge.revoke', p_governance);

    select * into v_knowledge
    from public.canonical_project_knowledge_records
    where id = p_knowledge_id and workspace_id = p_workspace_id and project_id = p_project_id
    for update;
    if not found then
        raise exception 'project_knowledge_not_found';
    end if;
    if v_knowledge.status = 'revoked' then
        return jsonb_build_object('disposition', 'already_revoked', 'knowledge', to_jsonb(v_knowledge));
    end if;

    update public.canonical_project_knowledge_records
    set status = 'revoked',
        version = v_knowledge.version + 1,
        updated_at = v_now,
        revoked_at = v_now,
        revoked_by = v_actor,
        revocation_reason = btrim(p_reason),
        revocation_governance_decision_id = btrim(p_governance->>'decisionId'),
        revocation_governance_evaluated_at = (p_governance->>'evaluatedAt')::timestamptz
    where id = v_knowledge.id
    returning * into v_knowledge;

    insert into public.platform_events (
        workspace_id, project_id, actor_id, actor_type, event_type, event_category,
        event_payload, source, correlation_id, causation_id, visibility, sensitivity_level,
        learning_eligible, raw_reference_table, raw_reference_id, metadata, occurred_at
    ) values (
        p_workspace_id, p_project_id, v_actor, 'user', 'CANONICAL_PROJECT_KNOWLEDGE_REVOKED_V1', 'learning',
        jsonb_build_object(
            'eventType', 'canonical_project_knowledge_revoked.v1',
            'eventVersion', 1,
            'knowledgeId', v_knowledge.id,
            'knowledgeVersion', v_knowledge.version,
            'candidateId', v_knowledge.candidate_id,
            'candidateVersion', v_knowledge.candidate_version,
            'reviewId', v_knowledge.review_id,
            'actors', jsonb_build_object(
                'ratifiedBy', v_knowledge.ratified_by,
                'revokedBy', v_actor,
                'revokerRole', v_role,
                'revokerIsRatifier', v_knowledge.ratified_by = v_actor),
            'governance', jsonb_build_object(
                'action', 'knowledge.revoke',
                'decision', 'allow',
                'decisionId', v_knowledge.revocation_governance_decision_id,
                'contract', p_governance->>'contract',
                'evaluatedAt', v_knowledge.revocation_governance_evaluated_at),
            'elevationInferred', false
        ),
        'user_action', null, null, 'project', 'internal', false,
        'canonical_project_knowledge_records', v_knowledge.id,
        '{}'::jsonb,
        v_now
    )
    returning id into v_event_id;

    return jsonb_build_object('disposition', 'revoked', 'knowledge', to_jsonb(v_knowledge), 'eventId', v_event_id);
end;
$$;

revoke all on function public.revoke_canonical_project_knowledge(uuid, uuid, uuid, text, jsonb) from public;
revoke execute on function public.revoke_canonical_project_knowledge(uuid, uuid, uuid, text, jsonb) from anon;
grant execute on function public.revoke_canonical_project_knowledge(uuid, uuid, uuid, text, jsonb) to authenticated;

comment on function public.revoke_canonical_project_knowledge(uuid, uuid, uuid, text, jsonb) is
'P2-19: revoke one Project knowledge record. Authenticated owner/admin with an ALLOW knowledge.revoke decision; terminal and idempotent (already_revoked writes nothing); revocation + event atomically; removes the record from retrieve_project_knowledge immediately.';

-- -----------------------------------------------------------------------------
-- retrieve_project_knowledge — the authoritative Project knowledge read.
-- SECURITY INVOKER: RLS scopes it to the caller's own Projects. Returns only active,
-- source-project, non-fixture records whose effective_until has not passed at the DATABASE
-- clock. Candidates, rejected reviews and revoked or expired records are never returned.
-- -----------------------------------------------------------------------------
create or replace function public.retrieve_project_knowledge(p_workspace_id uuid, p_project_id uuid)
returns setof public.canonical_project_knowledge_records
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
    select k.*
    from public.canonical_project_knowledge_records k
    where k.workspace_id = p_workspace_id
      and k.project_id = p_project_id
      and k.applicability_scope = 'source_project'
      and k.status = 'active'
      and k.fixture_label is null
      and k.effective_from <= now()
      and (k.effective_until is null or k.effective_until > now())
    order by k.ratified_at desc, k.id
$$;

revoke all on function public.retrieve_project_knowledge(uuid, uuid) from public;
revoke execute on function public.retrieve_project_knowledge(uuid, uuid) from anon;
grant execute on function public.retrieve_project_knowledge(uuid, uuid) to authenticated, service_role;

comment on function public.retrieve_project_knowledge(uuid, uuid) is
'P2-19 authoritative Project knowledge retrieval: active, source_project, non-fixture, unexpired at the database clock; RLS-scoped (security invoker). Excludes candidates, rejected reviews, revoked and expired records.';
