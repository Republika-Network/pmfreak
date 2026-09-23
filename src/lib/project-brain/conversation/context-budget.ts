// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — context budget (PB-CHAT-01)
//
// Every bound on what one conversational turn may send to the model lives here,
// so the budget is one reviewable table rather than magic numbers spread across
// the builder, the prompt and the route. Pinned by
// tests/pb-chat-01-project-brain-conversation.test.ts.
//
// Sized against the default model's 128k-token window with a wide margin: the
// whole project context is capped at ~24k characters (≈6k tokens), history at
// 24 messages × 1.2k characters, the question at 4k characters, and the output at
// the bounded contract below (maxTokens is derived from it).
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainSourceFamily } from "./context-types";

/** Longest user message the turn API accepts. */
export const MAX_USER_MESSAGE_CHARS = 4000;

/** Recent conversation window: ~12 turns (user + assistant = 2 messages per turn). */
export const MAX_HISTORY_MESSAGES = 24;
export const MAX_HISTORY_MESSAGE_CHARS = 1200;

/** Each source's content is cut to this many characters (never mid-structure: it is plain text). */
export const MAX_SOURCE_CONTENT_CHARS = 400;
/** Hard ceiling on citable sources in one turn. */
export const MAX_CONTEXT_SOURCES = 48;
/** Hard ceiling on serialized project context. Lowest-priority sources are dropped first. */
export const MAX_CONTEXT_CHARS = 24_000;

/**
 * Per-family caps AND priority order. Earlier families survive the total budget
 * first: the project's own record, open governed risk/issues and decisions are
 * worth more to a status question than a discovery suggestion.
 */
export const SOURCE_FAMILY_BUDGET: ReadonlyArray<{ family: ProjectBrainSourceFamily; max: number }> = [
  { family: "PROJECT", max: 1 },
  { family: "RISK", max: 6 },
  { family: "ISSUE", max: 6 },
  { family: "DECISION", max: 6 },
  { family: "RECOMMENDATION", max: 6 },
  { family: "TASK", max: 8 },
  { family: "ACTION", max: 4 },
  { family: "MILESTONE", max: 6 },
  { family: "EVIDENCE", max: 8 },
  { family: "SIGNAL", max: 6 },
  { family: "OUTCOME", max: 4 },
  { family: "ONBOARDING", max: 8 },
  { family: "RAID_DISCOVERY", max: 6 },
];

/** Supplemental direct reads (all project-scoped, all bounded). */
export const SUPPLEMENTAL_READ_LIMIT = 15;

/**
 * The OUTPUT contract: the largest legal model answer. The model is told these
 * limits in the system prompt, and output.ts clips to them, so every value here
 * bounds what one turn can emit — and therefore what `maxTokens` must fit.
 *
 * Kept deliberately small: a Project Brain turn is a concise answer plus a few
 * material claims, not a report.
 */
export const PROJECT_BRAIN_OUTPUT_LIMITS = {
  replyChars: 2000,
  statements: 6,
  statementChars: 280,
  sourceIdsPerStatement: 4,
  inferenceBasisChars: 280,
  reportedByChars: 80,
  contradictingClaims: 2,
  contradictingClaimChars: 160,
} as const;

/**
 * How `maxTokens` is derived (pinned by tests/pb-chat-01-project-brain-conversation.test.ts):
 *
 *   worst-case legal output  = JSON of a reply and statements with EVERY field at its
 *                              limit above (measured by worstCaseProjectBrainOutput()
 *                              in output.ts: ≈ 9.1k characters)
 *   tokens                  ≤ characters / OUTPUT_CHARS_PER_TOKEN_FLOOR
 *                              (3: a conservative floor for Latin-script prose and
 *                              JSON punctuation/keys; typical English is ≈ 4)
 *   maxTokens               ≥ that × OUTPUT_TOKEN_SAFETY_MARGIN, rounded up.
 *
 * So a maximal legal answer fits with margin, while a runaway answer is still cut
 * off (it then fails strict parsing and the turn degrades honestly; the truncation
 * is logged as `project_brain.output_truncated`). Scripts that tokenize at close to
 * one character per token (e.g. CJK) can still exceed the ceiling at the extreme.
 */
export const OUTPUT_CHARS_PER_TOKEN_FLOOR = 3;
export const OUTPUT_TOKEN_SAFETY_MARGIN = 1.2;

/** Inference parameters for a conversational turn. */
export const PROJECT_BRAIN_INFERENCE = {
  temperature: 0.2,
  maxTokens: 3700,
  timeoutMs: 20_000,
  maxAttempts: 2,
  retryDelayMs: 500,
} as const;

/**
 * How long a persisted-but-unanswered user turn is presumed to still be in flight
 * on another request. Longer than the worst-case inference call
 * (timeoutMs × maxAttempts + retry delay) plus context loading, so a duplicate
 * request inside it answers "pending" instead of running the model a second time.
 */
export const TURN_PENDING_WINDOW_MS = 60_000;
