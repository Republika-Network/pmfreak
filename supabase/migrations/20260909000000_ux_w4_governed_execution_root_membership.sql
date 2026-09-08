-- ============================================================================
-- UX-W4 — the execution root needs a MEMBERSHIP token from ONE snapshot, and it
-- needs to name the SAME universe the journey model calls open.
--
-- Two defects are fixed here, and they are the same defect seen from two sides.
--
-- ── 1. Three statements are three snapshots ────────────────────────────────
--
-- The first cut resolved "which governed work is still open" from three independent
-- reads and treated their union as authoritative whenever none hit its row ceiling:
--
--     Q1  internal_task_executions   status in (queued, running, blocked, failed)
--     Q2  canonical_task_outcomes    state  in (expected, observing)
--     Q3  material_action_proposals  expires_at > asOf
--
-- Issuing them together does not give them a shared snapshot. Under READ COMMITTED
-- PostgreSQL takes a NEW snapshot per statement, and `Promise.all` is a client-side
-- scheduling detail with no visibility semantics at all. A canonical transition that
-- moves work from one predicate to the next therefore falls through the gap:
--
--     initial:  Execution E = running,  Outcome absent,  Action A already expired
--
--     Q2 (pending outcomes)  ──── snapshot BEFORE the transition ────▶  {}
--     ┄┄ COMMIT:  E → completed,  and ensure_canonical_expected_outcome writes O ┄┄
--     Q1 (active executions) ──── snapshot AFTER  the transition ────▶  {}
--     Q3 (unexpired actions) ──── A expired, so it cannot rescue it ─▶  {}
--
--     union = {}
--
-- No snapshot of this database ever held that union. Before the commit Q1 matched E;
-- after it Q2 matched O. The empty union is an artefact of reading ACROSS the commit,
-- and the Decision it belongs to — whose journey is VERIFY and open — vanished from the
-- surface. All three result sets were far below the ceiling, so the client called the
-- answer COMPLETE. That is the same family of proof W3 rejected in
-- `20260908000000_p2_02_attention_membership_snapshot.sql`: an instant, a cardinality
-- and a hopeful simultaneity are not membership.
--
-- ── 2. Work-shaped predicates do not cover open journeys ───────────────────
--
-- Even under a perfect snapshot those three predicates ask the wrong question. The
-- presentation model derives `closure = "open"` from the Decision, not from a running
-- row, and two canonical states carry no work-shaped row at all:
--
--   A. An accepted Decision with NO Material Action. The journey is DO/open — the
--      contract permits an Action and the PM has not requested one. There is no
--      Execution, no Outcome and no Action for any of Q1/Q2/Q3 to match.
--   B. A completed Execution whose Outcome has not been recorded and whose Action's
--      authorisation has already lapsed. The journey is VERIFY/open. The Execution is
--      not active, no Outcome exists, and the Action is not unexpired.
--
-- Both simply disappeared, and the root reported itself complete while they did.
--
-- ── The fix ────────────────────────────────────────────────────────────────
--
-- One function, one statement, one snapshot, naming the canonical Decision ids whose
-- journey is OPEN — the same predicate `deriveDecisionJourney` applies, expressed over
-- the rows it reads:
--
--     open(D)  ⇔  D.decision_status in ('accepted','modified')          -- work-bearing
--                 AND ( D has no Material Action                        -- case A / DO
--                       OR some Material Action of D is UNRESOLVED )
--
--     unresolved(A)  ⇔  A's branch has no Outcome that TERMINATES it
--
--     terminates(O)  ⇔  O.state = 'superseded'                          -- stopped: the
--                                                                       -- contract
--                                                                       -- defines no exit
--                       OR ( O.state is a RESOLVED result
--                            AND an Observation for O exists )          -- learning proven
--
-- Everything else follows from the canonical contracts already in place:
--
--   * P2-07's partial unique index makes at most ONE governed Task per Action, so
--     `source_payload ->> 'sourceActionId'` under `source = 'governed_action'` is the
--     branch's Task exactly as `buildExecutionChains` reads it.
--   * P2-09's `canonical_task_outcomes_one_per_task` makes at most ONE Outcome per Task.
--   * P2-09 moves an Outcome off `expected` only through
--     `record_canonical_outcome_observation`, so requiring the Observation row is
--     requiring the thing that established the result — not a second opinion about it.
--
-- Note what is deliberately NOT terminal here. A resolved Outcome whose Observation
-- cannot be resolved is a data-integrity anomaly: the result is known and the learning is
-- not, so the journey is still open and this projection still names it. The root and the
-- presentation model must describe the same universe, or a journey the surface calls open
-- is one the server never offers it.
--
-- Constraints honoured, all deliberate:
--   forward-only; no table, column, policy, trigger or grant is altered; no write
--   semantics; `stable security invoker`, so RLS applies as the caller exactly as every
--   read this replaces did; `search_path` pinned; the same `can_access_operational_project`
--   check the assurance summary uses, so authorization is unchanged and no role name is
--   reimplemented anywhere.
--
-- The id set is deliberately NOT capped in SQL, for the reason P2-02 gives: a silent cap
-- truncates authoritative membership while still looking authoritative. The consumer
-- applies its own explicit ceiling, and exceeding it makes completeness UNPROVEN rather
-- than truncating a set it then calls complete. A deployment that has not applied this
-- file has no projection at all, which the consumer must read as UNPROVEN — never as
-- complete.
-- ============================================================================

