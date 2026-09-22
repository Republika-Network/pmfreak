/**
 * P2-19 — Governed Project knowledge contract.
 *
 *   P2-18 Learning Candidate  →  terminal review (ratified | rejected)  →  Project knowledge
 *                                                                        →  revocation
 *
 * A Learning Candidate is never mutated into knowledge; its status stays "proposed". A
 * review is terminal for one exact Candidate state (candidateId, version, evidenceDigest).
 * Knowledge is Project-scoped only (applicability "source_project"), carries the reviewed
 * Candidate's causality qualifier and limitations verbatim, and can only be revoked, once.
 *
 * Persistence: supabase/migrations/20260915000000_p2_19_governed_project_knowledge.sql
 * (canonical_learning_candidate_reviews + canonical_project_knowledge_records, written only by
 * the ratify/reject/revoke commands; read through retrieve_project_knowledge).
 */
import type { CanonicalLearningCandidateReviewRow, CanonicalProjectKnowledgeRecordRow } from "@/lib/db/database-contract";
import { LIMITATION_STATEMENTS, type LearningCandidateLimitationCode } from "@/lib/learning-candidates/types";

export const PROJECT_KNOWLEDGE_CONTRACT = "pmfreak/project-knowledge:v1" as const;
/** The PMFreak in-process governance contract the commands record (as P2-06 does). */
export const KNOWLEDGE_GOVERNANCE_CONTRACT = "pmfreak.aoc-e.in-process-governance.v1" as const;

export const KNOWLEDGE_GOVERNANCE_ACTIONS = {
  ratify: "knowledge.ratify",
  reject: "knowledge.reject",
  revoke: "knowledge.revoke",
} as const;
export type KnowledgeGovernanceAction = (typeof KNOWLEDGE_GOVERNANCE_ACTIONS)[keyof typeof KNOWLEDGE_GOVERNANCE_ACTIONS];

export const PROJECT_KNOWLEDGE_RPC = {
  ratify: "ratify_canonical_learning_candidate",
  reject: "reject_canonical_learning_candidate",
  revoke: "revoke_canonical_project_knowledge",
  retrieve: "retrieve_project_knowledge",
} as const;

/** The explicit validity choice a ratifier must make. There is no default duration. */
export type KnowledgeValidityMode = "until_revoked" | "until_date";

export type ReviewOutcome = "ratified" | "rejected";
export type KnowledgeStatus = "active" | "revoked";
/** Derived at the read clock: an active record past its effective_until is "expired". */
export type KnowledgeEffectiveState = "active" | "expired" | "revoked";

/** The ALLOW decision reference from the in-process governance runtime. */
export type KnowledgeGovernanceReference = {
  action: KnowledgeGovernanceAction;
  decision: "allow";
  decisionId: string;
  evaluatedAt: string;
  contract: typeof KNOWLEDGE_GOVERNANCE_CONTRACT;
};

export type KnowledgeLimitationCode =
  | LearningCandidateLimitationCode
  | "applies_to_source_project_only"
  | "ratification_is_not_causal_evidence";

export const KNOWLEDGE_LIMITATION_STATEMENTS: Record<KnowledgeLimitationCode, string> = {
  ...LIMITATION_STATEMENTS,
  applies_to_source_project_only:
    "This knowledge applies only to the project whose outcomes support it. It has not been elevated to the workspace or beyond.",
  ratification_is_not_causal_evidence:
    "Ratification is a governed human judgment that the pattern is worth keeping for this project. It does not turn an observed correlation into proof of cause.",
};

export type ReviewDisposition =
  | "ratified"
  | "rejected"
  | "duplicate"
  | "already_finalized"
  | "stale_review"
  | "not_supported"
  | "already_ratified";

export type RevokeDisposition = "revoked" | "already_revoked";

export type ProjectKnowledgeReviewRow = CanonicalLearningCandidateReviewRow;
export type ProjectKnowledgeRecordRow = CanonicalProjectKnowledgeRecordRow;

export type ProjectKnowledgeReviewView = {
  id: string;
  candidateId: string;
  candidateVersion: number;
  candidateEvidenceDigest: string;
  outcome: ReviewOutcome;
  reviewedBy: string;
  reviewerRole: string;
  reviewedAt: string;
  candidateCreatedBy: string;
  /** Kept visible: P2-19 has no four-eyes rule and never calls such a review independent. */
  reviewerIsCandidateCreator: boolean;
  rationale: string;
  causalityClaim: string;
  governance: { action: string; decisionId: string; evaluatedAt: string; contract: string };
};

export type ProjectKnowledgeView = {
  contract: typeof PROJECT_KNOWLEDGE_CONTRACT;
  id: string;
  workspaceId: string;
  projectId: string;
  candidateId: string;
  candidateVersion: number;
  candidateEvidenceDigest: string;
  reviewId: string;
  patternKey: string;
  pattern: { signalType: string; recommendedActionType: string; actionClass: string };
  statement: string;
  evidenceTier: string;
  lineageCount: number;
  independentLineageCount: number;
  resultCounts: Record<string, number>;
  confidence: { value: number; method: string; note: string };
  causalityClaim: string;
  limitations: Array<{ code: string; statement: string }>;
  sourceIds: string[];
  applicabilityScope: "source_project";
  status: KnowledgeStatus;
  effectiveState: KnowledgeEffectiveState;
  validityMode: KnowledgeValidityMode;
  effectiveFrom: string;
  effectiveUntil: string | null;
  ratifiedAt: string;
  ratifiedBy: string;
  ratificationGovernanceDecisionId: string;
  version: number;
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
  fixture: boolean;
  elevationInferred: false;
};

export type ReviewCommandResult =
  | { disposition: "ratified" | "duplicate"; review: ProjectKnowledgeReviewView; knowledge: ProjectKnowledgeView | null; eventId: string | null }
  | { disposition: "rejected"; review: ProjectKnowledgeReviewView; knowledge: null; eventId: string }
  | { disposition: "already_finalized"; review: ProjectKnowledgeReviewView; knowledge: null; eventId: null }
  | { disposition: "stale_review"; currentVersion: number; currentEvidenceDigest: string }
  | { disposition: "not_supported"; reason: "no_current_sources" | "summary_not_current"; currentSourceCount: number }
  | { disposition: "already_ratified" };

export type RevokeCommandResult = { disposition: RevokeDisposition; knowledge: ProjectKnowledgeView; eventId: string | null };
