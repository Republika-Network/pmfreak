// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — selected-Recommendation continuity (PB-EXEC-01 review P1-2, final review)
//
// The selected prior Recommendation IDENTIFIES the work; it is earlier AI output, never a
// source or evidence. The brief must stay about THAT work: the model must not be able to
// prepare different work under the same targetRef — neither by citing other records, nor by
// citing the original anchor incidentally beside unrelated support, nor after the record it
// rested on changed.
//
// Deterministic — no model call, no embedding, no semantic matching. A prior-Recommendation
// brief is continuity-valid only if ALL of:
//   1. the Recommendation had at least one source or report anchor;
//   2. every anchor is still in the CURRENT bounded context (sources in this turn's
//      <project_context>; the same authenticated user turn, same createdAt, in the report map);
//   3. every source anchor's persisted-reference SNAPSHOT (sha256 of the canonical
//      evidenceId, sourceSystem, title, evidenceType, recordedAt, excerpt, authorityLevel,
//      isPrimary, workspaceId, projectId) equals the snapshot of the current reference;
//   4. the grounded target has support;
//   5. EVERY id supporting the target is one of those surviving anchors (a target lock:
//      other fields may cite any current record; the target may not);
//   6. the target introduces no new work-item identity: every identifier in its title and
//      statement (typed references plus letter+digit work-item ids such as P14 / INV-42) is
//      one the Recommendation named; if the Recommendation names identifiers the target names
//      at least one of them; and the target repeats the Recommendation's substantive words
//      (at least min(2, n) of its n content words) — so a citation alone never proves identity;
//   7. every precise reference in the Recommendation text is still supplied by the request.
// Otherwise the blocking unknown "Reconfirm the selected recommendation" makes the brief
// needs_input; targetRef never changes; nothing is stripped or rewritten.
//
// Honest limit: rule 3 proves the persisted REFERENCE is unchanged (its title, excerpt,
// recordedAt, …), not the semantic entailment of source content beyond that excerpt. Families
// whose recordedAt follows updated_at make any edit a reconfirmation — the safe side. A
// conservative false negative (reconfirming still-valid work) is preferred to preparing the
// wrong work. SERVER ONLY (hashing).
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainContext } from "../conversation/context-types";
import { extractExecutionReferences, STANDARD_CODE_FAMILIES, unsupportedReferenceChecker, type GroundedBrief } from "./ground";
import { sha256Tag } from "./hash";
import { referenceSnapshot, type RecommendationAnchors, type ReferenceSnapshot } from "./target";

export const RECONFIRM_RECOMMENDATION_UNKNOWN = {
  fact: "Reconfirm the selected recommendation",
  why: "The selected recommendation is no longer sufficiently supported by the current project context.",
  resolveBy: "user" as const,
  blocking: true,
};

export type RecommendationContinuityFailure =
  | "no_original_support"
  | "support_missing"
  | "support_changed"
  | "target_unsupported"
  | "target_not_locked"
  | "target_identity_changed"
  | "unsupported_reference";

export type RecommendationContinuity = { ok: true } | { ok: false; reason: RecommendationContinuityFailure };

/** Rule 3: the digest of a persisted-reference snapshot. */
export function snapshotDigest(snapshot: ReferenceSnapshot): string {
  return sha256Tag(snapshot);
}

// ── Rule 6: deterministic target identity ──

const WORK_ITEM_ID = /\b[a-z]{1,10}-?\d{1,5}\b/gi;
/** Verbs and filler that name no particular work; never counted as the Recommendation's content. */
const NON_CONTENT = new Set([
  "implement", "implementing", "implementation", "build", "building", "create", "creating", "start", "starting", "finish", "finishing",
  "complete", "completing", "deliver", "delivering", "develop", "developing", "make", "work", "working", "next", "then", "first", "prepare",
  "continue", "focus", "should", "would", "could", "this", "that", "with", "from", "into", "onto", "before", "after", "their", "there",
  "which", "what", "when", "where", "while", "because", "since", "about", "above", "below", "have", "will", "been", "being", "they",
  "your", "ours", "also", "only", "still", "just", "more", "most", "some", "such", "than", "once", "each", "other", "these", "those",
  "project", "recommend", "recommended", "recommendation", "priority", "task", "item", "milestone", "planned", "current", "currently",
]);

