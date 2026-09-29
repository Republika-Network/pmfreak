// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — the dedicated operation (PB-EXEC-01, §13 option D). SERVER ONLY.
//
// Runs INSTEAD of the ordinary answer inference for a turn whose operation is
// `execution_brief`: exactly one provider call (operation
// `project_brain.execution_brief`), zero extra calls anywhere else.
//
//   entitlement?  no → degraded, no provider call
//   prompt        buildExecutionBriefMessages (same context, same aliases)
//   infer         ONE call; strict JSON schema; idempotency key from the user turn
//   parse         strict; malformed → degraded (no partial brief)
//   ground        stable ids, whole-item removal, credential boundary 1
//   assemble      server fields, hashes, readiness, credential boundary 2
//
// Logs carry identifiers, stages, counts and guard CATEGORIES only — never model
// content, prompts, source text or a matched credential.
// ─────────────────────────────────────────────────────────────────────────────

import type { InferenceRequest, InferenceResponse } from "@/lib/ai/inference/types";
import type { ProjectBrainContext } from "../conversation/context-types";
import type { ProjectContextScope } from "../types";
import { assembleExecutionBrief, ExecutionBriefAssemblyError } from "./assemble";
import { applySelectedTarget, checkRecommendationContinuity } from "./continuity";
import { groundExecutionBrief, reportTextsOf } from "./ground";
import { canonicalSelectedTarget, type RecommendationAnchors, type SelectedRecommendationTarget } from "./target";
import { buildExecutionBriefMessages, recommendationAnchorAliases } from "./prompt";
import { extractReportedRepositoryContext } from "./repository-context";
import { EXECUTION_BRIEF_INFERENCE, executionBriefModelSchema, parseExecutionBriefModelOutput } from "./schema";
import { EXECUTION_BRIEF_OPERATION, type ExecutionBriefV1, type ResolvedExecutionBriefTargetRef } from "./types";

export type ExecutionBriefGenerationInput = {
  scope: ProjectContextScope;
  userId: string;
  moduleId: string;
  conversationId: string;
  userMessage: { id: string; content: string; created_at: string };
  /** The turn context WITH its report map. */
  context: ProjectBrainContext;
  targetRef: ResolvedExecutionBriefTargetRef;
  recommendationText: string | null;
  /** Stable support anchors of the selected prior Recommendation (null for current_user_request). */
  recommendationAnchors: RecommendationAnchors | null;
  generatedAt: string;
  /** True for an explicit retry of a degraded brief turn. */
  retry: boolean;
  infer(request: InferenceRequest): Promise<InferenceResponse>;
  newBriefId(): string;
};

export type ExecutionBriefGenerationResult =
  | { ok: true; brief: ExecutionBriefV1; provider: string; model: string }
  | { ok: false; stage: "schema" | "assembly"; failure?: string };

/** Deterministic, server-written reply sentence. No instructions live here — they live in the brief. */
export function executionBriefReplyContent(brief: Pick<ExecutionBriefV1, "readiness" | "targetRef">): string {
  if (brief.readiness === "needs_input") return "I prepared a draft execution brief, but it needs additional input before handoff.";
  return brief.targetRef.kind === "current_user_request"
    ? "I prepared an execution brief for the work you described."
    : "I prepared an execution brief for this recommendation.";
}

