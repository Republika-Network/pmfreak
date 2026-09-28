// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — selected-Recommendation continuity (PB-EXEC-01 review P1-2)
//
// The selected prior Recommendation IDENTIFIES the work; it is earlier AI output, never a
// source or evidence. But the brief must stay about THAT work: if the current project
// context no longer supports it, the model must not be able to quietly prepare different,
// currently-supported work under the same targetRef.
//
// Deterministic v1 rule — no model call, no embedding, no semantic matching. Continuity
// holds only if ALL of:
//   1. the persisted Recommendation cited at least one stable anchor (a source evidenceId
//      or a user-report turn id) — with none there is nothing to prove continuity against;
//   2. EVERY original anchor is still present in the CURRENT context (the source is in this
//      turn's bounded <project_context>; the report is in this turn's report map);
//   3. the grounded target cites at least one of those surviving anchors — a target supported
//      only by unrelated current records is not the selected work;
//   4. every precise execution/project reference in the Recommendation text is supported by
//      what THIS request supplied (records, today's date, the question, user turns).
// Otherwise the brief gets the blocking unknown "Reconfirm the selected recommendation" and
// therefore cannot be handoff-ready. targetRef is never changed. A conservative false
// negative (asking to reconfirm still-valid work) is preferred to preparing the wrong work.
// Pure.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainContext } from "../conversation/context-types";
import { unsupportedReferenceChecker, type GroundedBrief } from "./ground";
import type { RecommendationAnchors } from "./target";

export const RECONFIRM_RECOMMENDATION_UNKNOWN = {
  fact: "Reconfirm the selected recommendation",
  why: "The selected recommendation is no longer sufficiently supported by the current project context.",
  resolveBy: "user" as const,
  blocking: true,
};

export type RecommendationContinuity =
  | { ok: true }
  | { ok: false; reason: "no_original_support" | "support_missing" | "target_not_anchored" | "unsupported_reference" };

export function checkRecommendationContinuity(input: {
  grounded: Pick<GroundedBrief, "target">;
  context: ProjectBrainContext;
  anchors: RecommendationAnchors;
  recommendationText: string;
  question: string;
  generatedAt: string;
}): RecommendationContinuity {
  const { anchors, context } = input;
  if (anchors.sourceIds.length + anchors.reportedTurnIds.length === 0) return { ok: false, reason: "no_original_support" };
  const currentSources = new Set(context.sources.map((s) => s.reference.evidenceId));
  const currentReports = new Set((context.reports ?? []).map((r) => r.reference.turnId));
  if (!anchors.sourceIds.every((id) => currentSources.has(id)) || !anchors.reportedTurnIds.every((id) => currentReports.has(id))) {
    return { ok: false, reason: "support_missing" };
  }
  const target = input.grounded.target;
  const anchored = new Set([...anchors.sourceIds, ...anchors.reportedTurnIds]);
  if (!target || ![...target.sourceIds, ...target.reportedTurnIds].some((id) => anchored.has(id))) {
    return { ok: false, reason: "target_not_anchored" };
  }
  if (unsupportedReferenceChecker(context, input.question, input.generatedAt)(input.recommendationText) !== null) {
    return { ok: false, reason: "unsupported_reference" };
  }
  return { ok: true };
}

/** A failed check adds the blocking reconfirm unknown (once). Nothing else changes. */
export function withRecommendationContinuity(grounded: GroundedBrief, result: RecommendationContinuity): GroundedBrief {
  if (result.ok || grounded.unknowns.some((u) => u.fact === RECONFIRM_RECOMMENDATION_UNKNOWN.fact)) return grounded;
  return { ...grounded, unknowns: [RECONFIRM_RECOMMENDATION_UNKNOWN, ...grounded.unknowns] };
}
