/**
 * P2-18 — Learning Candidate contract.
 *
 * A Learning Candidate is a NON-AUTHORITATIVE, project-local pattern hypothesis over
 * canonical outcome lineages (PMFREAK_PRODUCT_BASELINE_V2: "Non-authoritative pattern
 * hypothesis; pattern, cohort, evidence, limitations, confidence, owner … no automatic
 * elevation"). Creating one never ratifies it, never makes it organizational truth and
 * never starts review: review, validation, rejection, elevation, ratification and
 * revocation are P2-19.
 *
 * Persistence: supabase/migrations/20260914000000_p2_18_learning_candidate_lineage.sql
 * (canonical_learning_candidates + canonical_learning_candidate_sources, written only by
 * the propose_canonical_learning_candidate RPC).
 */

import type { CanonicalLearningCandidateRow, CanonicalLearningCandidateSourceRow } from "@/lib/db/database-contract";

export const LEARNING_CANDIDATE_CONTRACT = "pmfreak/learning-candidate:v1" as const;
/** Reserved in P2-09 (record_canonical_outcome_observation); persisted from P2-18 on. */
export const LEARNING_CANDIDATE_EVENT_TYPE = "canonical_outcome_learning_candidate.v1" as const;
export const LEARNING_CANDIDATE_PLATFORM_EVENT_TYPE = "CANONICAL_OUTCOME_LEARNING_CANDIDATE_V1" as const;
export const LEARNING_CANDIDATE_EVALUATOR = "pmfreak/learning-candidate-eligibility:v1" as const;
export const LEARNING_CANDIDATE_CONFIDENCE_METHOD = "weakest_linked_observation:v1" as const;
export const LEARNING_CANDIDATE_RPC = "propose_canonical_learning_candidate" as const;

/** The only status P2-18 can produce. Every other lifecycle state belongs to P2-19. */
export type LearningCandidateStatus = "proposed";

/**
 * Structural description of the current evidence. Not a confidence threshold, not a
 * truth claim and not review eligibility.
 */
export type LearningCandidateEvidenceTier = "single_lineage" | "multiple_consistent_lineages" | "conflicting_lineages";

export const LEARNING_CANDIDATE_TIERS: Record<LearningCandidateEvidenceTier, { entry: string; evidence: string }> = {
  single_lineage: {
    entry: "The current evidence traces to one Decision.",
    evidence: "One complete canonical outcome lineage (possibly several Outcomes of that same Decision).",
  },
  multiple_consistent_lineages: {
    entry: "Two or more current lineages trace to distinct Decisions, and all record the same observed result.",
    evidence: "Structurally independent lineages only; no statistical independence is claimed.",
  },
  conflicting_lineages: {
    entry: "Current lineages record different observed results for the same pattern.",
    evidence: "The conflict itself is evidence and is kept, never resolved by P2-18.",
  },
};

/** Every lineage P2-18 can build is observational; see CAUSALITY_NOTE. */
export type LearningCandidateCausalityClaim = "correlation_only" | (string & {});
/**
 * evidenceTier, lineageCount, independentLineageCount, resultCounts and confidence are the
 * summary STORED at the last material evaluation. They are not recomputed on read; source
 * currency (currentSourceCount, operationallySupported) is. Readers must not treat the stored
 * tier as the current state of the evidence.
 */
export const SUMMARY_BASIS_NOTE =
  "evidenceTier, lineageCount, independentLineageCount, resultCounts and confidence are a snapshot as of the last material evaluation (summaryAsOf), not recomputed on read. currentSourceCount and operationallySupported are derived now; summaryReflectsCurrentSources is false when a source counted in the snapshot is no longer current.";

export const CAUSALITY_NOTE =
  "correlation_only reflects current evidence capability: every lineage P2-18 can build is observational. It is not a universal rule for future candidates, and timing is never treated as causation.";

export type LearningCandidateLimitationCode =
  | "correlation_only"
  | "structural_independence_only"
  | "confidence_is_weakest_observation"
  | "not_ratified"
  | "lineages_share_a_decision"
  | "conflicting_observed_results";

export const LIMITATION_STATEMENTS: Record<LearningCandidateLimitationCode, string> = {
  correlation_only:
    "These outcomes followed this intervention pattern. That is an observed correlation; it does not establish that the intervention caused them.",
  structural_independence_only:
    "Lineages count as independent only because they trace to different Decisions; no statistical independence is claimed.",
  confidence_is_weakest_observation:
    "Confidence is the weakest recorded Observation confidence among the current sources, not a probability that the pattern holds.",
  not_ratified:
    "A proposed candidate is not organizational knowledge. Review and ratification are outside P2-18.",
  lineages_share_a_decision: "Some current sources trace to the same Decision and are not independent of each other.",
  conflicting_observed_results: "Current sources record different observed results for this pattern.",
};

