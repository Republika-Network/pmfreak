/**
 * P2-18 — deterministic, pure Learning Candidate evaluation.
 *
 *   preflightLearningCandidateEligibility  judges one outcome lineage from the P2-10
 *       CompleteLineageProjection (the canonical, gap-aware, never-invent-links projection).
 *       It is an early, explainable refusal; the propose_canonical_learning_candidate RPC
 *       re-derives every rule from canonical rows and is the authority.
 *   deriveSourceValidity                  whether a stored source still supports its
 *       candidate at a given clock. Retention is derived from authoritative source validity
 *       only; no duration is ever synthesised.
 *   toLearningCandidateView               the read contract. It carries the causality
 *       qualifier and the limitation statements verbatim, so no reader can drop them.
 *
 * Same inputs → same output: no wall clock, no randomness, no I/O.
 */
import type { CompleteLineageProjection } from "@/lib/operational-flow/types";
import {
  CAUSALITY_NOTE,
  SUMMARY_BASIS_NOTE,
  LEARNING_CANDIDATE_CONTRACT,
  LIMITATION_STATEMENTS,
  type LearningCandidateIneligibilityReason,
  type LearningCandidateLimitationCode,
  type LearningCandidateRow,
  type LearningCandidateSourceRow,
  type LearningCandidateSourceValidity,
  type LearningCandidateSourceView,
  type LearningCandidateView,
} from "./types";

const QUALIFYING_RESULTS = new Set(["achieved", "partial", "failed"]);

const LINEAGE_STATUS_REASON: Record<CompleteLineageProjection["lineageStatus"], LearningCandidateIneligibilityReason | null> = {
  complete: null,
  incomplete: "lineage_incomplete",
  disputed: "lineage_disputed",
  inconclusive: "lineage_inconclusive",
  degraded: "lineage_degraded",
};

export type LearningCandidatePreflight = {
  eligible: boolean;
  reasons: LearningCandidateIneligibilityReason[];
  gaps: string[];
  /** The Observation the lineage currently ends at (P2-10: newest recorded first). */
  latestObservationId: string | null;
};

export function preflightLearningCandidateEligibility(
  projection: CompleteLineageProjection,
  request: { observationId?: string | null } = {},
): LearningCandidatePreflight {
  const reasons = new Set<LearningCandidateIneligibilityReason>();
  if (projection.isFixture) reasons.add("lineage_fixture");
  const statusReason = LINEAGE_STATUS_REASON[projection.lineageStatus];
  if (statusReason) reasons.add(statusReason);

  const latest = projection.steps.find((s) => s.kind === "observation" && s.id !== null) ?? null;
  const latestObservationId = latest?.id ?? null;
  if (!latestObservationId) reasons.add("observation_missing");
  if (request.observationId && latestObservationId && request.observationId !== latestObservationId) {
    reasons.add("observation_not_latest");
  }
  if (latestObservationId && !QUALIFYING_RESULTS.has(String(projection.latestObservationState))) {
    reasons.add("observation_result_not_qualifying");
  }
  if (projection.outcomeState === "superseded") reasons.add("outcome_superseded");

  const sorted = [...reasons].sort();
  return { eligible: sorted.length === 0, reasons: sorted, gaps: [...projection.gaps], latestObservationId };
}

export type SourceValidityContext = {
  /** Read clock (explicit; never Date.now() inside this module). */
  evaluatedAtMs: number;
  /** Latest Observation id per Outcome, as currently recorded. */
  latestObservationIdByOutcome: ReadonlyMap<string, string>;
  /** Evidence ids that still meet P2-09's promotion rule at the read clock. */
  currentEvidenceIds: ReadonlySet<string>;
};

