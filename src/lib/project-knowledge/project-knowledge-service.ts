/**
 * P2-19 — governed Project knowledge service.
 *
 * Every read and write runs on the CALLER'S request-scoped (RLS) client; no service role is
 * used. Each command is one authenticated RPC that, under the Candidate (or Knowledge) row
 * lock, re-checks scope, owner/admin authority, the exact reviewed version/digest and — for
 * ratification — current evidence support, then writes its rows and platform event in one
 * transaction. The caller must pass the in-process governance ALLOW reference for the exact
 * action; this module never evaluates or fabricates one.
 *
 * Retrieval is separate from review: retrieveProjectKnowledge returns only active,
 * in-scope, unexpired, non-fixture knowledge (retrieve_project_knowledge); the history read
 * (reviews and every knowledge record, revoked included) exists for review and audit views
 * and is never an authoritative knowledge source.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { LOOKUP_ROW_LIMIT } from "@/lib/learning-candidates/learning-candidate-service";
import { toProjectKnowledgeReviewView, toProjectKnowledgeView } from "./views";
import {
  PROJECT_KNOWLEDGE_RPC,
  type KnowledgeGovernanceReference,
  type KnowledgeValidityMode,
  type ProjectKnowledgeRecordRow,
  type ProjectKnowledgeReviewRow,
  type ProjectKnowledgeReviewView,
  type ProjectKnowledgeView,
  type ReviewCommandResult,
  type RevokeCommandResult,
} from "./types";

type Client = SupabaseClient;

export type ProjectKnowledgeScope = { workspaceId: string; projectId: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
/** Matches the database bound on rationale / revocation reason. Not a minimum length. */
export const KNOWLEDGE_RATIONALE_MAX_LENGTH = 8000;

const KNOWLEDGE_COLUMNS = "id,workspace_id,project_id,candidate_id,candidate_version,candidate_evidence_digest,review_id,review_outcome,knowledge_kind,pattern_key,pattern_signature,statement,evidence_tier,lineage_count,independent_lineage_count,result_counts,confidence_score,confidence_method,causality_claim,limitations,source_ids,applicability_scope,status,validity_mode,effective_from,effective_until,ratified_at,ratified_by,ratification_governance_decision_id,version,revoked_at,revoked_by,revocation_reason,revocation_governance_decision_id,revocation_governance_evaluated_at,fixture_label,created_at,updated_at";
const REVIEW_COLUMNS = "id,workspace_id,project_id,candidate_id,candidate_version,candidate_evidence_digest,review_outcome,reviewed_by,reviewer_role,reviewed_at,candidate_created_by,candidate_last_evaluated_by,reviewer_is_candidate_creator,reviewed_summary,causality_claim,limitations,rationale,governance_action,governance_decision_id,governance_decision_state,governance_contract,governance_evaluated_at,fixture_label,recorded_at";

function fail(code: string, error?: { message?: string } | null): never {
  throw new Error(error?.message ? `${code}: ${error.message}` : code);
}

export type KnowledgeReviewInput = {
  candidateId: string;
  candidateVersion: number;
  candidateEvidenceDigest: string;
  rationale: string;
};

export type KnowledgeValidityInput =
  | { validityMode: "until_revoked"; effectiveUntil: null }
  | { validityMode: "until_date"; effectiveUntil: string };

/** Structural validation only; the database re-validates, and owns the clock. */
export function validateReviewInput(input: KnowledgeReviewInput): void {
  if (!UUID_PATTERN.test(input.candidateId)) fail("project_knowledge_payload_invalid");
  if (!Number.isInteger(input.candidateVersion) || input.candidateVersion < 1) fail("project_knowledge_payload_invalid");
  if (!DIGEST_PATTERN.test(input.candidateEvidenceDigest)) fail("project_knowledge_payload_invalid");
  validateRationale(input.rationale);
}

export function validateRationale(rationale: string): void {
  const trimmed = typeof rationale === "string" ? rationale.trim() : "";
  if (trimmed.length === 0 || trimmed.length > KNOWLEDGE_RATIONALE_MAX_LENGTH) fail("project_knowledge_rationale_required");
}

export function parseValidity(mode: unknown, effectiveUntil: unknown): KnowledgeValidityInput {
  if (mode === "until_revoked") {
    if (effectiveUntil !== null && effectiveUntil !== undefined && effectiveUntil !== "") fail("project_knowledge_validity_invalid");
    return { validityMode: "until_revoked", effectiveUntil: null };
  }
  if (mode === "until_date") {
    if (typeof effectiveUntil !== "string" || Number.isNaN(Date.parse(effectiveUntil))) fail("project_knowledge_validity_invalid");
    return { validityMode: "until_date", effectiveUntil: new Date(effectiveUntil).toISOString() };
  }
  return fail("project_knowledge_validity_invalid");
}