export type ObservedResult = "achieved" | "partial" | "failed";

/** Named reasons a lineage cannot become candidate evidence. */
export type LearningCandidateIneligibilityReason =
  | "lineage_incomplete"
  | "lineage_disputed"
  | "lineage_inconclusive"
  | "lineage_degraded"
  | "lineage_fixture"
  | "observation_missing"
  | "observation_not_latest"
  | "observation_result_not_qualifying"
  | "observation_missing_data"
  | "observation_stale"
  | "observation_evidence_not_current"
  | "outcome_superseded"
  | "outcome_state_mismatch"
  | "task_missing"
  | "task_not_completed"
  | "execution_missing"
  | "execution_not_completed"
  | "action_missing"
  | "lineage_action_mismatch"
  | "lineage_task_action_mismatch"
  | "action_governance_revoked"
  | "governance_evaluation_missing"
  | "governance_not_authorized"
  | "decision_missing"
  | "decision_not_accepted"
  | "decision_superseded"
  | "recommendation_missing"
  | "finding_missing"
  | "finding_evidence_missing"
  | "finding_evidence_not_canonical"
  | "finding_evidence_degraded";

/** Table shapes live in the database contract; these are the same types. */
export type LearningCandidateRow = CanonicalLearningCandidateRow;
export type LearningCandidateSourceRow = CanonicalLearningCandidateSourceRow;

/** Why a source is (or is no longer) current at the read clock. Derived, never stored. */
export type LearningCandidateSourceValidity =
  | "current"
  | "superseded"
  | "observation_not_latest"
  | "past_valid_until"
  | "evidence_not_current";

export type LearningCandidateSourceView = {
  id: string;
  outcomeId: string;
  observationId: string;
  observedResult: ObservedResult;
  observationConfidence: number;
  validUntil: string | null;
  validity: LearningCandidateSourceValidity;
  correlationId: string;
  causationId: string | null;
  evaluatedAt: string;
  recordedAt: string;
  supersededAt: string | null;
  references: {
    taskId: string;
    internalExecutionId: string;
    actionId: string;
    governanceEvaluationId: string;
    decisionId: string;
    recommendationId: string;
    findingId: string;
    findingEvidenceItemId: string;
    observationEvidenceIds: string[];
  };
};

export type LearningCandidateView = {
  contract: typeof LEARNING_CANDIDATE_CONTRACT;
  id: string;
  workspaceId: string;
  projectId: string;
  status: LearningCandidateStatus;
  patternKey: string;
  pattern: { signalType: string; recommendedActionType: string; actionClass: string };
  evidenceTier: LearningCandidateEvidenceTier;
  lineageCount: number;
  independentLineageCount: number;
  resultCounts: Partial<Record<ObservedResult, number>>;
  confidence: { value: number; method: string; scale: "unit_interval"; note: string };
  /** Never stripped: persisted, emitted and returned verbatim. */
  causalityClaim: LearningCandidateCausalityClaim;
  causalityNote: string;
  limitations: Array<{ code: string; statement: string }>;
  version: number;
  evidenceDigest: string;
  evaluator: string;
  fixture: boolean;
  fixtureLabel: string | null;
  /** The tier/counts/confidence above are a snapshot as of this time, not recomputed on read. */
  summaryBasis: "as_of_last_evaluation";
  summaryAsOf: string;
  summaryNote: string;
  /** False when a source counted in the stored snapshot is no longer current at the read clock. */
  summaryReflectsCurrentSources: boolean;
  /** Derived at the read clock from source validity. The stored status stays "proposed". */
  operationallySupported: boolean;
  currentSourceCount: number;
  sources: LearningCandidateSourceView[];
  elevationInferred: false;
  candidateIsNotOrganizationalTruth: true;
  createdAt: string;
  updatedAt: string;
  lastEvaluatedAt: string;
};

export type LearningCandidateDisposition = "created" | "evidence_linked" | "evidence_superseded" | "duplicate" | "ineligible";

export type ProposeLearningCandidateResult =
  | {
      disposition: "created" | "evidence_linked" | "evidence_superseded" | "duplicate";
      candidateId: string;
      sourceId: string;
      supersededSourceId: string | null;
      eventId: string | null;
      evidenceTier: LearningCandidateEvidenceTier;
      version: number;
      causalityClaim: LearningCandidateCausalityClaim;
      elevationInferred: false;
    }
  | { disposition: "ineligible"; reasons: string[]; gaps: string[]; elevationInferred: false };
