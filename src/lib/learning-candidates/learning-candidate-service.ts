/**
 * P2-18 — Learning Candidate service.
 *
 * Every read and write runs on the CALLER'S request-scoped (RLS) client. Proposing a
 * candidate is one authenticated RPC (propose_canonical_learning_candidate) that re-derives
 * eligibility, pattern identity, tier and confidence from canonical rows and writes the
 * source link, the candidate version and the platform event in one transaction. No service
 * role is used: nothing here needs to be trusted beyond the caller's own authority.
 *
 * Authority: the same predicate as the operation that produces the reserved candidate
 * payload, record_canonical_outcome_observation — can_write_operational_project in the
 * database, canCreateOperationalEvidence here as an early refusal.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { canCreateOperationalEvidence } from "@/lib/operational-flow/authority";
import { getCompleteLineageProjection } from "@/lib/operational-flow/operational-flow-service";
import { preflightLearningCandidateEligibility, toLearningCandidateView } from "./eligibility";
import {
  LEARNING_CANDIDATE_RPC,
  type LearningCandidateEvidenceTier,
  type LearningCandidateRow,
  type LearningCandidateSourceRow,
  type LearningCandidateView,
  type ProposeLearningCandidateResult,
} from "./types";

type Client = SupabaseClient;

export type LearningCandidateScope = { workspaceId: string; projectId: string; userId: string; role: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Candidates read per request. A full page is reported as truncated, never as complete. */
export const LEARNING_CANDIDATE_PAGE_SIZE = 200;
/** Ids per id-keyed lookup: a known, finite id set is always resolved completely. */
const LOOKUP_CHUNK = 200;
/** Outcomes per Observation lookup: an Outcome can carry several Observations. */
const OBSERVATION_LOOKUP_CHUNK = 50;
/**
 * PostgREST caps every response (supabase/config.toml max_rows = 1000). A lookup that
 * reaches the cap may be incomplete, so it fails closed instead of being read as complete.
 */
export const LOOKUP_ROW_LIMIT = 1000;

function fail(code: string, error?: { message?: string } | null): never {
  throw new Error(error?.message ? `${code}: ${error.message}` : code);
}

export async function proposeLearningCandidate(
  client: Client,
  scope: LearningCandidateScope,
  input: { outcomeId: string; observationId?: string | null; evaluatedAt: string },
  deps: { getLineage?: typeof getCompleteLineageProjection } = {},
): Promise<ProposeLearningCandidateResult> {
  if (!canCreateOperationalEvidence(scope.role)) throw new Error("learning_candidate_role_denied");
  if (!UUID_PATTERN.test(input.outcomeId) || (input.observationId && !UUID_PATTERN.test(input.observationId))) {
    throw new Error("learning_candidate_payload_invalid");
  }
  const evaluatedAt = new Date(input.evaluatedAt);
  if (Number.isNaN(evaluatedAt.valueOf())) throw new Error("learning_candidate_payload_invalid");

  const getLineage = deps.getLineage ?? getCompleteLineageProjection;
  const projections = await getLineage(client, scope.workspaceId, scope.projectId, { outcomeId: input.outcomeId });
  const projection = projections.find((p) => p.outcomeId === input.outcomeId);
  if (!projection) throw new Error("learning_candidate_outcome_not_found");

  const preflight = preflightLearningCandidateEligibility(projection, { observationId: input.observationId ?? null });
  if (!preflight.eligible) {
    return { disposition: "ineligible", reasons: preflight.reasons, gaps: preflight.gaps, elevationInferred: false };
  }

  const { data, error } = await client.rpc(LEARNING_CANDIDATE_RPC, {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_outcome_id: input.outcomeId,
    p_observation_id: input.observationId ?? preflight.latestObservationId,
    p_evaluated_at: evaluatedAt.toISOString(),
  });
  if (error) fail("learning_candidate_rpc_failed", error);
  const result = (data ?? null) as Record<string, unknown> | null;
  const disposition = result?.disposition;

  if (disposition === "ineligible") {
    const reasons = Array.isArray(result?.reasons) ? (result.reasons as unknown[]).map(String) : [];
    return { disposition: "ineligible", reasons, gaps: preflight.gaps, elevationInferred: false };
  }
  if (disposition !== "created" && disposition !== "evidence_linked" && disposition !== "evidence_superseded" && disposition !== "duplicate") {
    fail("learning_candidate_result_malformed");
  }
  const candidate = (result?.candidate ?? null) as Partial<LearningCandidateRow> | null;
  const source = (result?.source ?? null) as Partial<LearningCandidateSourceRow> | null;
  // Never report success without the persisted candidate AND source (and, for a material
  // change, the event the same transaction wrote).
  if (!candidate?.id || !source?.id || (disposition !== "duplicate" && !result?.eventId)) fail("learning_candidate_result_malformed");
  return {
    disposition,
    candidateId: String(candidate.id),
    sourceId: String(source.id),
    supersededSourceId: result?.supersededSourceId ? String(result.supersededSourceId) : null,
    eventId: result?.eventId ? String(result.eventId) : null,
    evidenceTier: candidate.evidence_tier as LearningCandidateEvidenceTier,
    version: Number(candidate.version),
    causalityClaim: String(candidate.causality_claim),
    elevationInferred: false,
  };
}