function asReview(value: unknown): ProjectKnowledgeReviewView {
  const row = value as Partial<ProjectKnowledgeReviewRow> | null;
  if (!row?.id || !row.review_outcome) fail("project_knowledge_result_malformed");
  return toProjectKnowledgeReviewView(row as ProjectKnowledgeReviewRow);
}

function asKnowledge(value: unknown, evaluatedAtMs: number): ProjectKnowledgeView {
  const row = value as Partial<ProjectKnowledgeRecordRow> | null;
  if (!row?.id || !row.status) fail("project_knowledge_result_malformed");
  return toProjectKnowledgeView(row as ProjectKnowledgeRecordRow, evaluatedAtMs);
}

function mapReviewResult(data: unknown, evaluatedAtMs: number): ReviewCommandResult {
  const result = (data ?? null) as Record<string, unknown> | null;
  switch (result?.disposition) {
    case "ratified": {
      // Never report success without the persisted review, knowledge AND event.
      if (!result.eventId || !result.knowledge) fail("project_knowledge_result_malformed");
      return { disposition: "ratified", review: asReview(result.review), knowledge: asKnowledge(result.knowledge, evaluatedAtMs), eventId: String(result.eventId) };
    }
    case "rejected":
      if (!result.eventId) fail("project_knowledge_result_malformed");
      return { disposition: "rejected", review: asReview(result.review), knowledge: null, eventId: String(result.eventId) };
    case "duplicate":
      return { disposition: "duplicate", review: asReview(result.review), knowledge: result.knowledge ? asKnowledge(result.knowledge, evaluatedAtMs) : null, eventId: null };
    case "already_finalized":
      return { disposition: "already_finalized", review: asReview(result.review), knowledge: null, eventId: null };
    case "stale_review":
      return { disposition: "stale_review", currentVersion: Number(result.currentVersion), currentEvidenceDigest: String(result.currentEvidenceDigest) };
    case "not_supported":
      return {
        disposition: "not_supported",
        reason: result.reason === "no_current_sources" ? "no_current_sources" : "summary_not_current",
        currentSourceCount: Number(result.currentSourceCount ?? 0),
      };
    case "already_ratified":
      return { disposition: "already_ratified" };
    default:
      return fail("project_knowledge_result_malformed");
  }
}

function assertGovernance(reference: KnowledgeGovernanceReference, action: KnowledgeGovernanceReference["action"]): void {
  if (reference?.decision !== "allow" || reference.action !== action || !reference.decisionId) fail("project_knowledge_governance_required");
}

export async function ratifyLearningCandidate(
  client: Client,
  scope: ProjectKnowledgeScope,
  input: KnowledgeReviewInput & KnowledgeValidityInput,
  governance: KnowledgeGovernanceReference,
  options: { evaluatedAt: string },
): Promise<ReviewCommandResult> {
  validateReviewInput(input);
  assertGovernance(governance, "knowledge.ratify");
  const { data, error } = await client.rpc(PROJECT_KNOWLEDGE_RPC.ratify, {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_candidate_id: input.candidateId,
    p_candidate_version: input.candidateVersion,
    p_candidate_evidence_digest: input.candidateEvidenceDigest,
    p_rationale: input.rationale.trim(),
    p_validity_mode: input.validityMode satisfies KnowledgeValidityMode,
    p_effective_until: input.effectiveUntil,
    p_governance: governance,
  });
  if (error) fail("project_knowledge_rpc_failed", error);
  return mapReviewResult(data, new Date(options.evaluatedAt).getTime());
}

export async function rejectLearningCandidate(
  client: Client,
  scope: ProjectKnowledgeScope,
  input: KnowledgeReviewInput,
  governance: KnowledgeGovernanceReference,
  options: { evaluatedAt: string },
): Promise<ReviewCommandResult> {
  validateReviewInput(input);
  assertGovernance(governance, "knowledge.reject");
  const { data, error } = await client.rpc(PROJECT_KNOWLEDGE_RPC.reject, {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_candidate_id: input.candidateId,
    p_candidate_version: input.candidateVersion,
    p_candidate_evidence_digest: input.candidateEvidenceDigest,
    p_rationale: input.rationale.trim(),
    p_governance: governance,
  });
  if (error) fail("project_knowledge_rpc_failed", error);
  return mapReviewResult(data, new Date(options.evaluatedAt).getTime());
}

