/**
 * P2-18 — deterministic, pure Learning Candidate read evaluation.
 *
 * Eligibility itself is decided in one place only: the propose_canonical_learning_candidate
 * RPC, which derives every rule from canonical rows at the database clock.
 *
 *   deriveSourceValidity                  whether a stored source still supports its
 *       candidate at a given clock. Retention is derived from authoritative source validity
 *       only; no duration is ever synthesised.
 *   toLearningCandidateView               the read contract. It carries the causality
 *       qualifier and the limitation statements verbatim, so no reader can drop them.
 *
 * Same inputs → same output: no wall clock, no randomness, no I/O.
 */
import {
  CAUSALITY_NOTE,
  SUMMARY_BASIS_NOTE,
  LEARNING_CANDIDATE_CONTRACT,
  LIMITATION_STATEMENTS,
  type LearningCandidateLimitationCode,
  type LearningCandidateRow,
  type LearningCandidateSourceRow,
  type LearningCandidateSourceValidity,
  type LearningCandidateSourceView,
  type LearningCandidateView,
} from "./types";

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
    // The snapshot counted the sources valid at the last evaluation; if the sources valid now
    // differ in number, it no longer describes the current evidence.
    summaryReflectsCurrentSources: currentSourceCount === candidate.lineage_count,
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
