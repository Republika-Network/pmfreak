-- ============================================================================
-- P2-16 — Schedule Exposure adapter into the canonical operational spine.
--
-- WHY THIS MIGRATION EXISTS
--
-- The H7–H9 schedule engine (execution_task_dependencies, project_milestones,
-- src/lib/critical-path/*) evaluates dependency topology and milestone exposure
-- deterministically, but nothing connected that result to the canonical
-- Source → Raw Input → Normalized Event → Evidence → Finding → Recommendation
-- spine. The spine's only write contracts accept `manual_input.submitted` v1:
--
--   * both capture RPCs hardcode the event type and a {title, content} payload;
--   * `derive_operational_evidence` refuses any other event type
--     (`normalized_event_version_unsupported`);
--   * the only Finding producer, `materialize_operational_chain`, is a keyword
--     regex over Evidence text with a fixed confidence per rule.
--
-- Routing schedule output through those would mean crafting text to trip the
-- regex and presenting a keyword match (fixed 84) as the schedule engine's
-- qualified result. This migration instead adds three NARROW contracts that
-- accept ONLY a schedule evaluation, and writes into the existing canonical
-- tables so every current consumer (summary, attention, P2-10 lineage, P2-20
-- export, decision RPC) reads the result unchanged.
--
-- WHAT IT ADDS
--
--   1. `operational_sources.source_kind` gains 'engine'. An engine Source is
--      pinned to the `schedule-engine:` key namespace in BOTH directions, so no
--      other intake contract can mint (and poison) the schedule Source identity
--      and the schedule contract can never adopt a connector/demo Source.
--   2. `evidence_items.source_type` gains 'schedule_evaluation', so schedule
--      Evidence is never rendered as a human manual note.
--   3. capture_schedule_exposure_evaluation  — Raw Input + Normalized Event.
--   4. derive_schedule_exposure_evidence     — Evidence from that event only.
--   5. materialize_schedule_exposure_finding — Finding (operational_signals)
--      + risk + governance event + governed `proposed` Recommendation.
--
-- WHAT IT DOES NOT DO
--
--   * no new table, no new column, no RLS/policy change, no data change;
--   * no existing function is replaced;
--   * it never creates a Decision, Material Action, Task, Outcome or
--     Observation — the governed Recommendation stops at `proposed`;
--   * UNKNOWN missing-data and invalid topology never reach Evidence/Finding.
--
-- Forward-only and additive. Both check widenings only admit new values, so
-- every existing row remains valid.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Source kind 'engine', pinned to the schedule-engine key namespace.
-- ----------------------------------------------------------------------------
alter table public.operational_sources drop constraint if exists operational_sources_source_kind_check;
alter table public.operational_sources add constraint operational_sources_source_kind_check
  check (source_kind in ('manual_demo','connector','import','engine'));

alter table public.operational_sources drop constraint if exists operational_sources_engine_identity_check;
alter table public.operational_sources add constraint operational_sources_engine_identity_check
  check ((source_kind = 'engine') = (source_key like 'schedule-engine:%'));

comment on constraint operational_sources_engine_identity_check on public.operational_sources is
  'P2-16: an engine Source lives only under the schedule-engine: key namespace and that namespace only holds engine Sources, so no other intake contract can mint or adopt the schedule Source identity.';

-- ----------------------------------------------------------------------------
-- 2. Evidence source type for schedule evaluations.
-- ----------------------------------------------------------------------------
alter table public.evidence_items drop constraint if exists evidence_items_source_type_check;
alter table public.evidence_items add constraint evidence_items_source_type_check
  check (source_type in ('manual_note','email','meeting_minutes','ticket','conversation','document_reference','schedule_evaluation'));

-- ----------------------------------------------------------------------------
-- 3. Raw Input + Normalized Event for one schedule exposure evaluation.
--
-- The payload is produced server-side by src/lib/critical-path/schedule-exposure.ts
-- from the existing H9 engine. This contract re-validates its shape and scope and
-- DERIVES the idempotency key itself from (snapshot digest, trigger identity):
-- the caller cannot choose it, and it contains no timestamp. The first
-- evaluation time is kept in provenance (not in the digested payload), so a
-- retry of the same snapshot+change replays to the same rows.
-- ----------------------------------------------------------------------------
create or replace function public.capture_schedule_exposure_evaluation(
  p_workspace_id uuid,
  p_project_id uuid,
  p_payload jsonb,
  p_occurred_at timestamptz,
  p_evaluated_at timestamptz,
  p_correlation_id uuid,
  p_causation_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_source_key constant text := 'schedule-engine:h9-v1';
  v_source public.operational_sources;
  v_raw public.operational_raw_inputs;
  v_event public.operational_normalized_events;
  v_trigger jsonb;
  v_trigger_entity uuid;
  v_confidence numeric;
  v_missing text;
  v_idempotency_key text;
  v_raw_digest text;
  v_event_digest text;
  v_duplicate boolean := false;
  v_audit_id uuid;
begin
  if v_actor is null then raise exception 'schedule_exposure_unauthenticated'; end if;
  if not public.can_write_operational_project(p_workspace_id, p_project_id) then raise exception 'schedule_exposure_access_denied'; end if;
  if p_correlation_id is null then raise exception 'schedule_exposure_correlation_id_required'; end if;
  if p_occurred_at is null or p_occurred_at > now() + interval '5 minutes' then raise exception 'schedule_exposure_occurred_at_invalid'; end if;
  if p_evaluated_at is null or p_evaluated_at > now() + interval '5 minutes' then raise exception 'schedule_exposure_evaluated_at_invalid'; end if;

  -- Shape. Only a qualified evaluation of a supported adapter version is accepted.
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_payload->>'adapter' is distinct from 'pmfreak/schedule-exposure-adapter:v1'
     or (p_payload->>'schemaVersion') is distinct from '1'
     or nullif(trim(coalesce(p_payload->>'title','')),'') is null
     or nullif(trim(coalesce(p_payload->>'content','')),'') is null
     or coalesce(p_payload#>>'{snapshot,digest}','') !~ '^sha256:[a-f0-9]{64}$'
     or jsonb_typeof(p_payload->'exposures') is distinct from 'array'
     or jsonb_array_length(p_payload->'exposures') = 0
     or p_payload->>'severity' not in ('low','medium','high','critical') then
    raise exception 'schedule_exposure_payload_invalid';
  end if;
  if p_payload#>>'{evaluation,status}' is distinct from 'qualified' then raise exception 'schedule_exposure_not_qualified'; end if;

  v_missing := p_payload#>>'{evaluation,missingDataState}';
  if v_missing = 'UNKNOWN' then raise exception 'schedule_exposure_insufficient_data'; end if;
  if v_missing is null or v_missing not in ('COMPLETE','PARTIAL') then raise exception 'schedule_exposure_payload_invalid'; end if;
  if jsonb_typeof(p_payload#>'{evaluation,confidence}') is distinct from 'number' then raise exception 'schedule_exposure_payload_invalid'; end if;
  v_confidence := (p_payload#>>'{evaluation,confidence}')::numeric;
  if v_confidence < 0 or v_confidence > 1 then raise exception 'schedule_exposure_confidence_invalid'; end if;

  -- Trigger: a typed change of an entity that belongs to THIS project.
  v_trigger := p_payload->'trigger';
  if v_trigger is null or v_trigger->>'kind' not in ('dependency_change','milestone_date_change')
     or coalesce(v_trigger->>'entityId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'schedule_exposure_trigger_invalid';
  end if;
  v_trigger_entity := (v_trigger->>'entityId')::uuid;
  if v_trigger->>'kind' = 'dependency_change' then
    if v_trigger->>'entityType' is distinct from 'execution_task_dependency' or not exists (
      select 1 from public.execution_task_dependencies d
      where d.id = v_trigger_entity and d.workspace_id = p_workspace_id and d.project_id = p_project_id
    ) then raise exception 'schedule_exposure_trigger_scope_mismatch'; end if;
  else
    if v_trigger->>'entityType' is distinct from 'project_milestone' or not exists (
      select 1 from public.project_milestones m
      where m.id = v_trigger_entity and m.workspace_id = p_workspace_id and m.project_id = p_project_id
    ) then raise exception 'schedule_exposure_trigger_scope_mismatch'; end if;
  end if;

  -- Engine Source, pinned server-side. Refused, never relabelled, if the key holds anything else.
  insert into public.operational_sources(workspace_id, project_id, source_key, source_kind, display_name, status, is_fixture, fixture_label, fixture_expires_when, created_by)
  values (p_workspace_id, p_project_id, v_source_key, 'engine', 'PMFreak schedule engine (H7–H9 critical path)', 'active', false, null, null, v_actor)
  on conflict (workspace_id, project_id, source_key) do nothing;
  select * into v_source from public.operational_sources
    where workspace_id = p_workspace_id and project_id = p_project_id and source_key = v_source_key;
  if v_source.id is null then raise exception 'schedule_exposure_source_creation_failed'; end if;
  if v_source.source_kind <> 'engine' or v_source.is_fixture then raise exception 'schedule_exposure_source_kind_mismatch'; end if;
  case v_source.status
    when 'degraded' then raise exception 'schedule_exposure_source_degraded';
    when 'stale' then raise exception 'schedule_exposure_source_stale';
    when 'unavailable' then raise exception 'schedule_exposure_source_unavailable';
    when 'revoked' then raise exception 'schedule_exposure_source_revoked';
    else null;
  end case;

  -- Natural identity: snapshot digest + trigger identity. No timestamp of evaluation.
  v_idempotency_key := 'schedule-exposure:v1:' || encode(extensions.digest(convert_to(
    jsonb_build_object('snapshotDigest', p_payload#>>'{snapshot,digest}', 'trigger', v_trigger)::text, 'UTF8'), 'sha256'), 'hex');
  v_raw_digest := 'sha256:' || encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.operational_raw_inputs(workspace_id, project_id, source_id, external_id, idempotency_key, payload, content_digest, status, occurred_at, actor_user_id, correlation_id, causation_id, provenance)
  values (p_workspace_id, p_project_id, v_source.id, v_trigger->>'entityId', v_idempotency_key, p_payload, v_raw_digest, 'received', p_occurred_at, v_actor, p_correlation_id, p_causation_id,
    jsonb_build_object('sourceId', v_source.id, 'sourceKey', v_source.source_key, 'capturedBy', v_actor, 'isFixture', false,
      'evaluatedAt', p_evaluated_at, 'snapshotDigest', p_payload#>>'{snapshot,digest}', 'engine', p_payload->>'engine',
      'adapter', p_payload->>'adapter', 'triggerKind', v_trigger->>'kind', 'triggerEntityId', v_trigger->>'entityId'))
  on conflict (source_id, idempotency_key) do nothing
  returning * into v_raw;
  if v_raw.id is null then
    v_duplicate := true;
    select * into v_raw from public.operational_raw_inputs where source_id = v_source.id and idempotency_key = v_idempotency_key;
    if v_raw.content_digest <> v_raw_digest then raise exception 'schedule_exposure_idempotency_conflict'; end if;
  end if;

  v_event_digest := 'sha256:' || encode(extensions.digest(convert_to(jsonb_build_object(
    'eventType', 'schedule_exposure.evaluated', 'schemaVersion', 1, 'rawDigest', v_raw.content_digest, 'payload', p_payload)::text, 'UTF8'), 'sha256'), 'hex');
  insert into public.operational_normalized_events(workspace_id, project_id, source_id, raw_input_id, event_type, schema_version, normalizer_key, subject_type, subject_id, event_payload, event_digest, status, occurred_at, actor_user_id, correlation_id, causation_id, provenance)
  values (p_workspace_id, p_project_id, v_source.id, v_raw.id, 'schedule_exposure.evaluated', 1, 'pmfreak/schedule-exposure-normalizer:v1', 'project', p_project_id, p_payload, v_event_digest, 'accepted',
    v_raw.occurred_at, v_actor, v_raw.correlation_id, v_raw.id,
    jsonb_build_object('sourceId', v_source.id, 'rawInputId', v_raw.id, 'rawDigest', v_raw.content_digest, 'normalizer', 'pmfreak/schedule-exposure-normalizer:v1',
      'evaluatedAt', v_raw.provenance->>'evaluatedAt', 'snapshotDigest', p_payload#>>'{snapshot,digest}'))
  on conflict (raw_input_id, event_type, schema_version) do nothing
  returning * into v_event;
  if v_event.id is null then
    select * into v_event from public.operational_normalized_events
      where raw_input_id = v_raw.id and event_type = 'schedule_exposure.evaluated' and schema_version = 1;
  end if;

  if not v_duplicate then
    insert into public.platform_events(workspace_id, project_id, actor_id, actor_type, event_type, event_category, event_payload, source, correlation_id, causation_id, visibility, sensitivity_level, learning_eligible, raw_reference_table, raw_reference_id, metadata, occurred_at)
    values (p_workspace_id, p_project_id, v_actor, 'user', 'NORMALIZED_EVENT_RECORDED', 'provenance',
      jsonb_build_object('eventId', v_event.id, 'eventType', v_event.event_type, 'schemaVersion', v_event.schema_version, 'eventDigest', v_event.event_digest, 'snapshotDigest', p_payload#>>'{snapshot,digest}'),
      'user_action', p_correlation_id, p_causation_id, 'project', 'internal', false, 'operational_raw_inputs', v_raw.id,
      jsonb_build_object('sourceId', v_source.id, 'normalizerKey', v_event.normalizer_key, 'triggerKind', v_trigger->>'kind'), v_raw.occurred_at)
    returning id into v_audit_id;
  end if;

  return jsonb_build_object('disposition', case when v_duplicate then 'duplicate' else 'created' end,
    'source', to_jsonb(v_source), 'rawInput', to_jsonb(v_raw), 'normalizedEvent', to_jsonb(v_event),
    'auditEventId', v_audit_id, 'idempotencyKey', v_idempotency_key, 'evidenceCreated', false);
end $$;

revoke all on function public.capture_schedule_exposure_evaluation(uuid,uuid,jsonb,timestamptz,timestamptz,uuid,uuid) from public;
revoke execute on function public.capture_schedule_exposure_evaluation(uuid,uuid,jsonb,timestamptz,timestamptz,uuid,uuid) from public, anon;
grant execute on function public.capture_schedule_exposure_evaluation(uuid,uuid,jsonb,timestamptz,timestamptz,uuid,uuid) to authenticated, service_role;

comment on function public.capture_schedule_exposure_evaluation(uuid,uuid,jsonb,timestamptz,timestamptz,uuid,uuid) is
  'P2-16 schedule intake. Records one qualified H7–H9 exposure evaluation as an immutable Raw Input + schedule_exposure.evaluated v1 Normalized Event under the pinned engine Source. Idempotent on (snapshot digest, trigger). Never creates Evidence.';

-- ----------------------------------------------------------------------------
-- 4. Evidence derived ONLY from a schedule_exposure.evaluated event.
--
-- Confidence and missing-data state are read from the persisted event payload,
-- not accepted from the caller. The evaluation is an INFERENCE of the schedule
-- engine, classified RISK.
-- ----------------------------------------------------------------------------
create or replace function public.derive_schedule_exposure_evidence(
  p_workspace_id uuid,
  p_project_id uuid,
  p_normalized_event_id uuid
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_event public.operational_normalized_events;
  v_raw public.operational_raw_inputs;
  v_source public.operational_sources;
  v_existing public.evidence_items;
  v_evidence public.evidence_items;
  v_key text;
  v_confidence numeric;
  v_missing text;
  v_evaluated_at timestamptz;
  v_freshness text;
  v_canonical jsonb;
  v_digest text;
  v_audit_id uuid;
begin
  if v_actor is null then raise exception 'evidence_unauthenticated'; end if;
  if not public.can_write_operational_project(p_workspace_id, p_project_id) then raise exception 'evidence_access_denied'; end if;

  select * into v_event from public.operational_normalized_events
    where id = p_normalized_event_id and workspace_id = p_workspace_id and project_id = p_project_id;
  if v_event.id is null then raise exception 'normalized_event_not_found_or_scope_mismatch'; end if;
  if v_event.status <> 'accepted' then raise exception 'normalized_event_not_derivable_%', v_event.status; end if;
  if v_event.schema_version <> 1 or v_event.event_type <> 'schedule_exposure.evaluated' then raise exception 'normalized_event_version_unsupported'; end if;

  select * into v_raw from public.operational_raw_inputs where id = v_event.raw_input_id and workspace_id = p_workspace_id and project_id = p_project_id;
  if v_raw.id is null then raise exception 'evidence_missing_raw_input_provenance'; end if;
  if v_raw.status <> 'received' then raise exception 'raw_input_not_derivable_%', v_raw.status; end if;
  select * into v_source from public.operational_sources where id = v_event.source_id and workspace_id = p_workspace_id and project_id = p_project_id;
  if v_source.id is null then raise exception 'evidence_missing_source_provenance'; end if;
  if v_source.source_kind <> 'engine' or v_source.is_fixture then raise exception 'schedule_exposure_source_kind_mismatch'; end if;
  if v_source.status in ('revoked','unavailable','degraded') then raise exception 'evidence_source_%', v_source.status; end if;

  v_confidence := (v_event.event_payload#>>'{evaluation,confidence}')::numeric;
  v_missing := v_event.event_payload#>>'{evaluation,missingDataState}';
  v_evaluated_at := (v_raw.provenance->>'evaluatedAt')::timestamptz;
  if v_confidence is null or v_confidence < 0 or v_confidence > 1 or v_missing not in ('COMPLETE','PARTIAL') or v_evaluated_at is null then
    raise exception 'schedule_exposure_payload_invalid';
  end if;

  v_key := 'schedule-evidence:v1:' || v_event.id::text;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_project_id::text || ':' || v_key, 0));

  v_freshness := case when v_source.status = 'stale' then 'STALE' else 'CURRENT' end;
  v_canonical := jsonb_build_object(
    'assertionType', 'INFERENCE', 'canonicalizationVersion', 'evidence:v1', 'classification', 'RISK',
    'confidenceScore', v_confidence, 'eventDigest', v_event.event_digest, 'eventId', v_event.id,
    'fixtureState', 'LIVE', 'missingDataState', v_missing, 'projectId', p_project_id, 'workspaceId', p_workspace_id);
  v_digest := 'sha256:' || encode(extensions.digest(convert_to(v_canonical::text, 'UTF8'), 'sha256'), 'hex');

  select * into v_existing from public.evidence_items
    where workspace_id = p_workspace_id and project_id = p_project_id and derivation_idempotency_key = v_key;
  if v_existing.id is not null then
    if v_existing.derivation_digest <> v_digest or v_existing.normalized_event_id <> v_event.id then raise exception 'evidence_idempotency_conflict'; end if;
    return jsonb_build_object('disposition', 'duplicate', 'evidence', to_jsonb(v_existing), 'source', to_jsonb(v_source), 'rawInput', to_jsonb(v_raw), 'normalizedEvent', to_jsonb(v_event), 'intelligenceRan', false);
  end if;

  -- evidence_hash is recomputed from content by trg_prepare_evidence_item; the value here is overwritten.
  insert into public.evidence_items(
    workspace_id, project_id, created_by, source_type, title, content, source_reference, confidence_level, status, metadata, evidence_hash, version,
    normalized_event_id, raw_input_id, source_id, derivation_idempotency_key, digest_algorithm, canonicalization_version, assertion_type, classification,
    confidence_score, missing_data_state, freshness_state, stale_at, lifecycle, occurred_at, evaluated_at, recorded_at, correlation_id, causation_id, fixture_state, derivation_digest
  ) values (
    p_workspace_id, p_project_id, v_actor, 'schedule_evaluation', v_event.event_payload->>'title', v_event.event_payload->>'content', v_source.source_key,
    case when v_confidence < .34 then 'low' when v_confidence < .67 then 'medium' else 'high' end, 'recorded',
    jsonb_build_object('sourceKind', v_source.source_kind, 'snapshotDigest', v_event.event_payload#>>'{snapshot,digest}',
      'engine', v_event.event_payload->>'engine', 'adapter', v_event.event_payload->>'adapter',
      'triggerKind', v_event.event_payload#>>'{trigger,kind}', 'triggerEntityId', v_event.event_payload#>>'{trigger,entityId}'),
    encode(extensions.digest(convert_to(v_digest, 'UTF8'), 'sha256'), 'hex'), 1,
    v_event.id, v_raw.id, v_source.id, v_key, 'sha256', 'evidence:v1', 'INFERENCE', 'RISK',
    v_confidence, v_missing, v_freshness, null, case when v_freshness = 'STALE' then 'STALE' else 'RECORDED' end,
    v_event.occurred_at, v_evaluated_at, now(), v_event.correlation_id, v_event.id, 'LIVE', v_digest
  ) returning * into v_evidence;

  insert into public.platform_events(workspace_id, project_id, actor_id, actor_type, event_type, event_category, event_payload, source, correlation_id, causation_id, visibility, sensitivity_level, learning_eligible, raw_reference_table, raw_reference_id, metadata, occurred_at)
  values (p_workspace_id, p_project_id, v_actor, 'user', 'EVIDENCE_DERIVED_V1', 'provenance',
    jsonb_build_object('eventVersion', 1, 'evidenceId', v_evidence.id, 'normalizedEventId', v_event.id, 'rawInputId', v_raw.id, 'sourceId', v_source.id,
      'digest', v_digest, 'canonicalizationVersion', 'evidence:v1', 'assertionType', 'INFERENCE', 'classification', 'RISK',
      'confidence', v_confidence, 'missingDataState', v_missing, 'freshnessState', v_freshness, 'fixtureState', 'LIVE',
      'snapshotDigest', v_event.event_payload#>>'{snapshot,digest}', 'redaction', jsonb_build_object('rawPayloadIncluded', false)),
    'user_action', v_event.correlation_id, v_event.id, 'project', 'internal', false, 'evidence_items', v_evidence.id,
    jsonb_build_object('correlationKind', 'correlation_not_causation', 'derivation', 'schedule_exposure'), v_evaluated_at)
  returning id into v_audit_id;

  return jsonb_build_object('disposition', 'created', 'evidence', to_jsonb(v_evidence), 'source', to_jsonb(v_source), 'rawInput', to_jsonb(v_raw), 'normalizedEvent', to_jsonb(v_event), 'auditEventId', v_audit_id, 'intelligenceRan', false);
end $$;

revoke all on function public.derive_schedule_exposure_evidence(uuid,uuid,uuid) from public;
revoke execute on function public.derive_schedule_exposure_evidence(uuid,uuid,uuid) from public, anon;
grant execute on function public.derive_schedule_exposure_evidence(uuid,uuid,uuid) to authenticated, service_role;

comment on function public.derive_schedule_exposure_evidence(uuid,uuid,uuid) is
  'P2-16 Evidence derivation. Creates INFERENCE/RISK Evidence only from an accepted schedule_exposure.evaluated v1 event under the engine Source; confidence and missing-data state come from the persisted event. Never runs intelligence.';

-- ----------------------------------------------------------------------------
-- 5. Finding + governed Recommendation from schedule Evidence.
--
-- One schedule_risk Signal per Evidence (existing unique (evidence_item_id,
-- signal_type)); confidence is the Evidence's 0-1 value re-expressed on the
-- Signal's persisted 0-100 scale. The Recommendation is `proposed` and linked
-- through source_signal_id. Nothing downstream of Recommendation is created.
-- ----------------------------------------------------------------------------
create or replace function public.materialize_schedule_exposure_finding(p_evidence_item_id uuid)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_detector constant text := 'system/deterministic:schedule_exposure_adapter_v1';
  e public.evidence_items;
  v_event public.operational_normalized_events;
  v_payload jsonb;
  v_signal public.operational_signals;
  v_risk public.risk_issue_records;
  v_gov public.governance_events;
  v_action public.recommended_actions;
  v_severity text;
  v_confidence_pct numeric(5,2);
  v_summary text;
  v_rationale text;
  v_recommendation text;
  v_action_type text;
  v_existing boolean;
  v_run_id uuid;
begin
  if v_actor is null then raise exception 'schedule_exposure_unauthenticated'; end if;
  select * into e from public.evidence_items where id = p_evidence_item_id;
  if e.id is null then raise exception 'evidence_not_found'; end if;
  if not public.can_write_operational_project(e.workspace_id, e.project_id) then raise exception 'operational_write_denied'; end if;
  if e.source_type <> 'schedule_evaluation' or e.normalized_event_id is null then raise exception 'schedule_exposure_evidence_required'; end if;
  if e.missing_data_state = 'UNKNOWN' then raise exception 'schedule_exposure_insufficient_data'; end if;
  if e.lifecycle <> 'RECORDED' or e.freshness_state <> 'CURRENT' then raise exception 'schedule_exposure_evidence_not_current'; end if;

  select * into v_event from public.operational_normalized_events
    where id = e.normalized_event_id and workspace_id = e.workspace_id and project_id = e.project_id;
  if v_event.id is null or v_event.event_type <> 'schedule_exposure.evaluated' or v_event.schema_version <> 1 then
    raise exception 'normalized_event_version_unsupported';
  end if;
  v_payload := v_event.event_payload;

  v_severity := v_payload->>'severity';
  v_confidence_pct := round(e.confidence_score * 100, 2);
  v_summary := left(v_payload->>'title', 500);
  -- The rationale is human-facing prose rendered in the attention queue, so it names the snapshot
  -- by a short digest prefix; the full digest is bound on the Evidence (metadata), Raw Input
  -- (provenance), Normalized Event (payload) and Recommendation (rationale/evidence_summary).
  v_rationale := 'Inference of the deterministic H9 critical-path engine (' || coalesce(v_payload->>'engine', 'unknown engine') || ') over schedule snapshot '
    || left(v_payload#>>'{snapshot,digest}', 23) || '…. Coverage: ' || e.missing_data_state
    || '; confidence ' || to_char(e.confidence_score * 100, 'FM990.0') || '% (method ' || coalesce(v_payload#>>'{evaluation,confidenceMethod}', 'unspecified') || ')'
    || case when e.missing_data_state = 'PARTIAL' then '; some schedule inputs were missing — see Evidence for the gaps.' else '.' end
    || ' Detector: ' || v_detector || '.';
  v_action_type := case when v_payload#>>'{trigger,kind}' = 'dependency_change' then 'confirm_dependency' else 'create_mitigation_plan' end;
  v_recommendation := coalesce(nullif(trim(v_payload->>'recommendation'), ''),
    'Review the schedule exposure with the project owner and record the agreed response.');

  select exists(select 1 from public.operational_signals where evidence_item_id = e.id and signal_type = 'schedule_risk') into v_existing;

  insert into public.operational_signals(workspace_id, project_id, evidence_item_id, signal_type, severity, confidence_score, summary, rationale, detected_by, status)
  values (e.workspace_id, e.project_id, e.id, 'schedule_risk', v_severity, v_confidence_pct, v_summary, v_rationale, v_detector, 'open')
  on conflict (evidence_item_id, signal_type) do nothing;
  select * into v_signal from public.operational_signals where evidence_item_id = e.id and signal_type = 'schedule_risk';

  insert into public.risk_issue_records(workspace_id, project_id, signal_id, type, title, description, severity, probability, impact, status)
  values (e.workspace_id, e.project_id, v_signal.id, 'risk', v_signal.summary, v_signal.rationale, v_signal.severity,
    case when v_signal.confidence_score >= 85 then 'high' when v_signal.confidence_score >= 65 then 'medium' else 'low' end, v_signal.severity, 'open')
  on conflict (signal_id) do nothing;
  select * into v_risk from public.risk_issue_records where signal_id = v_signal.id;

  insert into public.governance_events(workspace_id, project_id, related_entity_type, related_entity_id, rule_key, authority_required, evidence_required, governance_status, explanation)
  values (e.workspace_id, e.project_id, 'risk_issue_record', v_risk.id, 'schedule_exposure_review_v1', 'PM or sponsor', true, 'decision_required',
    'Schedule exposure inferred by the deterministic schedule engine requires a human response (confirm, re-plan or accept) recorded as a separate Decision.')
  on conflict (related_entity_id, rule_key) do nothing;
  select * into v_gov from public.governance_events where related_entity_id = v_risk.id and rule_key = 'schedule_exposure_review_v1';

  insert into public.recommended_actions(workspace_id, project_id, raid_item_id, governance_event_id, risk_issue_id, title, description, recommendation, recommended_action_type, status, confidence_score, impact_level, rationale, urgency, evidence_summary, source_signal_id, fingerprint)
  values (e.workspace_id, e.project_id, null, v_gov.id, v_risk.id, 'Respond to schedule exposure', v_recommendation, v_recommendation, v_action_type, 'proposed',
    v_signal.confidence_score, v_signal.severity,
    jsonb_build_object('governanceEventId', v_gov.id, 'signalId', v_signal.id, 'method', 'schedule_exposure_adapter_v1',
      'snapshotDigest', v_payload#>>'{snapshot,digest}', 'missingDataState', e.missing_data_state, 'confidenceScale', '0-100'),
    case v_signal.severity when 'critical' then 'immediate' when 'high' then 'high' when 'medium' then 'medium' else 'low' end,
    jsonb_build_object('evidenceItemId', e.id, 'evidenceHash', e.evidence_hash, 'evidenceVersion', e.version, 'signalId', v_signal.id,
      'snapshotDigest', v_payload#>>'{snapshot,digest}'),
    v_signal.id::text, encode(extensions.digest(e.workspace_id::text || ':' || v_gov.id::text, 'sha256'), 'hex'))
  on conflict (governance_event_id) where governance_event_id is not null do nothing;
  select * into v_action from public.recommended_actions where governance_event_id = v_gov.id;

  -- Detector run recorded once per Evidence; a replay records nothing new.
  if not v_existing then
    v_run_id := gen_random_uuid();
    insert into public.agent_runs(id, workspace_id, project_id, agent_key, input_summary, status, started_at, completed_at)
    values (v_run_id, e.workspace_id, e.project_id, v_detector, left(e.title, 500), 'completed', now(), now());
    insert into public.agent_outputs(agent_run_id, output_type, output_payload)
    values (v_run_id, 'operational_chain', jsonb_build_object('detectorKind', 'system/deterministic', 'evidenceItemId', e.id, 'signalId', v_signal.id,
      'recommendationId', v_action.id, 'snapshotDigest', v_payload#>>'{snapshot,digest}'));
    update public.evidence_items set status = 'analyzed', updated_at = now() where id = e.id;
  end if;

  return jsonb_build_object('disposition', case when v_existing then 'duplicate' else 'created' end,
    'evidenceItemId', e.id, 'detector', v_detector, 'signal', to_jsonb(v_signal), 'riskIssue', to_jsonb(v_risk),
    'governanceEvent', to_jsonb(v_gov), 'recommendation', to_jsonb(v_action), 'agentRunId', v_run_id,
    'decisionCreated', false, 'actionCreated', false, 'taskCreated', false, 'outcomeCreated', false);
end $$;

revoke all on function public.materialize_schedule_exposure_finding(uuid) from public;
revoke execute on function public.materialize_schedule_exposure_finding(uuid) from public, anon;
grant execute on function public.materialize_schedule_exposure_finding(uuid) to authenticated, service_role;

comment on function public.materialize_schedule_exposure_finding(uuid) is
  'P2-16 Finding. From schedule Evidence only (never UNKNOWN, never stale), records one schedule_risk Signal (0-100 scale), risk, governance event and a governed proposed Recommendation linked by source_signal_id. Idempotent. Creates no Decision, Action, Task, Outcome or Observation.';