async function inChunks<T>(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  chunkSize = LOOKUP_CHUNK,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await read(ids.slice(i, i + chunkSize));
    if (error) fail("learning_candidate_read_failed", error);
    const page = (data ?? []) as T[];
    if (page.length >= LOOKUP_ROW_LIMIT) fail("learning_candidate_read_truncated");
    rows.push(...page);
  }
  return rows;
}

export type LearningCandidateList = { evaluatedAt: string; candidates: LearningCandidateView[]; truncated: boolean };

export async function listLearningCandidates(
  client: Client,
  scope: Pick<LearningCandidateScope, "workspaceId" | "projectId">,
  options: { evaluatedAt: string },
): Promise<LearningCandidateList> {
  const evaluatedAt = new Date(options.evaluatedAt);
  if (Number.isNaN(evaluatedAt.valueOf())) throw new Error("learning_candidate_payload_invalid");
  const evaluatedAtMs = evaluatedAt.getTime();

  const page = await client.from("canonical_learning_candidates")
    .select("id,workspace_id,project_id,candidate_kind,pattern_key,pattern_signature,status,evidence_tier,lineage_count,independent_lineage_count,result_counts,confidence_score,confidence_method,causality_claim,limitations,version,evidence_digest,evaluator,fixture_label,created_by,created_at,updated_at,last_evaluated_at,last_evaluated_by")
    .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
    .order("updated_at", { ascending: false }).order("id", { ascending: true })
    .limit(LEARNING_CANDIDATE_PAGE_SIZE + 1);
  if (page.error) fail("learning_candidate_read_failed", page.error);
  const fetched = (page.data ?? []) as LearningCandidateRow[];
  const truncated = fetched.length > LEARNING_CANDIDATE_PAGE_SIZE;
  const candidates = fetched.slice(0, LEARNING_CANDIDATE_PAGE_SIZE);
  if (candidates.length === 0) return { evaluatedAt: evaluatedAt.toISOString(), candidates: [], truncated };

  const sources = await inChunks<LearningCandidateSourceRow>(candidates.map((c) => c.id), (chunk) =>
    client.from("canonical_learning_candidate_sources")
      .select("id,candidate_id,workspace_id,project_id,outcome_id,observation_id,task_id,internal_execution_id,action_id,governance_evaluation_id,decision_id,recommendation_id,finding_id,finding_evidence_item_id,observation_evidence_ids,observed_result,observation_confidence,valid_until,correlation_id,causation_id,evaluated_at,linked_by,recorded_at,superseded_at,superseded_by_source_id")
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId).in("candidate_id", chunk)
      .limit(LOOKUP_ROW_LIMIT));

  const outcomeIds = [...new Set(sources.map((s) => s.outcome_id))].sort();
  const observations = await inChunks<{ id: string; outcome_id: string; recorded_at: string }>(outcomeIds, (chunk) =>
    client.from("canonical_outcome_observations")
      .select("id,outcome_id,recorded_at")
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId).in("outcome_id", chunk)
      .limit(LOOKUP_ROW_LIMIT), OBSERVATION_LOOKUP_CHUNK);
  const latestObservationIdByOutcome = new Map<string, { id: string; recordedAt: string }>();
  for (const obs of observations) {
    const prior = latestObservationIdByOutcome.get(obs.outcome_id);
    // P2-10's rule: newest recorded_at first; id breaks a tie deterministically.
    if (!prior || prior.recordedAt < obs.recorded_at || (prior.recordedAt === obs.recorded_at && prior.id < obs.id)) {
      latestObservationIdByOutcome.set(obs.outcome_id, { id: obs.id, recordedAt: obs.recorded_at });
    }
  }

  const evidenceIds = [...new Set(sources.flatMap((s) => s.observation_evidence_ids))].sort();
  const evidence = await inChunks<Record<string, unknown>>(evidenceIds, (chunk) =>
    client.from("evidence_items")
      .select("id,normalized_event_id,fixture_state,freshness_state,lifecycle,rejection_reason,degraded_reason,evaluated_at,stale_at")
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId).in("id", chunk)
      .limit(LOOKUP_ROW_LIMIT));
  // P2-09's promotion rule, applied at the read clock.
  const currentEvidenceIds = new Set(
    evidence
      .filter((e) =>
        e.normalized_event_id !== null && e.fixture_state === "LIVE" && e.freshness_state === "CURRENT" && e.lifecycle === "RECORDED"
        && e.rejection_reason === null && e.degraded_reason === null && e.evaluated_at !== null
        && (e.stale_at === null || new Date(String(e.stale_at)).getTime() > evaluatedAtMs))
      .map((e) => String(e.id)),
  );

  const ctx = {
    evaluatedAtMs,
    latestObservationIdByOutcome: new Map([...latestObservationIdByOutcome].map(([outcome, v]) => [outcome, v.id])),
    currentEvidenceIds,
  };
  return {
    evaluatedAt: evaluatedAt.toISOString(),
    candidates: candidates.map((c) => toLearningCandidateView(c, sources, ctx)),
    truncated,
  };
}