export async function revokeProjectKnowledge(
  client: Client,
  scope: ProjectKnowledgeScope,
  input: { knowledgeId: string; reason: string },
  governance: KnowledgeGovernanceReference,
  options: { evaluatedAt: string },
): Promise<RevokeCommandResult> {
  if (!UUID_PATTERN.test(input.knowledgeId)) fail("project_knowledge_payload_invalid");
  validateRationale(input.reason);
  assertGovernance(governance, "knowledge.revoke");
  const { data, error } = await client.rpc(PROJECT_KNOWLEDGE_RPC.revoke, {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_knowledge_id: input.knowledgeId,
    p_reason: input.reason.trim(),
    p_governance: governance,
  });
  if (error) fail("project_knowledge_rpc_failed", error);
  const result = (data ?? null) as Record<string, unknown> | null;
  const evaluatedAtMs = new Date(options.evaluatedAt).getTime();
  if (result?.disposition === "revoked") {
    if (!result.eventId) fail("project_knowledge_result_malformed");
    return { disposition: "revoked", knowledge: asKnowledge(result.knowledge, evaluatedAtMs), eventId: String(result.eventId) };
  }
  if (result?.disposition === "already_revoked") {
    return { disposition: "already_revoked", knowledge: asKnowledge(result.knowledge, evaluatedAtMs), eventId: null };
  }
  return fail("project_knowledge_result_malformed");
}

/**
 * Authoritative Project knowledge: active, source_project, non-fixture and unexpired at the
 * DATABASE clock. A response at the row cap may be incomplete, so it fails closed.
 */
export async function retrieveProjectKnowledge(
  client: Client,
  scope: ProjectKnowledgeScope,
  options: { evaluatedAt: string },
): Promise<ProjectKnowledgeView[]> {
  const { data, error } = await client
    .rpc(PROJECT_KNOWLEDGE_RPC.retrieve, { p_workspace_id: scope.workspaceId, p_project_id: scope.projectId })
    .limit(LOOKUP_ROW_LIMIT);
  if (error) fail("project_knowledge_read_failed", error);
  const rows = (data ?? []) as ProjectKnowledgeRecordRow[];
  if (rows.length >= LOOKUP_ROW_LIMIT) fail("project_knowledge_read_truncated");
  const evaluatedAtMs = new Date(options.evaluatedAt).getTime();
  // Defence in depth: the view never shows anything the retrieval contract excludes.
  return rows
    .filter((r) => r.workspace_id === scope.workspaceId && r.project_id === scope.projectId && r.status === "active" && r.fixture_label === null && r.applicability_scope === "source_project")
    .map((r) => toProjectKnowledgeView(r, evaluatedAtMs));
}

export type ProjectKnowledgeHistory = {
  evaluatedAt: string;
  records: ProjectKnowledgeView[];
  reviews: ProjectKnowledgeReviewView[];
};

/** Review/audit history for the Project: every review and every knowledge record. */
export async function listProjectKnowledgeHistory(
  client: Client,
  scope: ProjectKnowledgeScope,
  options: { evaluatedAt: string },
): Promise<ProjectKnowledgeHistory> {
  const evaluatedAt = new Date(options.evaluatedAt);
  if (Number.isNaN(evaluatedAt.valueOf())) fail("project_knowledge_payload_invalid");
  const [records, reviews] = await Promise.all([
    client.from("canonical_project_knowledge_records").select(KNOWLEDGE_COLUMNS)
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
      .order("ratified_at", { ascending: false }).order("id", { ascending: true })
      .limit(LOOKUP_ROW_LIMIT),
    client.from("canonical_learning_candidate_reviews").select(REVIEW_COLUMNS)
      .eq("workspace_id", scope.workspaceId).eq("project_id", scope.projectId)
      .order("reviewed_at", { ascending: false }).order("id", { ascending: true })
      .limit(LOOKUP_ROW_LIMIT),
  ]);
  if (records.error) fail("project_knowledge_read_failed", records.error);
  if (reviews.error) fail("project_knowledge_read_failed", reviews.error);
  const recordRows = (records.data ?? []) as ProjectKnowledgeRecordRow[];
  const reviewRows = (reviews.data ?? []) as ProjectKnowledgeReviewRow[];
  if (recordRows.length >= LOOKUP_ROW_LIMIT || reviewRows.length >= LOOKUP_ROW_LIMIT) fail("project_knowledge_read_truncated");
  const evaluatedAtMs = evaluatedAt.getTime();
  return {
    evaluatedAt: evaluatedAt.toISOString(),
    records: recordRows.map((r) => toProjectKnowledgeView(r, evaluatedAtMs)),
    reviews: reviewRows.map(toProjectKnowledgeReviewView),
  };
}
