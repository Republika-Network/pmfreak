/**
 * P2-19 — shared HTTP mapping for the knowledge routes. Refusals carry a stable snake_case
 * failureClass and product wording; provider/internal exception text is never returned.
 */
import { NextResponse } from "next/server";
import { logger, safeErrorMessage } from "@/lib/observability/logger";

export function knowledgeJson(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status });
}

function denied(status: 401 | 403) {
  return knowledgeJson({ ok: false, error: status === 401 ? "Unauthenticated." : "Access denied." }, status);
}

export function knowledgeErrorResponse(error: unknown, routeId: string) {
  const message = error instanceof Error ? error.message : String(error);
  // Handled refusals name their stable snake_case code, never a raw provider message.
  const failureClass = message.match(/\b(?:project_knowledge|learning_candidate)_[a-z_]+/g)?.at(-1) ?? null;
  if (/\bunauthenticated\b/.test(message)) return denied(401);
  if (/project_knowledge_(authority|scope)_denied|project_knowledge_governance_projection_mismatch/.test(message)) {
    return knowledgeJson({ ok: false, error: "Only a workspace owner or admin can make this decision.", failureClass }, 403);
  }
  if (/project_knowledge_(candidate_)?not_found/.test(message)) {
    return knowledgeJson({ ok: false, error: "That record was not found in this project.", failureClass }, 404);
  }
  if (/project_knowledge_rationale_required/.test(message)) {
    return knowledgeJson({ ok: false, error: "A reason is required.", failureClass }, 400);
  }
  if (/project_knowledge_validity_invalid/.test(message)) {
    return knowledgeJson({ ok: false, error: "Choose how long this knowledge stays valid: until revoked, or until a future date.", failureClass }, 400);
  }
  if (/project_knowledge_payload_invalid|learning_candidate_payload_invalid|project_knowledge_fixture_not_ratifiable/.test(message)) {
    return knowledgeJson({ ok: false, error: "The request is not valid for this project.", failureClass }, 400);
  }
  if (/read_truncated/.test(message)) {
    return knowledgeJson({ ok: false, error: "Too many records to read completely; nothing partial is returned.", failureClass }, 503);
  }
  logger.error("route_internal_error", { route: routeId, error_detail: safeErrorMessage(error) });
  return knowledgeJson({ ok: false, error: "The decision could not be recorded. Please retry." }, 500);
}

export function governanceRefusal(outcome: { kind: "deny" | "approval_required" | "unavailable"; decisionId: string | null }) {
  if (outcome.kind === "unavailable") {
    return knowledgeJson({ ok: false, disposition: "governance_unavailable", error: "Governance is unavailable, so nothing was recorded. Please retry.", decisionId: outcome.decisionId }, 503);
  }
  if (outcome.kind === "approval_required") {
    return knowledgeJson({ ok: false, disposition: "governance_approval_required", error: "This decision needs a separate approval, so nothing was recorded.", decisionId: outcome.decisionId }, 403);
  }
  return knowledgeJson({ ok: false, disposition: "governance_denied", error: "Only a workspace owner or admin can make this decision.", decisionId: outcome.decisionId }, 403);
}