export function deriveSourceValidity(source: LearningCandidateSourceRow, ctx: SourceValidityContext): LearningCandidateSourceValidity {
  if (source.superseded_at) return "superseded";
  if (ctx.latestObservationIdByOutcome.get(source.outcome_id) !== source.observation_id) return "observation_not_latest";
  if (source.valid_until && new Date(source.valid_until).getTime() <= ctx.evaluatedAtMs) return "past_valid_until";
  if (!source.observation_evidence_ids.every((id) => ctx.currentEvidenceIds.has(id))) return "evidence_not_current";
  return "current";
}

function limitationView(code: string): { code: string; statement: string } {
  const known = LIMITATION_STATEMENTS[code as LearningCandidateLimitationCode];
  return { code, statement: known ?? `Unrecognized limitation code "${code}" (kept verbatim; not dropped).` };
}

function toSourceView(source: LearningCandidateSourceRow, validity: LearningCandidateSourceValidity): LearningCandidateSourceView {
  return {
    id: source.id,
    outcomeId: source.outcome_id,
    observationId: source.observation_id,
    observedResult: source.observed_result,
    observationConfidence: Number(source.observation_confidence),
    validUntil: source.valid_until,
    validity,
    correlationId: source.correlation_id,
    causationId: source.causation_id,
    evaluatedAt: source.evaluated_at,
    recordedAt: source.recorded_at,
    supersededAt: source.superseded_at,
    references: {
      taskId: source.task_id,
      internalExecutionId: source.internal_execution_id,
      actionId: source.action_id,
      governanceEvaluationId: source.governance_evaluation_id,
      decisionId: source.decision_id,
      recommendationId: source.recommendation_id,
      findingId: source.finding_id,
      findingEvidenceItemId: source.finding_evidence_item_id,
      observationEvidenceIds: [...source.observation_evidence_ids],
    },
  };
}

export function toLearningCandidateView(
  candidate: LearningCandidateRow,
  sources: readonly LearningCandidateSourceRow[],
  ctx: SourceValidityContext,
): LearningCandidateView {
  const views = sources
    .filter((s) => s.candidate_id === candidate.id)
    .map((s) => toSourceView(s, deriveSourceValidity(s, ctx)))
    .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id < b.id ? -1 : 1));
  const currentSourceCount = views.filter((s) => s.validity === "current").length;
  // Sources the stored snapshot counted: those not superseded when it was taken.
  const snapshotSources = views.filter((s) => s.supersededAt === null);
  return {
    contract: LEARNING_CANDIDATE_CONTRACT,
    id: candidate.id,
    workspaceId: candidate.workspace_id,
    projectId: candidate.project_id,
    status: candidate.status,
    patternKey: candidate.pattern_key,
    pattern: { ...candidate.pattern_signature },
    evidenceTier: candidate.evidence_tier,
    lineageCount: candidate.lineage_count,
    independentLineageCount: candidate.independent_lineage_count,
    resultCounts: { ...candidate.result_counts },
    confidence: {
      value: Number(candidate.confidence_score),
      method: candidate.confidence_method,
      scale: "unit_interval",
      note: LIMITATION_STATEMENTS.confidence_is_weakest_observation,
    },
    causalityClaim: candidate.causality_claim,
    causalityNote: CAUSALITY_NOTE,
    limitations: candidate.limitations.map(limitationView),
    version: candidate.version,
    evidenceDigest: candidate.evidence_digest,
    evaluator: candidate.evaluator,
    fixture: candidate.fixture_label !== null,
    fixtureLabel: candidate.fixture_label,
    summaryBasis: "as_of_last_evaluation",
    summaryAsOf: candidate.last_evaluated_at,
    summaryNote: SUMMARY_BASIS_NOTE,
    summaryReflectsCurrentSources: snapshotSources.length === candidate.lineage_count && snapshotSources.every((s) => s.validity === "current"),
    operationallySupported: currentSourceCount > 0,
    currentSourceCount,
    sources: views,
    elevationInferred: false,
    candidateIsNotOrganizationalTruth: true,
    createdAt: candidate.created_at,
    updatedAt: candidate.updated_at,
    lastEvaluatedAt: candidate.last_evaluated_at,
  };
}
