import { NextRequest, NextResponse } from "next/server";
import { listLearningCandidates } from "@/lib/learning-candidates/learning-candidate-service";
import {
  parseValidity,
  ratifyLearningCandidate,
  rejectLearningCandidate,
  validateReviewInput,
  type KnowledgeValidityInput,
} from "@/lib/project-knowledge/project-knowledge-service";
import { authorizeKnowledgeScope, evaluateKnowledgeGovernance } from "@/lib/project-knowledge/route-authorization";
import { KNOWLEDGE_GOVERNANCE_ACTIONS, type ReviewCommandResult } from "@/lib/project-knowledge/types";
import { governanceRefusal, knowledgeErrorResponse, knowledgeJson as json } from "@/lib/project-knowledge/route-responses";

/**
 * P2-19 — terminal review of one exact Learning Candidate state.
 *
 *   POST { workspaceId, projectId, candidateId, candidateVersion, candidateEvidenceDigest,
 *          decision: "ratify" | "reject", rationale,
 *          validityMode?: "until_revoked" | "until_date", effectiveUntil? }   (validity: ratify only)
 *
 * Sequence (nothing is written before governance allows it):
 *   authenticate → resolve the Candidate canonically in the claimed Workspace/Project →
 *   exact version/digest check → (ratify) current-support check → evaluate knowledge.ratify /
 *   knowledge.reject in the in-process governance runtime → on ALLOW only, one RPC that
 *   re-checks all of it under the Candidate lock and writes review (+ knowledge) + event.
 */
const ROUTE_ID = "/api/learning-candidates/review";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LearningReviewRouteDeps = {
  authorize: typeof authorizeKnowledgeScope;
  resolveCandidate: typeof listLearningCandidates;
  evaluateGovernance: typeof evaluateKnowledgeGovernance;
  ratify: typeof ratifyLearningCandidate;
  reject: typeof rejectLearningCandidate;
  now: () => Date;
};

const defaultDeps: LearningReviewRouteDeps = {
  authorize: authorizeKnowledgeScope,
  resolveCandidate: listLearningCandidates,
  evaluateGovernance: evaluateKnowledgeGovernance,
  ratify: ratifyLearningCandidate,
  reject: rejectLearningCandidate,
  now: () => new Date(),
};

function reviewResponse(result: ReviewCommandResult) {
  switch (result.disposition) {
    case "ratified":
    case "rejected":
      return json({ ok: true, ...result }, 201);
    case "duplicate":
      return json({ ok: true, ...result }, 200);
    case "stale_review":
      return json({ ok: false, ...result, error: "The candidate changed since you opened it. Review the current version." }, 409);
    case "not_supported":
      return json({ ok: false, ...result, error: "The candidate's evidence is no longer current, so it cannot be ratified." }, 409);
    case "already_finalized":
      return json({ ok: false, ...result, error: "A different decision was already recorded for this candidate version." }, 409);
    case "already_ratified":
      return json({ ok: false, ...result, error: "This candidate already has active project knowledge. Revoke it before ratifying a newer version." }, 409);
  }
}

export async function handlePostLearningReview(request: NextRequest, depsOverride: Partial<LearningReviewRouteDeps> = {}): Promise<NextResponse> {
  const deps: LearningReviewRouteDeps = { ...defaultDeps, ...depsOverride };
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON." }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json({ ok: false, error: "Invalid JSON." }, 400);
  const body = parsed as Record<string, unknown>;
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const decision = body.decision;
  if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(projectId) || (decision !== "ratify" && decision !== "reject")) {
    return json({ ok: false, error: "workspaceId, projectId and decision (ratify | reject) are required." }, 400);
  }
  const review = {
    candidateId: typeof body.candidateId === "string" ? body.candidateId.trim() : "",
    candidateVersion: typeof body.candidateVersion === "number" ? body.candidateVersion : Number.NaN,
    candidateEvidenceDigest: typeof body.candidateEvidenceDigest === "string" ? body.candidateEvidenceDigest.trim() : "",
    rationale: typeof body.rationale === "string" ? body.rationale : "",
  };
  let validity: KnowledgeValidityInput | null = null;
  try {
    validateReviewInput(review);
    if (decision === "ratify") validity = parseValidity(body.validityMode, body.effectiveUntil);
    // An explicit future date is required; the database re-checks against its own clock.
    if (validity?.validityMode === "until_date" && new Date(validity.effectiveUntil).getTime() <= deps.now().getTime()) {
      throw new Error("project_knowledge_validity_invalid");
    }
  } catch (error) {
    return knowledgeErrorResponse(error, ROUTE_ID);
  }

  const auth = await deps.authorize(projectId, workspaceId);
  if (!auth.ok) return json({ ok: false, error: auth.status === 401 ? "Unauthenticated." : "Access denied." }, auth.status);
  const scope = { workspaceId, projectId };
  const evaluatedAt = deps.now().toISOString();

  try {
    // Resolve the Candidate canonically in the claimed scope (RLS client), then the
    // reviewer's freshness and — for ratification — current support, before governance.
    const resolved = await deps.resolveCandidate(auth.client, scope, { evaluatedAt, candidateId: review.candidateId });
    const candidate = resolved.candidates.find((c) => c.id === review.candidateId);
    if (!candidate) return json({ ok: false, error: "That candidate was not found in this project.", failureClass: "project_knowledge_candidate_not_found" }, 404);
    const action = decision === "ratify" ? KNOWLEDGE_GOVERNANCE_ACTIONS.ratify : KNOWLEDGE_GOVERNANCE_ACTIONS.reject;
    const reviewedStateIsCurrent = candidate.version === review.candidateVersion && candidate.evidenceDigest === review.candidateEvidenceDigest;
    // A version/digest mismatch is not refused here: the database decides, under the Candidate
    // lock, whether it is a retry of an already-committed review (replayed, never flipped) or
    // a stale review (nothing written).
    if (reviewedStateIsCurrent && decision === "ratify" && !(candidate.operationallySupported && candidate.summaryReflectsCurrentSources)) {
      return reviewResponse({
        disposition: "not_supported",
        reason: candidate.currentSourceCount === 0 ? "no_current_sources" : "summary_not_current",
        currentSourceCount: candidate.currentSourceCount,
      });
    }

    const outcome = await deps.evaluateGovernance({
      user: auth.user, action, routeId: ROUTE_ID, workspaceId, projectId,
      resourceType: "canonical_learning_candidate", resourceId: candidate.id,
    });
    if (outcome.kind !== "allow") return governanceRefusal(outcome);

    const result = decision === "ratify"
      ? await deps.ratify(auth.client, scope, { ...review, ...(validity as KnowledgeValidityInput) }, outcome.reference, { evaluatedAt })
      : await deps.reject(auth.client, scope, review, outcome.reference, { evaluatedAt });
    return reviewResponse(result);
  } catch (error) {
    return knowledgeErrorResponse(error, ROUTE_ID);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handlePostLearningReview(request);
}