export async function generateExecutionBrief(input: ExecutionBriefGenerationInput): Promise<ExecutionBriefGenerationResult> {
  const { scope, context, userMessage } = input;
  // Final review: a prior-Recommendation target is SERVER-OWNED identity.
  const selected: SelectedRecommendationTarget | null =
    input.targetRef.kind === "project_brain_recommendation"
      ? {
          assistantTurnId: input.targetRef.assistantTurnId,
          statementId: input.targetRef.statementId,
          recommendationText: input.recommendationText ?? "",
          anchors: input.recommendationAnchors ?? { sources: [], reports: [] },
        }
      : null;
  const selectedText = selected ? canonicalSelectedTarget(selected.recommendationText) : null;
  const response = await input.infer({
    moduleId: input.moduleId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    actorId: input.userId,
    actorType: "user",
    dataSensitivity: "confidential",
    chainDepth: 0,
    messages: buildExecutionBriefMessages({ context, question: userMessage.content, targetRef: input.targetRef, recommendationText: input.recommendationText, recommendationAnchors: input.recommendationAnchors, selectedTarget: selectedText, asOf: input.generatedAt }),
    // A prior-Recommendation target may cite only that Recommendation's surviving anchors.
    responseFormat: {
      type: "json_schema",
      jsonSchema: executionBriefModelSchema(selectedText ? { ...recommendationAnchorAliases(context, input.recommendationAnchors), ...selectedText } : undefined),
    },
    temperature: EXECUTION_BRIEF_INFERENCE.temperature,
    maxTokens: EXECUTION_BRIEF_INFERENCE.maxTokens,
    timeoutMs: EXECUTION_BRIEF_INFERENCE.timeoutMs,
    maxAttempts: EXECUTION_BRIEF_INFERENCE.maxAttempts,
    retryDelayMs: EXECUTION_BRIEF_INFERENCE.retryDelayMs,
    operationName: EXECUTION_BRIEF_OPERATION,
    idempotencyKey: `project-brain:${userMessage.id}:brief:${input.retry ? "retry" : "first"}`,
  });
  if (response.finishReason === "length") {
    console.warn(JSON.stringify({ event: "project_brain.execution_brief.output_truncated", projectId: scope.projectId, maxTokens: EXECUTION_BRIEF_INFERENCE.maxTokens }));
  }

  const parsed = parseExecutionBriefModelOutput({ parsedJson: response.parsedJson, content: response.content });
  if (!parsed) return { ok: false, stage: "schema" };

  try {
    let grounded = groundExecutionBrief({ output: parsed, context, question: userMessage.content, generatedAt: input.generatedAt, targetRef: input.targetRef, selectedTarget: selectedText ?? undefined });
    if (selected) {
      // Continuity of the selected work's CURRENT support (continuity.ts rules 2–5), then the
      // server-owned canonical target (rules 6–8). Never a retarget; the model's target prose
      // is never persisted.
      const continuity = checkRecommendationContinuity({
        context,
        anchors: selected.anchors,
        recommendationText: selected.recommendationText,
        question: userMessage.content,
        generatedAt: input.generatedAt,
      });
      if (!continuity.ok) console.warn(JSON.stringify({ event: "project_brain.execution_brief.target_unconfirmed", projectId: scope.projectId, reason: continuity.reason }));
      if (grounded.modelTargetMatches === false) console.warn(JSON.stringify({ event: "project_brain.execution_brief.target_inconsistent", projectId: scope.projectId }));
      grounded = applySelectedTarget(grounded, { selected, context, continuity });
    }
    const reportTexts = reportTextsOf(context, userMessage.content).map((r) => ({ turnId: r.report.reference.turnId, text: r.text }));
    const repositoryContext = extractReportedRepositoryContext(reportTexts);
    const reportCreatedAt = new Map((context.reports ?? []).map((r) => [r.reference.turnId, r.reference.createdAt] as const));
    const brief = assembleExecutionBrief({
      grounded,
      briefId: input.newBriefId(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      conversationId: input.conversationId,
      requestTurnId: userMessage.id,
      generatedAt: input.generatedAt,
      provider: response.provider,
      model: response.model,
      targetRef: input.targetRef,
      repositoryContext,
      reportCreatedAt,
    });
    return { ok: true, brief, provider: response.provider, model: response.model };
  } catch (error) {
    // Fail closed: a guard error, a credential in a server-owned field or an invalid
    // assembled brief degrades the whole turn. Only the reason and field:category.
    const failure = error instanceof ExecutionBriefAssemblyError ? error.reason : "assembly_error";
    console.warn(JSON.stringify({
      event: "project_brain.execution_brief.refused",
      projectId: scope.projectId,
      failure,
      detail: error instanceof ExecutionBriefAssemblyError ? error.detail.slice(0, 20) : [],
    }));
    return { ok: false, stage: "assembly", failure };
  }
}
