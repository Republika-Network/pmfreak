// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — selected-Recommendation target (PB-EXEC-01 review P1-2, final reviews)
//
// The selected prior Recommendation IDENTIFIES the work; it is earlier AI output, never a
// source or evidence. The SERVER owns the target identity: the model cannot say what work
// was selected — it only prepares that work.
//
//   1. assistantTurnId + statementId select ONE validated persisted RECOMMENDATION (target.ts);
//   2. it cited at least one source or report anchor;
//   3. every anchor is still in the CURRENT bounded context (the same authenticated user
//      turn, same createdAt, for a report);
//   4. every source anchor's persisted-reference SNAPSHOT digest (sha256 of the canonical
//      evidenceId, sourceSystem, title, evidenceType, recordedAt, excerpt, authorityLevel,
//      isPrimary, workspaceId, projectId) equals that of the current reference;
//   5. every precise reference in the Recommendation text is still supplied;
//   6. the canonical target TEXT is server-owned: statement = the exact Recommendation text,
//      title = that text when it fits, else a fixed neutral label (target.ts);
//   7. the canonical target SUPPORT is the Recommendation's current, unchanged anchors;
//   8. model output cannot replace 6 or 7. Its target is only compared for exact equality;
//      a mismatch is a blocking inconsistency, and the mismatching prose is never persisted;
//   9. server-owned identity is not a safety exemption: the exact text passed grounding's
//      renderer screen (credential, unsupported reference, dangerous command — ground.ts).
//      A failure withholds the WHOLE canonical target (target = null) with a blocking
//      unknown that never echoes the detail; targetRef still names the selected work.
//
// Rules 2–5 failing → blocking "Reconfirm the selected recommendation"; an inexact model
// target → blocking "Project Brain could not prepare instructions consistently…". Either
// way the brief is needs_input, targetRef never changes, and the canonical target shown is
// still the selected Recommendation — unless rule 9 withheld it. Continuity (is the work
// still supported?) and safety (may this text reach an executor?) are separate checks; one
// Recommendation may fail both. No lexical or semantic similarity is used anywhere.
//
// Honest limit: rule 4 proves the persisted REFERENCE is unchanged, not the semantic
// entailment of source content beyond its excerpt. SERVER ONLY (hashing).
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainContext, ProjectBrainContextReport, ProjectBrainContextSource } from "../conversation/context-types";
import { unsupportedReferenceChecker, type GroundedBrief } from "./ground";
import { sha256Tag } from "./hash";
import { canonicalSelectedTarget, referenceSnapshot, type RecommendationAnchors, type ReferenceSnapshot, type SelectedRecommendationTarget } from "./target";

export const RECONFIRM_RECOMMENDATION_UNKNOWN = {
  fact: "Reconfirm the selected recommendation",
  why: "The selected recommendation is no longer sufficiently supported by the current project context.",
  resolveBy: "user" as const,
  blocking: true,
};

export const TARGET_INCONSISTENT_UNKNOWN = {
  fact: "Project Brain could not prepare instructions consistently for the selected recommendation.",
  why: "The draft did not keep the selected recommendation as its target, so the selected recommendation is shown instead. Request the brief again before handing it off.",
  resolveBy: "user" as const,
  blocking: true,
};

export const SELECTED_TARGET_WITHHELD_UNKNOWN = {
  fact: "Reconfirm the target without the unsupported execution detail",
  why: "The selected recommendation contains execution detail that is not established safely enough for an execution brief, so its text was left out. Restate the work without that detail and request a new brief.",
  resolveBy: "user" as const,
  blocking: true,
};

export type RecommendationContinuityFailure = "no_original_support" | "support_missing" | "support_changed" | "unsupported_reference";
export type RecommendationContinuity = { ok: true } | { ok: false; reason: RecommendationContinuityFailure };

/** Rule 4: the digest of a persisted-reference snapshot. */
export function snapshotDigest(snapshot: ReferenceSnapshot): string {
  return sha256Tag(snapshot);
}

