/**
 * P2-18 — Learning Candidate Eligibility and Lineage.
 *
 * Behavioural tests for the pure evaluator, the service (against a recording fake Supabase
 * client), the route handlers (with injected authorization) and source-level invariants of
 * the migration. Database-side behaviour — RLS, IDOR, idempotency, concurrency, supersession
 * and the atomic candidate event — is proven against the disposable local stack by
 * scripts/check-p2-18-db.mts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  deriveSourceValidity,
  toLearningCandidateView,
  type SourceValidityContext,
} from "@/lib/learning-candidates/eligibility";
import {
  LOOKUP_ROW_LIMIT,
  listLearningCandidates,
  proposeLearningCandidate,
} from "@/lib/learning-candidates/learning-candidate-service";
import { CAUSALITY_NOTE, LIMITATION_STATEMENTS, type LearningCandidateRow, type LearningCandidateSourceRow } from "@/lib/learning-candidates/types";
import { handleGetLearningCandidates, handlePostLearningCandidate } from "@/app/api/learning-candidates/route";

const ROOT = process.cwd();
const MIGRATION = readFileSync(path.join(ROOT, "supabase/migrations/20260914000000_p2_18_learning_candidate_lineage.sql"), "utf8");
const u = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;
const WS = u("a1");
const PROJECT = u("b1");
const OUTCOME = u("c1");
const OBS_NEW = u("d2");
const OBS_OLD = u("d1");
const EVAL = "2026-10-20T12:00:00.000Z";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────

function candidateRow(overrides: Partial<LearningCandidateRow> = {}): LearningCandidateRow {
  return {
    id: u("aa1"), workspace_id: WS, project_id: PROJECT, candidate_kind: "canonical_outcome_pattern",
    pattern_key: `canonical-outcome-pattern:v1:${"ab".repeat(32)}`,
    pattern_signature: { signalType: "decision_needed", recommendedActionType: "request_decision", actionClass: "external_write" },
    status: "proposed", evidence_tier: "single_lineage", lineage_count: 1, independent_lineage_count: 1,
    result_counts: { achieved: 1 }, confidence_score: "0.9000", confidence_method: "weakest_linked_observation:v1",
    causality_claim: "correlation_only",
    limitations: ["correlation_only", "structural_independence_only", "confidence_is_weakest_observation", "not_ratified"],
    version: 1, evidence_digest: "cd".repeat(32), evaluator: "pmfreak/learning-candidate-eligibility:v1", fixture_label: null,
    created_by: u("ee1"), created_at: EVAL, updated_at: EVAL, last_evaluated_at: EVAL, last_evaluated_by: u("ee1"),
    ...overrides,
  };
}

function sourceRow(overrides: Partial<LearningCandidateSourceRow> = {}): LearningCandidateSourceRow {
  return {
    id: u("bb1"), candidate_id: u("aa1"), workspace_id: WS, project_id: PROJECT, outcome_id: OUTCOME, observation_id: OBS_NEW,
    task_id: u("e1"), internal_execution_id: u("e2"), action_id: u("e3"), governance_evaluation_id: u("e4"), decision_id: u("e5"),
    recommendation_id: u("e6"), finding_id: u("e7"), finding_evidence_item_id: u("e8"), observation_evidence_ids: [u("e9")],
    observed_result: "achieved", observation_confidence: "0.9000", valid_until: "2026-11-01T00:00:00.000Z",
    correlation_id: "corr-lineage-1", causation_id: OUTCOME, evaluated_at: EVAL, linked_by: u("ee1"), recorded_at: EVAL,
    superseded_at: null, superseded_by_source_id: null, ...overrides,
  };
}

const validityContext = (overrides: Partial<SourceValidityContext> = {}): SourceValidityContext => ({
  evaluatedAtMs: new Date(EVAL).getTime(),
  latestObservationIdByOutcome: new Map([[OUTCOME, OBS_NEW]]),
  currentEvidenceIds: new Set([u("e9")]),
  ...overrides,
});

// ── Retention: source validity is derived from authoritative state, never a TTL ─────────

test("P2-18 retention: a source stops supporting its candidate only for an authoritative reason", () => {
  assert.equal(deriveSourceValidity(sourceRow(), validityContext()), "current");
  assert.equal(deriveSourceValidity(sourceRow({ superseded_at: EVAL, superseded_by_source_id: u("bb2") }), validityContext()), "superseded");
  assert.equal(deriveSourceValidity(sourceRow(), validityContext({ latestObservationIdByOutcome: new Map([[OUTCOME, u("d9")]]) })), "observation_not_latest");
  assert.equal(deriveSourceValidity(sourceRow({ valid_until: "2026-10-01T00:00:00.000Z" }), validityContext()), "past_valid_until");
  assert.equal(deriveSourceValidity(sourceRow(), validityContext({ currentEvidenceIds: new Set() })), "evidence_not_current");
  // No authoritative expiry → none is invented.
  assert.equal(deriveSourceValidity(sourceRow({ valid_until: null }), validityContext({ evaluatedAtMs: new Date("2099-01-01").getTime() })), "current");
});

test("P2-18 retention: a candidate without a current source reads as unsupported, but its lineage stays visible", () => {
  const view = toLearningCandidateView(candidateRow(), [sourceRow({ valid_until: "2026-10-01T00:00:00.000Z" })], validityContext());
  assert.equal(view.operationallySupported, false);
  assert.equal(view.currentSourceCount, 0);
  // The stored tier is explicitly a snapshot, and the read says it no longer reflects current sources.
  assert.equal(view.summaryBasis, "as_of_last_evaluation");
  assert.equal(view.summaryAsOf, EVAL);
  assert.equal(view.evidenceTier, "single_lineage", "the stored tier is returned as stored, never silently recomputed");
  assert.equal(view.summaryReflectsCurrentSources, false);
  assert.equal(toLearningCandidateView(candidateRow(), [sourceRow()], validityContext()).summaryReflectsCurrentSources, true);
  assert.equal(view.sources.length, 1, "historical lineage is still returned");
  assert.equal(view.status, "proposed", "stored status is untouched");
});

// ── Candidate ≠ organizational truth; correlation ≠ causation ──────────────────────────

test("P2-18 read contract: the correlation-only qualifier and limitations survive to every reader", () => {
  const view = toLearningCandidateView(candidateRow({ limitations: ["correlation_only", "future_unknown_code"] }), [sourceRow()], validityContext());
  assert.equal(view.causalityClaim, "correlation_only");
  assert.equal(view.causalityNote, CAUSALITY_NOTE);
  assert.match(view.causalityNote, /not a universal rule/);
  assert.deepEqual(view.limitations[0], { code: "correlation_only", statement: LIMITATION_STATEMENTS.correlation_only });
  assert.match(view.limitations[0].statement, /does not establish that the intervention caused them/);
  assert.equal(view.limitations[1].code, "future_unknown_code", "an unrecognised limitation is kept, never dropped");
  assert.equal(view.elevationInferred, false);
  assert.equal(view.candidateIsNotOrganizationalTruth, true);
  assert.equal(view.status, "proposed");
  assert.match(view.confidence.note, /not a probability that the pattern holds/);
  // Lineage references survive the read.
  assert.deepEqual(view.sources[0].references.observationEvidenceIds, [u("e9")]);
  assert.equal(view.sources[0].correlationId, "corr-lineage-1");
  assert.equal(view.sources[0].causationId, OUTCOME);
  assert.equal(view.sources[0].references.decisionId, u("e5"));
});

// ── Fake Supabase client ──────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type RpcCall = { name: string; args: Record<string, unknown> };

function fakeClient(tables: Record<string, Row[]> = {}, rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null }) {
  const rpcs: RpcCall[] = [];
  const reads: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
  const from = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    reads.push({ table, filters });
    let limit = Number.POSITIVE_INFINITY;
    const run = () => {
      let rows = (tables[table] ?? []).filter((r) => filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : (v as unknown[]).includes(r[c]))));
      rows = rows.slice(0, limit);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return b; },
      in: (c: string, v: unknown[]) => { filters.push(["in", c, v]); return b; },
      order: () => b,
      limit: (n: number) => { limit = n; return b; },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return b;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => { rpcs.push({ name, args }); return rpcResult; };
  return { client: { from, rpc } as never, rpcs, reads };
}

const scope = { workspaceId: WS, projectId: PROJECT, userId: u("ee1"), role: "pm" };

const createdResult = {
  disposition: "created",
  candidate: candidateRow(),
  source: sourceRow(),
  supersededSourceId: null,
  eventId: u("ev1"),
  elevationInferred: false,
};

// ── Service ───────────────────────────────────────────────────────────────────────────

test("P2-18 service: an eligible lineage calls the RPC with identifiers only — never a caller tier, pattern or lineage", async () => {
  const fake = fakeClient({}, { data: createdResult, error: null });
  const result = await proposeLearningCandidate(fake.client, scope, { outcomeId: OUTCOME });
  assert.equal(fake.rpcs.length, 1);
  assert.equal(fake.rpcs[0].name, "propose_canonical_learning_candidate");
  // No clock: the RPC evaluates at the database's own time. No Observation named: the latest.
  assert.deepEqual(fake.rpcs[0].args, { p_workspace_id: WS, p_project_id: PROJECT, p_outcome_id: OUTCOME, p_observation_id: null });
  await proposeLearningCandidate(fake.client, scope, { outcomeId: OUTCOME, observationId: OBS_NEW });
  assert.equal(fake.rpcs[1].args.p_observation_id, OBS_NEW, "a named Observation is passed through as the stale-context guard");
  assert.deepEqual(result, {
    disposition: "created", candidateId: u("aa1"), sourceId: u("bb1"), supersededSourceId: null, eventId: u("ev1"),
    evidenceTier: "single_lineage", version: 1, causalityClaim: "correlation_only", elevationInferred: false,
  });
});

test("P2-18 service: the database is the sole eligibility authority — its refusal is returned verbatim", async () => {
  const fake = fakeClient({}, { data: { disposition: "ineligible", reasons: ["decision_superseded", "observation_evidence_not_current"], candidate: null }, error: null });
  const result = await proposeLearningCandidate(fake.client, scope, { outcomeId: OUTCOME });
  assert.equal(result.disposition, "ineligible");
  assert.deepEqual((result as { reasons: string[] }).reasons, ["decision_superseded", "observation_evidence_not_current"]);
});

test("P2-18 service: success is never reported when persistence or event emission failed", async () => {
  const failed = fakeClient({}, { data: null, error: { message: "learning_candidate_write_denied" } });
  await assert.rejects(proposeLearningCandidate(failed.client, scope, { outcomeId: OUTCOME }), /write_denied/);
  // A material change reported without the event the same transaction must have written.
  const noEvent = fakeClient({}, { data: { ...createdResult, eventId: null }, error: null });
  await assert.rejects(proposeLearningCandidate(noEvent.client, scope, { outcomeId: OUTCOME }), /result_malformed/);
  const noSource = fakeClient({}, { data: { ...createdResult, source: null }, error: null });
  await assert.rejects(proposeLearningCandidate(noSource.client, scope, { outcomeId: OUTCOME }), /result_malformed/);
  const unknown = fakeClient({}, { data: { disposition: "ratified" }, error: null });
  await assert.rejects(proposeLearningCandidate(unknown.client, scope, { outcomeId: OUTCOME }), /result_malformed/);
  // A retry is a duplicate: no new event, and that is not an error.
  const duplicate = fakeClient({}, { data: { ...createdResult, disposition: "duplicate", eventId: null }, error: null });
  const dup = await proposeLearningCandidate(duplicate.client, scope, { outcomeId: OUTCOME });
  assert.equal(dup.disposition, "duplicate");
  assert.equal((dup as { eventId: string | null }).eventId, null);
});

test("P2-18 service: a viewer and a malformed id are refused before any write; an out-of-scope Outcome is refused by the RPC", async () => {
  const fake = fakeClient({}, { data: createdResult, error: null });
  await assert.rejects(proposeLearningCandidate(fake.client, { ...scope, role: "viewer" }, { outcomeId: OUTCOME }), /role_denied/);
  await assert.rejects(proposeLearningCandidate(fake.client, scope, { outcomeId: "not-a-uuid" }), /payload_invalid/);
  assert.equal(fake.rpcs.length, 0);
  // IDOR: the RPC refuses an Outcome outside the caller's scope; the service surfaces it.
  const idor = fakeClient({}, { data: null, error: { message: "learning_candidate_outcome_not_found" } });
  await assert.rejects(proposeLearningCandidate(idor.client, scope, { outcomeId: OUTCOME }), /outcome_not_found/);
});

test("P2-18 service: the list read is scoped, keeps lineage, and fails closed rather than truncating a lookup", async () => {
  const tables = {
    canonical_learning_candidates: [candidateRow(), candidateRow({ id: u("aa9"), project_id: u("b9"), workspace_id: u("a9") })],
    canonical_learning_candidate_sources: [sourceRow()],
    canonical_outcome_observations: [
      { id: OBS_OLD, outcome_id: OUTCOME, recorded_at: "2026-10-19T00:00:00.000Z", workspace_id: WS, project_id: PROJECT },
      { id: OBS_NEW, outcome_id: OUTCOME, recorded_at: "2026-10-20T00:00:00.000Z", workspace_id: WS, project_id: PROJECT },
    ],
    evidence_items: [{ id: u("e9"), workspace_id: WS, project_id: PROJECT, normalized_event_id: u("n1"), fixture_state: "LIVE", freshness_state: "CURRENT", lifecycle: "RECORDED", rejection_reason: null, degraded_reason: null, evaluated_at: EVAL, stale_at: null }],
  };
  const fake = fakeClient(tables);
  const list = await listLearningCandidates(fake.client, { workspaceId: WS, projectId: PROJECT }, { evaluatedAt: EVAL });
  assert.equal(list.candidates.length, 1, "another tenant's candidate is never returned");
  assert.equal(list.truncated, false);
  assert.equal(list.candidates[0].sources[0].validity, "current");
  for (const read of fake.reads) {
    assert.ok(read.filters.some(([op, c, v]) => op === "eq" && c === "workspace_id" && v === WS), `${read.table} is workspace-scoped`);
    assert.ok(read.filters.some(([op, c, v]) => op === "eq" && c === "project_id" && v === PROJECT), `${read.table} is project-scoped`);
  }

  // A known, finite id set is resolved completely: 1000 Evidence ids are read in chunks, and
  // every one of them is seen (a silently truncated lookup would mark the source not current).
  const many = Array.from({ length: LOOKUP_ROW_LIMIT }, (_, i) => ({ ...tables.evidence_items[0], id: u(`f${i}`) }));
  const complete = fakeClient({ ...tables, canonical_learning_candidate_sources: [sourceRow({ observation_evidence_ids: many.map((e) => e.id) })], evidence_items: many });
  const resolved = await listLearningCandidates(complete.client, { workspaceId: WS, projectId: PROJECT }, { evaluatedAt: EVAL });
  assert.equal(resolved.candidates[0].sources[0].validity, "current");
  assert.ok(complete.reads.filter((r) => r.table === "evidence_items").length >= 5, "Evidence is read in several bounded chunks");

  // A single lookup that reaches the server's row cap may be incomplete, so it fails closed.
  const crowded = Array.from({ length: LOOKUP_ROW_LIMIT }, (_, i) => ({ id: u(`c${i}`), outcome_id: OUTCOME, recorded_at: EVAL, workspace_id: WS, project_id: PROJECT }));
  const capped = fakeClient({ ...tables, canonical_outcome_observations: crowded });
  await assert.rejects(listLearningCandidates(capped.client, { workspaceId: WS, projectId: PROJECT }, { evaluatedAt: EVAL }), /read_truncated/);
});

// ── Route ─────────────────────────────────────────────────────────────────────────────

const post = (body: unknown) => new NextRequest("http://localhost/api/learning-candidates", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const allow = (role = "pm") => async () => ({ ok: true as const, userId: u("ee1"), role, client: {} as never });

test("P2-18 route: authentication, role and malformed identifiers are refused before any evaluation", async () => {
  let proposed = 0;
  const propose = async () => { proposed += 1; return createdResult as never; };
  assert.equal((await handlePostLearningCandidate(post({ workspaceId: WS, projectId: PROJECT, outcomeId: OUTCOME }), { authorize: async () => ({ ok: false, status: 401 }), propose })).status, 401);
  assert.equal((await handlePostLearningCandidate(post({ workspaceId: WS, projectId: PROJECT, outcomeId: OUTCOME }), { authorize: async () => ({ ok: false, status: 403 }), propose })).status, 403);
  assert.equal((await handlePostLearningCandidate(post({ workspaceId: WS, projectId: PROJECT, outcomeId: "x" }), { authorize: allow(), propose })).status, 400);
  assert.equal((await handlePostLearningCandidate(post({ workspaceId: "forged", projectId: PROJECT, outcomeId: OUTCOME }), { authorize: allow(), propose })).status, 400);
  // Valid JSON that is not an object is refused as 400, never an unhandled 500.
  for (const body of [null, [], 42, "text"]) {
    assert.equal((await handlePostLearningCandidate(post(body), { authorize: allow(), propose })).status, 400, `body ${JSON.stringify(body)}`);
  }
  assert.equal(proposed, 0);
});

test("P2-18 route: no clock is forwarded — a caller-supplied evaluatedAt never reaches the evaluation", async () => {
  let seen: Record<string, unknown> = {};
  const propose = (async (_c: unknown, _s: unknown, input: Record<string, unknown>) => { seen = input; return { disposition: "created", candidateId: u("aa1"), sourceId: u("bb1"), supersededSourceId: null, eventId: u("ev1"), evidenceTier: "single_lineage", version: 1, causalityClaim: "correlation_only", elevationInferred: false }; }) as never;
  const response = await handlePostLearningCandidate(post({ workspaceId: WS, projectId: PROJECT, outcomeId: OUTCOME, evaluatedAt: "1999-01-01T00:00:00.000Z" }), { authorize: allow(), propose, now: () => new Date(EVAL) });
  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(seen).sort(), ["observationId", "outcomeId"], "only identifiers reach the RPC; the database supplies the clock");
  const body = await response.json();
  assert.equal(body.causalityClaim, "correlation_only");
  assert.equal(body.elevationInferred, false);
});

test("P2-18 route: dispositions map to honest statuses", async () => {
  const run = (result: unknown) => handlePostLearningCandidate(post({ workspaceId: WS, projectId: PROJECT, outcomeId: OUTCOME }), { authorize: allow(), propose: (async () => result) as never, now: () => new Date(EVAL) });
  assert.equal((await run({ disposition: "duplicate", candidateId: u("aa1"), sourceId: u("bb1"), eventId: null })).status, 200);
  assert.equal((await run({ disposition: "evidence_linked", candidateId: u("aa1"), sourceId: u("bb1"), eventId: u("e") })).status, 200);
  const ineligible = await run({ disposition: "ineligible", reasons: ["task_not_completed"], elevationInferred: false });
  assert.equal(ineligible.status, 422);
  assert.equal((await ineligible.json()).ok, false);
  const failing = (message: string) => handlePostLearningCandidate(post({ workspaceId: WS, projectId: PROJECT, outcomeId: OUTCOME }), { authorize: allow(), propose: (async () => { throw new Error(message); }) as never });
  assert.equal((await failing("learning_candidate_outcome_not_found")).status, 404);
  assert.equal((await failing("learning_candidate_observation_not_found")).status, 404);
  assert.equal((await failing("learning_candidate_write_denied")).status, 403);
  const invalid = await failing("learning_candidate_rpc_failed: learning_candidate_payload_invalid");
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).failureClass, "learning_candidate_payload_invalid", "a handled refusal names its most specific stable code");
  const internal = await failing("some unexpected database detail");
  assert.equal(internal.status, 500);
  assert.doesNotMatch(JSON.stringify(await internal.json()), /database detail/, "raw provider errors are not leaked");
});

test("P2-18 route: reads require project access and return the scoped list", async () => {
  const get = new NextRequest(`http://localhost/api/learning-candidates?workspaceId=${WS}&projectId=${PROJECT}`);
  assert.equal((await handleGetLearningCandidates(get, { authorize: async () => ({ ok: false, status: 403 }) })).status, 403);
  let listed: unknown = null;
  const response = await handleGetLearningCandidates(get, { authorize: allow("viewer"), list: (async (_c: unknown, s: unknown) => { listed = s; return { evaluatedAt: EVAL, candidates: [], truncated: false }; }) as never, now: () => new Date(EVAL) });
  assert.equal(response.status, 200);
  assert.deepEqual(listed, { workspaceId: WS, projectId: PROJECT });
  assert.equal((await response.json()).canPropose, false, "a viewer can read but not propose");
});

// ── Migration invariants (source-level; runtime proof is scripts/check-p2-18-db.mts) ─────

const sqlBody = MIGRATION.replace(/--.*$/gm, "");

test("P2-18 migration: additive only — it creates new objects and alters or drops nothing existing", () => {
  assert.doesNotMatch(sqlBody, /\balter\s+table\s+(?!public\.canonical_learning_candidate)/i);
  assert.doesNotMatch(sqlBody, /\bdrop\s+(table|column|function|index|type|schema)\b/i);
  assert.doesNotMatch(sqlBody, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sqlBody, /\btruncate\s+(table\s+)?public\./i, "no TRUNCATE statement (the grant revocation naming the privilege is fine)");
  for (const m of sqlBody.matchAll(/drop\s+(policy|trigger)\s+if\s+exists\s+\w+\s+on\s+public\.(\w+)/gi)) {
    assert.match(m[2], /^canonical_learning_candidate/, `only P2-18's own ${m[1]}s are replaced`);
  }
  assert.doesNotMatch(sqlBody, /\bupdate\s+public\.(?!canonical_learning_candidate)/i, "no existing table is updated");
});

test("P2-18 migration: RLS is read-only for project members; every write goes through the RPC", () => {
  for (const table of ["canonical_learning_candidates", "canonical_learning_candidate_sources"]) {
    assert.match(sqlBody, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sqlBody, new RegExp(`on public\\.${table}\\s+for select to authenticated\\s+using \\(public\\.can_access_operational_project\\(workspace_id, project_id\\)\\)`));
    // service_role bypasses RLS and gets full DML by default, so it is revoked too.
    assert.match(sqlBody, new RegExp(`revoke all on public\\.${table} from anon, authenticated, service_role`));
    assert.match(sqlBody, new RegExp(`grant select on public\\.${table} to authenticated, service_role;`));
    assert.doesNotMatch(sqlBody, new RegExp(`grant (all|insert|update|delete|truncate)[^;]* on public\\.${table}`, "i"));
    assert.doesNotMatch(sqlBody, new RegExp(`for (insert|update|delete|all)[^;]*on public\\.${table}|on public\\.${table}\\s+for (insert|update|delete|all)`));
  }
  assert.match(sqlBody, /before update or delete on public\.canonical_learning_candidate_sources/);
  assert.match(sqlBody, /raise exception 'learning_candidate_provenance_immutable'/);
});

test("P2-18 migration: the RPC authenticates, authorises, pins search_path, serialises and trusts no caller tier or lineage", () => {
  const fn = sqlBody.slice(sqlBody.indexOf("create or replace function public.propose_canonical_learning_candidate("));
  const signature = fn.slice(0, fn.indexOf(")"));
  assert.deepEqual([...signature.matchAll(/\bp_\w+/g)].map((m) => m[0]), ["p_workspace_id", "p_project_id", "p_outcome_id", "p_observation_id"]);
  assert.doesNotMatch(sqlBody, /p_evaluated_at/, "the caller cannot supply (or backdate) the evaluation clock");
  assert.match(fn, /v_evaluated_at timestamptz := now\(\);/, "the evaluation clock is the database's");
  // A retry of an already-linked Observation is a duplicate BEFORE current eligibility is judged.
  const firstDuplicate = fn.indexOf("'disposition', 'duplicate'");
  assert.ok(firstDuplicate > 0 && firstDuplicate < fn.indexOf("v_reasons := array_append("), "duplicate is detected before any eligibility reason is collected");
  // The Finding's Evidence meets the complete canonical-live predicate at the clock.
  assert.match(fn, /v_finding_evidence\.lifecycle <> 'RECORDED'[\s\S]*v_finding_evidence\.stale_at <= v_evaluated_at[\s\S]*'finding_evidence_not_current'/);
  // The snapshot is recomputed only over sources valid at the clock.
  assert.match(fn, /s\.valid_until is null or s\.valid_until > v_evaluated_at/);
  assert.match(fn, /where s\.id = any\(v_valid_source_ids\);/);
  assert.match(fn, /security definer\s+set search_path = pg_catalog, public, extensions/);
  assert.match(fn, /v_actor := auth\.uid\(\);\s+if v_actor is null then\s+raise exception 'unauthenticated'/);
  assert.match(fn, /can_write_operational_project\(p_workspace_id, p_project_id\)/);
  assert.match(fn, /pg_advisory_xact_lock\(hashtextextended\(\s*'learning-candidate:'/);
  assert.match(fn, /'weakest_linked_observation:v1', 'correlation_only'/, "the function writes the causality qualifier itself");
  assert.match(sqlBody, /revoke all on function public\.propose_canonical_learning_candidate\([^)]*\) from public/);
  assert.match(sqlBody, /revoke execute on function public\.propose_canonical_learning_candidate\([^)]*\) from anon/);
  assert.doesNotMatch(sqlBody, /repeat\('0'/, "no placeholder hash");
  // text[] || 'literal' parses the literal as an ARRAY ("malformed array literal"): found by the
  // live verifier on the first ineligible path. Every append is explicit.
  assert.doesNotMatch(fn, /v_(reasons|limitations)\s*:=\s*v_\w+\s*\|\|\s*'/, "array appends use array_append");
  assert.doesNotMatch(sqlBody, /operational_is_service_role|to service_role\s*;\s*$/im, "no service-role transport");
  assert.doesNotMatch(sqlBody, /grant execute[^;]*to[^;]*service_role/i, "the RPC is not granted to service_role explicitly");
  for (const m of sqlBody.matchAll(/^.*service_role.*$/gim)) {
    assert.match(m[0], /^(revoke all on public\.canonical_learning_candidate(s|_sources) from anon, authenticated, service_role;|grant select on public\.canonical_learning_candidate(s|_sources) to authenticated, service_role;)$/, `only the revoke and the SELECT grant name service_role: ${m[0]}`);
  }
});

test("P2-18 migration: the candidate event is written in the same transaction and never implies elevation", () => {
  const fn = sqlBody.slice(sqlBody.indexOf("create or replace function public.propose_canonical_learning_candidate("));
  const insertAt = fn.indexOf("insert into public.platform_events");
  assert.ok(insertAt > fn.indexOf("insert into public.canonical_learning_candidate_sources"), "the event follows the source write in one function body");
  assert.match(fn, /'CANONICAL_OUTCOME_LEARNING_CANDIDATE_V1'/);
  assert.match(fn, /'eventType', 'canonical_outcome_learning_candidate\.v1'/);
  assert.match(fn, /'elevationInferred', false/);
  assert.match(fn, /'candidateIsNotOrganizationalTruth', true/);
  // The duplicate branch returns before any write or event.
  const duplicateAt = fn.indexOf("'disposition', 'duplicate'");
  assert.ok(duplicateAt > 0 && duplicateAt < fn.indexOf("insert into public.canonical_learning_candidate_sources"));
});

test("P2-18 boundary: no review, validation, rejection, elevation, ratification or revocation is implemented", () => {
  assert.match(sqlBody, /check \(status = 'proposed'\)/);
  for (const state of ["reviewing", "validated", "rejected", "elevation_requested", "elevation-requested", "ratified", "revoked_candidate"]) {
    assert.doesNotMatch(sqlBody, new RegExp(`'${state}'`), `no '${state}' state is written or allowed`);
  }
  assert.doesNotMatch(sqlBody, /organizational_patterns|constitutional_learning|constitutional_signatures|ratification/i, "no existing learning or ratification model is touched");
  // Code only: comments are allowed to say what the route does NOT do.
  const route = readFileSync(path.join(ROOT, "src/app/api/learning-candidates/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.deepEqual([...route.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]).filter((n) => /^[A-Z]+$/.test(n)), ["GET", "POST"]);
  assert.doesNotMatch(route, /ratif|elevat(e|ion)Request|validateCandidate|rejectCandidate|revokeCandidate/i);
});

test("P2-18 compatibility: the reserved P2-09 candidate payload is preserved unchanged", () => {
  const p209 = readFileSync(path.join(ROOT, "supabase/migrations/20260906000000_p2_09_outcome_observation_contract.sql"), "utf8");
  assert.match(p209, /'learningCandidate', jsonb_build_object\(\s*'eventType', 'canonical_outcome_learning_candidate\.v1'/);
});