-- Supports the membership predicate's Decision → Action step. P2-06 indexes
-- (workspace_id, project_id, persisted_at desc) for the recency window, which cannot serve
-- a lookup by source Decision. Index only: no constraint, no uniqueness, no semantics.
create index if not exists material_action_proposals_source_decision_idx
  on public.material_action_proposals(workspace_id, project_id, source_decision_id);

create or replace function public.get_governed_execution_root(p_workspace_id uuid, p_project_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare result jsonb;
begin
  if not public.can_access_operational_project(p_workspace_id, p_project_id) then
    raise exception 'execution_root_access_denied';
  end if;

  -- ONE statement, and ONE scan inside it. The count and the id list are aggregates over
  -- the same derived table, so they are read from a single MVCC snapshot and cannot
  -- disagree at the source — membership is decided by canonical identity at one instant,
  -- never assembled across statements and never inferred from cardinality.
  select jsonb_build_object(
    'scope', 'project',
    'workspaceId', p_workspace_id,
    'projectId', p_project_id,
    'asOf', now(),
    'openExecutionDecisions', count(*),
    -- The authoritative membership set for that same count. Ordered so the projection is
    -- deterministic across reads; the consumer compares the two and treats any
    -- disagreement as UNPROVEN, because a transport that duplicated an element is the only
    -- way they can now differ.
    'openExecutionDecisionIds',
      coalesce(jsonb_agg(open_journeys.id order by open_journeys.created_at desc, open_journeys.id asc), '[]'::jsonb)
  )
  into result
  from (
    select d.id, d.created_at
      from public.operational_decision_records d
     where d.workspace_id = p_workspace_id
       and d.project_id = p_project_id
       -- `persist_governed_material_action` selects its source with exactly this set, so a
       -- rejected Decision is INCAPABLE of carrying work and its loop is already closed.
       and d.decision_status in ('accepted', 'modified')
       and (
         -- Case A: decided, and no action has been requested from it yet. Open, and the
         -- next move is the PM's.
         not exists (
           select 1
             from public.material_action_proposals a
            where a.workspace_id = d.workspace_id
              and a.project_id = d.project_id
              and a.source_decision_id = d.id
         )
         -- Or at least one branch beneath it is still unresolved.
         or exists (
           select 1
             from public.material_action_proposals a
            where a.workspace_id = d.workspace_id
              and a.project_id = d.project_id
              and a.source_decision_id = d.id
              and not exists (
                select 1
                  from public.execution_tasks t
                  join public.canonical_task_outcomes o
                    on o.workspace_id = t.workspace_id
                   and o.project_id = t.project_id
                   and o.task_id = t.id
                 where t.workspace_id = a.workspace_id
                   and t.project_id = a.project_id
                   -- P2-07's Action → Task link, read exactly as the projection reads it.
                   and t.source_payload ->> 'source' = 'governed_action'
                   and t.source_payload ->> 'sourceActionId' = a.id::text
                   and (
                     -- Superseded: a dead end the contract defines no transition out of.
                     o.state = 'superseded'
                     or (
                       -- A resolved result WITH the Observation that established it.
                       -- Achievement is not required: a negative or inconclusive result is
                       -- a completed loop, and calling it unfinished would tell a PM work
                       -- was continuing when they already had their answer.
                       o.state in ('achieved', 'partially_achieved', 'not_achieved', 'disputed', 'inconclusive')
                       and exists (
                         select 1
                           from public.canonical_outcome_observations ob
                          where ob.workspace_id = o.workspace_id
                            and ob.project_id = o.project_id
                            and ob.outcome_id = o.id
                       )
                     )
                   )
              )
         )
       )
  ) as open_journeys;

  return result;
end $$;

comment on function public.get_governed_execution_root(uuid, uuid) is
'UX-W4 authoritative membership of Decisions whose governed journey is OPEN, named as canonical ids from a single statement snapshot. Read-only projection; no write semantics.';

revoke all on function public.get_governed_execution_root(uuid, uuid) from public;
grant execute on function public.get_governed_execution_root(uuid, uuid) to authenticated;