/** The anchors that are still present AND unchanged in the current context (rule 7's support). */
function survivingAnchors(context: ProjectBrainContext, anchors: RecommendationAnchors): { sources: ProjectBrainContextSource[]; reports: ProjectBrainContextReport[] } {
  const sources: ProjectBrainContextSource[] = [];
  for (const a of anchors.sources) {
    const current = context.sources.find((s) => s.reference.evidenceId === a.evidenceId);
    if (current && snapshotDigest(a.snapshot) === snapshotDigest(referenceSnapshot(current.reference))) sources.push(current);
  }
  const reports: ProjectBrainContextReport[] = [];
  for (const a of anchors.reports) {
    const current = (context.reports ?? []).find((r) => r.reference.turnId === a.turnId && r.reference.createdAt === a.createdAt);
    if (current) reports.push(current);
  }
  return { sources, reports };
}

/** Rules 2–5. */
export function checkRecommendationContinuity(input: {
  context: ProjectBrainContext;
  anchors: RecommendationAnchors;
  recommendationText: string;
  question: string;
  generatedAt: string;
}): RecommendationContinuity {
  const { anchors, context } = input;
  if (anchors.sources.length + anchors.reports.length === 0) return { ok: false, reason: "no_original_support" };
  const currentSources = new Map(context.sources.map((s) => [s.reference.evidenceId, s]));
  for (const a of anchors.sources) if (!currentSources.has(a.evidenceId)) return { ok: false, reason: "support_missing" };
  for (const a of anchors.reports) {
    const report = (context.reports ?? []).find((r) => r.reference.turnId === a.turnId);
    if (!report || report.reference.createdAt !== a.createdAt) return { ok: false, reason: "support_missing" };
  }
  for (const a of anchors.sources) {
    if (snapshotDigest(a.snapshot) !== snapshotDigest(referenceSnapshot(currentSources.get(a.evidenceId)!.reference))) return { ok: false, reason: "support_changed" };
  }
  if (unsupportedReferenceChecker(context, input.question, input.generatedAt)(input.recommendationText) !== null) return { ok: false, reason: "unsupported_reference" };
  return { ok: true };
}

/**
 * Rules 6–9: the canonical target is the server-owned selected Recommendation, supported by
 * its current, unchanged anchors (added to provenance as the CURRENT records/reports they
 * are — never the Recommendation itself), or null when grounding withheld its text (rule 9).
 * Blocking unknowns on any failure.
 */
export function applySelectedTarget(
  grounded: GroundedBrief,
  input: { selected: SelectedRecommendationTarget; context: ProjectBrainContext; continuity: RecommendationContinuity },
): GroundedBrief {
  const unknowns = [...grounded.unknowns];
  const add = (u: typeof RECONFIRM_RECOMMENDATION_UNKNOWN) => {
    if (!unknowns.some((x) => x.fact === u.fact)) unknowns.unshift(u);
  };
  if (!input.continuity.ok) add(RECONFIRM_RECOMMENDATION_UNKNOWN);
  if (grounded.selectedTargetWithheld) {
    // Rule 9: nothing of the text survives — no title, no statement, no support claimed for it.
    add(SELECTED_TARGET_WITHHELD_UNKNOWN);
    return { ...grounded, target: null, targetRemoved: true, unknowns };
  }
  if (grounded.modelTargetMatches === false) add(TARGET_INCONSISTENT_UNKNOWN);
  const { title, statement } = canonicalSelectedTarget(input.selected.recommendationText);
  const support = survivingAnchors(input.context, input.selected.anchors);
  const sources = [...grounded.sources];
  for (const s of support.sources) if (!sources.includes(s)) sources.push(s);
  const reports = [...grounded.reports];
  for (const r of support.reports) if (!reports.includes(r)) reports.push(r);
  return {
    ...grounded,
    target: {
      title,
      statement,
      sourceIds: support.sources.map((s) => s.reference.evidenceId),
      reportedTurnIds: support.reports.map((r) => r.reference.turnId),
    },
    targetRemoved: false,
    sources,
    reports,
    unknowns,
  };
}
