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
// 24 messages × 1.2k characters, the question at 4k characters, and the reply at
// 900 output tokens.
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

/** Inference parameters for a conversational turn. */
export const PROJECT_BRAIN_INFERENCE = {
  temperature: 0.2,
  maxTokens: 900,
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
