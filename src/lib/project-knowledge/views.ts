/**
 * P2-19 — pure read mappers and governance-decision classification.
 *
 * Same inputs → same output: no wall clock, no randomness, no I/O.
 */
import type { CanonicalRuntimeDecision } from "@/lib/aoc/contracts/decision";
import {
  KNOWLEDGE_GOVERNANCE_CONTRACT,
  KNOWLEDGE_LIMITATION_STATEMENTS,
  PROJECT_KNOWLEDGE_CONTRACT,
  type KnowledgeEffectiveState,
  type KnowledgeGovernanceAction,
  type KnowledgeGovernanceReference,
  type KnowledgeLimitationCode,
  type ProjectKnowledgeRecordRow,
  type ProjectKnowledgeReviewRow,
  type ProjectKnowledgeReviewView,
  type ProjectKnowledgeView,
} from "./types";

function limitationView(code: string): { code: string; statement: string } {
  const known = KNOWLEDGE_LIMITATION_STATEMENTS[code as KnowledgeLimitationCode];
  return { code, statement: known ?? `Unrecognized limitation code "${code}" (kept verbatim; not dropped).` };
}

/** Revocation is persisted; expiry is derived at the read clock from effective_until. */
export function deriveKnowledgeEffectiveState(row: Pick<ProjectKnowledgeRecordRow, "status" | "effective_until">, evaluatedAtMs: number): KnowledgeEffectiveState {
  if (row.status === "revoked") return "revoked";
  if (row.effective_until && new Date(row.effective_until).getTime() <= evaluatedAtMs) return "expired";
  return "active";
}

export function toProjectKnowledgeView(row: ProjectKnowledgeRecordRow, evaluatedAtMs: number): ProjectKnowledgeView {
  return {
    contract: PROJECT_KNOWLEDGE_CONTRACT,
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    candidateId: row.candidate_id,
    candidateVersion: row.candidate_version,
    candidateEvidenceDigest: row.candidate_evidence_digest,
    reviewId: row.review_id,
    patternKey: row.pattern_key,
    pattern: { ...row.pattern_signature },
    statement: row.statement,
    evidenceTier: row.evidence_tier,
    lineageCount: row.lineage_count,
    independentLineageCount: row.independent_lineage_count,
    resultCounts: Object.fromEntries(Object.entries(row.result_counts ?? {}).map(([k, v]) => [k, Number(v)])),
    confidence: {
      value: Number(row.confidence_score),
      method: row.confidence_method,
      note: KNOWLEDGE_LIMITATION_STATEMENTS.confidence_is_weakest_observation,
    },
    causalityClaim: row.causality_claim,
    limitations: row.limitations.map(limitationView),
    sourceIds: [...row.source_ids],
    applicabilityScope: "source_project",
    status: row.status,
    effectiveState: deriveKnowledgeEffectiveState(row, evaluatedAtMs),
    validityMode: row.validity_mode,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    ratifiedAt: row.ratified_at,
    ratifiedBy: row.ratified_by,
    ratificationGovernanceDecisionId: row.ratification_governance_decision_id,
    version: row.version,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revocationReason: row.revocation_reason,
    fixture: row.fixture_label !== null,
    elevationInferred: false,
  };
}

export function toProjectKnowledgeReviewView(row: ProjectKnowledgeReviewRow): ProjectKnowledgeReviewView {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    candidateVersion: row.candidate_version,
    candidateEvidenceDigest: row.candidate_evidence_digest,
    outcome: row.review_outcome,
    reviewedBy: row.reviewed_by,
    reviewerRole: row.reviewer_role,
    reviewedAt: row.reviewed_at,
    candidateCreatedBy: row.candidate_created_by,
    reviewerIsCandidateCreator: row.reviewer_is_candidate_creator,
    rationale: row.rationale,
    causalityClaim: row.causality_claim,
    governance: {
      action: row.governance_action,
      decisionId: row.governance_decision_id,
      evaluatedAt: row.governance_evaluated_at,
      contract: row.governance_contract,
    },
  };
}

export type KnowledgeGovernanceOutcome =
  | { kind: "allow"; reference: KnowledgeGovernanceReference }
  | { kind: "deny"; decisionId: string | null }
  | { kind: "approval_required"; decisionId: string | null; decision: string }
  | { kind: "unavailable"; decisionId: string | null };

/**
 * Only an explicit ALLOW with a decision id and evaluation time authorises a knowledge
 * transition. Approval-routed decisions are NOT success, and a runtime failure is
 * "unavailable" — both fail closed. `decision` is the canonical runtime decision, or its
 * fail-closed wrapper, which carries only some of its fields.
 */
export function classifyKnowledgeGovernanceDecision(
  action: KnowledgeGovernanceAction,
  decision: (Pick<CanonicalRuntimeDecision, "allowed"> & Partial<Pick<CanonicalRuntimeDecision, "decisionId" | "reason" | "evaluatedAt">> & { decision?: string | null }) | null | undefined): KnowledgeGovernanceOutcome {
  const decisionId = typeof decision?.decisionId === "string" && decision.decisionId.trim() ? decision.decisionId.trim() : null;
  if (!decision || decision.reason === "runtime_dependency_unavailable" || decisionId?.startsWith("runtime_consumer_fail_closed")) {
    return { kind: "unavailable", decisionId };
  }
  const state = typeof decision.decision === "string" ? decision.decision : null;
  if (state && state.includes("approval")) return { kind: "approval_required", decisionId, decision: state };
  const evaluatedAt = typeof decision.evaluatedAt === "string" && !Number.isNaN(Date.parse(decision.evaluatedAt)) ? decision.evaluatedAt : null;
  if (decision.allowed === true && state === "allow" && decisionId && evaluatedAt) {
    return {
      kind: "allow",
      reference: { action, decision: "allow", decisionId: decisionId.slice(0, 200), evaluatedAt, contract: KNOWLEDGE_GOVERNANCE_CONTRACT },
    };
  }
  if (decision.allowed === true) return { kind: "unavailable", decisionId };
  return { kind: "deny", decisionId };
}