function identities(text: string): Set<string> {
  const out = new Set<string>();
  const typed = new Set(["code", "pr", "branch", "path", "sha", "url", "command"]);
  for (const ref of extractExecutionReferences(text)) if (typed.has(ref.kind)) out.add(ref.token);
  for (const m of text.matchAll(WORK_ITEM_ID)) {
    const token = m[0].toLowerCase();
    if (/^\d/.test(token)) continue;
    if (STANDARD_CODE_FAMILIES.has(token.replace(/-?\d+$/, ""))) continue;
    out.add(token);
  }
  return out;
}

/** Minimal plural folding only ("invoices" → "invoice", "entries" → "entry"); no other stemming. */
const stem = (word: string) => {
  const w = word.toLowerCase();
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  return w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
};
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && /\p{L}/u.test(w) && !/\d/.test(w) && !NON_CONTENT.has(w.toLowerCase()))
      .map(stem),
  );
}

/** Rule 6. Exported for tests. */
export function targetKeepsRecommendationIdentity(recommendationText: string, target: { title: string; statement: string }): boolean {
  const targetText = `${target.title}\n${target.statement}`;
  const recIds = identities(recommendationText);
  const targetIds = identities(targetText);
  for (const id of targetIds) if (!recIds.has(id)) return false; // no new identity
  if (recIds.size > 0 && ![...targetIds].some((id) => recIds.has(id))) return false; // names the selected item
  const recWords = contentWords(recommendationText);
  const targetWords = contentWords(targetText);
  if (recIds.size === 0 && recWords.size === 0) return false; // nothing to prove identity against
  const shared = [...recWords].filter((w) => targetWords.has(w)).length;
  return shared >= Math.min(2, recWords.size);
}

export function checkRecommendationContinuity(input: {
  grounded: Pick<GroundedBrief, "target">;
  context: ProjectBrainContext;
  anchors: RecommendationAnchors;
  recommendationText: string;
  question: string;
  generatedAt: string;
}): RecommendationContinuity {
  const { anchors, context } = input;
  // 1
  if (anchors.sources.length + anchors.reports.length === 0) return { ok: false, reason: "no_original_support" };
  // 2
  const currentSources = new Map(context.sources.map((s) => [s.reference.evidenceId, s]));
  const currentReports = new Map((context.reports ?? []).map((r) => [r.reference.turnId, r]));
  for (const a of anchors.sources) if (!currentSources.has(a.evidenceId)) return { ok: false, reason: "support_missing" };
  for (const a of anchors.reports) {
    const report = currentReports.get(a.turnId);
    if (!report || report.reference.createdAt !== a.createdAt) return { ok: false, reason: "support_missing" };
  }
  // 3
  for (const a of anchors.sources) {
    const current = currentSources.get(a.evidenceId)!;
    if (snapshotDigest(a.snapshot) !== snapshotDigest(referenceSnapshot(current.reference))) return { ok: false, reason: "support_changed" };
  }
  // 4
  const target = input.grounded.target;
  const support = target ? [...target.sourceIds, ...target.reportedTurnIds] : [];
  if (!target || support.length === 0) return { ok: false, reason: "target_unsupported" };
  // 5
  const surviving = new Set([...anchors.sources.map((a) => a.evidenceId), ...anchors.reports.map((a) => a.turnId)]);
  if (!support.every((id) => surviving.has(id))) return { ok: false, reason: "target_not_locked" };
  // 6
  if (!targetKeepsRecommendationIdentity(input.recommendationText, target)) return { ok: false, reason: "target_identity_changed" };
  // 7
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
