// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — target selection (PB-EXEC-01, §9.2, §9.2.1, §13)
//
// "Prepare it for Claude" is never resolved by a model. The target is either
//   * an explicit `targetRef` (the control on ONE specific RECOMMENDATION),
//     validated from persisted rows before anything is written or inferred;
//   * the current turn, when it actually describes work (`current_user_request`);
//   * or — only when the request has no usable target — the RECOMMENDATION
//     statements of the most recent generative ANSWER: exactly one resolves
//     deterministically, zero or several end in a target-selection result with
//     nothing persisted and no provider call.
//
// Everything here is pure and deterministic. The phrase matcher and the
// work-description check are also used by the browser to decide what to SEND —
// the server re-validates every request itself.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextMessageRow } from "@/lib/db/database-contract";
import type { ProjectContextScope } from "../types";
import {
  ANSWER_REQUEST_IDENTITY,
  type ExecutionBriefRenderer,
  type ExecutionBriefTargetCandidate,
  type ExecutionBriefTargetRef,
  type ProjectBrainRequestIdentity,
  type ResolvedExecutionBriefTargetRef,
} from "./types";

type AnyRecord = Record<string, unknown>;
const record = (value: unknown): AnyRecord | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : null);
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;

// ─── Wire shapes (route) ─────────────────────────────────────────────────────

/** Closed shape. Anything else — extra keys, other kinds, non-string ids — is invalid. */
export function parseTargetRef(value: unknown): ExecutionBriefTargetRef | "invalid" {
  const r = record(value);
  if (!r) return "invalid";
  const keys = Object.keys(r).sort().join(",");
  if (r.kind === "current_user_request" && keys === "kind") return { kind: "current_user_request" };
  if (
    r.kind === "project_brain_recommendation" &&
    keys === "assistantTurnId,kind,statementId" &&
    typeof r.assistantTurnId === "string" &&
    typeof r.statementId === "string" &&
    ID.test(r.assistantTurnId) &&
    ID.test(r.statementId)
  ) {
    return { kind: "project_brain_recommendation", assistantTurnId: r.assistantTurnId, statementId: r.statementId };
  }
  return "invalid";
}

/** The operation identity persisted on a user row (`metadata.projectBrainRequest`). */
export function requestIdentityMetadata(identity: ProjectBrainRequestIdentity): { projectBrainRequest: ProjectBrainRequestIdentity } {
  return { projectBrainRequest: { operation: identity.operation, targetRef: identity.targetRef ? { ...identity.targetRef } : null } };
}

/**
 * The identity a stored user row carries. A row without the field (every row
 * written before PB-EXEC-01) is `{ answer, null }`. A present but malformed field
 * is "unknown" — it matches no request, so a replay conflicts instead of guessing.
 */
export function storedRequestIdentity(row: Pick<ContextMessageRow, "metadata">): ProjectBrainRequestIdentity | "unknown" {
  const meta = record(row.metadata);
  if (!meta || !("projectBrainRequest" in meta)) return ANSWER_REQUEST_IDENTITY;
  const req = record(meta.projectBrainRequest);
  if (!req || Object.keys(req).sort().join(",") !== "operation,targetRef") return "unknown";
  if (req.operation === "answer") return req.targetRef === null ? ANSWER_REQUEST_IDENTITY : "unknown";
  if (req.operation !== "execution_brief") return "unknown";
  if (req.targetRef === null) return { operation: "execution_brief", targetRef: null };
  const targetRef = parseTargetRef(req.targetRef);
  return targetRef === "invalid" ? "unknown" : { operation: "execution_brief", targetRef };
}

// ─── Closed phrase matcher (§13) ─────────────────────────────────────────────

/**
 * Only benign normalization: case, surrounding/inner whitespace, simple terminal
 * punctuation. No stemming, no fuzzy matching, no "contains Claude".
 */
export function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?…]+$/u, "").trim();
}

const CLAUDE: ExecutionBriefRenderer = "claude_code";
const CODEX: ExecutionBriefRenderer = "codex";

/**
 * The closed set of DEICTIC brief requests (they name no work). Each maps to the
 * renderer the UI may preselect — a local preference only, never sent, stored or
 * hashed. Pinned by tests; extending it is a reviewed change.
 */
export const EXECUTION_BRIEF_PHRASES: ReadonlyMap<string, ExecutionBriefRenderer | null> = new Map<string, ExecutionBriefRenderer | null>([
  ...["prepare it", "prepare this", "prepare that", "prepare the brief", "give me the brief", "prepare a brief",
    "give me the execution brief", "give me an execution brief", "prepare the execution brief", "prepare an execution brief",
    "make the execution brief", "make an execution brief", "create the execution brief", "create an execution brief",
    "generate the execution brief", "generate an execution brief", "write the execution brief", "execution brief",
    "prepare it for execution", "prepare this for execution",
    "prepara el brief", "prepara el brief de ejecución", "dame el brief de ejecución", "prepáralo"].map((p) => [p, null] as const),
  ...["prepare it for claude", "prepare this for claude", "prepare that for claude", "prepare it for claude code", "prepare this for claude code",
    "make the claude prompt", "make a claude prompt", "give me the claude prompt", "write the claude prompt",
    "make the claude code prompt", "give me the claude code prompt", "make the claude brief", "give me the claude brief",
    "prepáralo para claude", "prepáralo para claude code"].map((p) => [p, CLAUDE] as const),
  ...["prepare it for codex", "prepare this for codex", "prepare that for codex",
    "make the codex prompt", "make a codex prompt", "give me the codex prompt", "write the codex prompt",
    "make the codex brief", "give me the codex brief", "prepáralo para codex"].map((p) => [p, CODEX] as const),
]);

/** A deictic brief request from the closed set, or null. */
export function matchExecutionBriefPhrase(text: string): { renderer: ExecutionBriefRenderer | null } | null {
  const key = normalizePhrase(text);
  return EXECUTION_BRIEF_PHRASES.has(key) ? { renderer: EXECUTION_BRIEF_PHRASES.get(key) ?? null } : null;
}

/**
 * A brief request that DESCRIBES the work ("Prepare an execution brief to add CSV
 * invoice export", "Make a Claude brief for adding SSO to the admin portal").
 * Closed grammar: verb + article + [claude|codex] [execution] brief|prompt
 * [for claude|codex] + to|for|on|about + the work.
 */
const DESCRIBED_REQUEST =
  /^(?:please )?(?:prepare|make|create|write|generate|draft|give me) (?:an? |the )(?:(claude(?: code)?|codex) )?(?:execution )?(?:brief|prompt)(?: for (claude(?: code)?|codex))? (?:to|for|on|about|that) (.+)$/;

const DEICTIC_WORDS = new Set(["it", "this", "that", "these", "those", "them", "one", "the", "a", "an", "recommendation", "recommended", "next", "previous", "above", "last", "same", "work", "task", "for", "claude", "code", "codex", "please", "execution"]);

function workWords(rest: string): string[] {
  return rest.replace(/\b(?:for|with) (?:claude(?: code)?|codex)\b/g, " ").split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length > 0 && !DEICTIC_WORDS.has(w));
}

export function matchDescribedBriefRequest(text: string): { renderer: ExecutionBriefRenderer | null; work: string } | null {
  const m = DESCRIBED_REQUEST.exec(normalizePhrase(text));
  if (!m) return null;
  const rest = m[3];
  if (workWords(rest).length < 2) return null;
  const who = m[1] ?? m[2] ?? (/\bfor (?:claude|codex)\b/.exec(rest)?.[0] ?? null);
  const renderer = who ? (who.includes("codex") ? CODEX : CLAUDE) : null;
  return { renderer, work: rest };
}

/**
 * Server check for `targetRef.kind = current_user_request`: does this turn describe
 * work, or is it only a deictic reference? A deictic-only turn is treated as having
 * no target reference (§9.2 table, row 3).
 */
export function describesWork(text: string): boolean {
  if (matchExecutionBriefPhrase(text)) return false;
  if (matchDescribedBriefRequest(text)) return true;
  const stop = new Set([...DEICTIC_WORDS, "prepare", "make", "create", "write", "generate", "draft", "give", "me", "brief", "prompt", "an", "to", "of"]);
  return normalizePhrase(text).split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length > 0 && !stop.has(w)).length >= 2;
}

/** What the composer should send for a typed message (the server re-validates). */
export function classifyComposerRequest(text: string):
  | { intent: "answer" }
  | { intent: "execution_brief"; targetRef: ExecutionBriefTargetRef | null; renderer: ExecutionBriefRenderer | null } {
  const deictic = matchExecutionBriefPhrase(text);
  if (deictic) return { intent: "execution_brief", targetRef: null, renderer: deictic.renderer };
  const described = matchDescribedBriefRequest(text);
  if (described) return { intent: "execution_brief", targetRef: { kind: "current_user_request" }, renderer: described.renderer };
  return { intent: "answer" };
}

// ─── Persisted statements ────────────────────────────────────────────────────

type PersistedStatement = {
  id: string;
  epistemicType: string;
  text: string;
  scope: { workspaceId: string; projectId: string } | null;
  /** Stable ids of the sources the statement cited when it was persisted. */
  sourceIds: string[];
  /** context_messages ids of the user reports the statement cited. */
  reportedTurnIds: string[];
};

/**
 * Deterministic support anchors of a selected prior Recommendation (review P1-2): the
 * STABLE ids it cited when it was persisted. Identification only — never a source, never
 * evidence, never an alias. Used to prove the brief is still about the selected work.
 */
export type RecommendationAnchors = { sourceIds: string[]; reportedTurnIds: string[] };

function statementsOf(row: ContextMessageRow): PersistedStatement[] | null {
  const meta = record(record(row.metadata)?.projectBrain);
  if (!meta || !Array.isArray(meta.statements)) return null;
  const out: PersistedStatement[] = [];
  for (const value of meta.statements) {
    const s = record(value);
    if (!s || typeof s.id !== "string" || typeof s.epistemicType !== "string" || typeof s.text !== "string") continue;
    const scope = record(s.scope);
    const ids = (list: unknown, key: string) =>
      Array.isArray(list) ? [...new Set(list.map((x) => record(x)?.[key]).filter((v): v is string => typeof v === "string" && v.length > 0))] : [];
    out.push({
      sourceIds: ids(s.sources, "evidenceId"),
      reportedTurnIds: ids(s.reports, "turnId"),
      id: s.id,
      epistemicType: s.epistemicType,
      text: s.text,
      scope: scope && typeof scope.workspaceId === "string" && typeof scope.projectId === "string" ? { workspaceId: scope.workspaceId, projectId: scope.projectId } : null,
    });
  }
  return out;
}

const isBriefReply = (row: ContextMessageRow) => Boolean(record(record(row.metadata)?.projectBrain)?.executionBrief) || record(record(row.metadata)?.projectBrain)?.operation === "execution_brief";

/**
 * Rules 1–5 of §9.2, from the persisted row alone. `row` is whatever the store
 * found for `assistantTurnId` in THIS conversation and workspace (null if none).
 */
export function validateRecommendationTarget(input: {
  row: ContextMessageRow | null;
  conversationId: string;
  workspaceId: string;
  scope: ProjectContextScope;
  ref: Extract<ExecutionBriefTargetRef, { kind: "project_brain_recommendation" }>;
}): { ok: true; text: string; anchors: RecommendationAnchors } | { ok: false } {
  const { row, ref, scope } = input;
  if (!row || row.id !== ref.assistantTurnId) return { ok: false }; // 1
  if (row.conversation_id !== input.conversationId || row.workspace_id !== input.workspaceId) return { ok: false }; // 2
  if (row.role !== "assistant" || row.brain_mode !== "generative") return { ok: false }; // 3 (only generative replies carry model statements)
  const statements = statementsOf(row); // 4
  const statement = statements?.find((s) => s.id === ref.statementId);
  if (!statement) return { ok: false };
  if (statement.epistemicType !== "RECOMMENDATION") return { ok: false }; // 5
  if (!statement.scope || statement.scope.workspaceId !== scope.workspaceId || statement.scope.projectId !== scope.projectId) return { ok: false };
  return { ok: true, text: statement.text, anchors: { sourceIds: statement.sourceIds, reportedTurnIds: statement.reportedTurnIds } };
}

/**
 * Candidates for an untargeted brief request: the RECOMMENDATION statements of the
 * most recent generative ANSWER strictly before `beforeSeq` (a brief reply is not an
 * answer; a degraded reply is not generative). Older answers are never searched.
 */
export function targetCandidates(input: { messages: ContextMessageRow[]; conversationId: string; workspaceId: string; scope: ProjectContextScope; beforeSeq?: number }): ExecutionBriefTargetCandidate[] {
  const latest = [...input.messages]
    .filter((m) => m.role === "assistant" && m.brain_mode === "generative" && !isBriefReply(m) && (input.beforeSeq === undefined || Number(m.message_seq) < input.beforeSeq))
    .sort((a, b) => Number(b.message_seq) - Number(a.message_seq))[0];
  if (!latest) return [];
  return (statementsOf(latest) ?? [])
    .filter((s) => s.epistemicType === "RECOMMENDATION")
    .filter((s) => validateRecommendationTarget({ row: latest, conversationId: input.conversationId, workspaceId: input.workspaceId, scope: input.scope, ref: { kind: "project_brain_recommendation", assistantTurnId: latest.id, statementId: s.id } }).ok)
    .map((s) => ({ assistantTurnId: latest.id, statementId: s.id, text: s.text }));
}

export type TargetResolution =
  | {
      kind: "resolved";
      targetRef: ResolvedExecutionBriefTargetRef;
      recommendationText: string | null;
      /** Present exactly when the target is a prior Recommendation. */
      recommendationAnchors: RecommendationAnchors | null;
    }
  | { kind: "invalid" }
  | { kind: "needs_target"; candidates: ExecutionBriefTargetCandidate[] };

/**
 * The ONLY resolution rule (§9.2 table). Reads persisted rows; writes nothing;
 * calls no model.
 */
export function resolveExecutionTarget(input: {
  requested: ExecutionBriefTargetRef | null;
  text: string;
  messages: ContextMessageRow[];
  explicitRow: ContextMessageRow | null;
  conversationId: string | null;
  workspaceId: string;
  scope: ProjectContextScope;
  beforeSeq?: number;
}): TargetResolution {
  const { requested } = input;
  if (requested?.kind === "project_brain_recommendation") {
    if (!input.conversationId) return { kind: "invalid" };
    const validated = validateRecommendationTarget({ row: input.explicitRow, conversationId: input.conversationId, workspaceId: input.workspaceId, scope: input.scope, ref: requested });
    if (!validated.ok) return { kind: "invalid" };
    return { kind: "resolved", targetRef: { ...requested, resolvedBy: "explicit" }, recommendationText: validated.text, recommendationAnchors: validated.anchors };
  }
  if (requested?.kind === "current_user_request" && describesWork(input.text)) {
    return { kind: "resolved", targetRef: { kind: "current_user_request" }, recommendationText: null, recommendationAnchors: null };
  }
  const candidates = input.conversationId
    ? targetCandidates({ messages: input.messages, conversationId: input.conversationId, workspaceId: input.workspaceId, scope: input.scope, beforeSeq: input.beforeSeq })
    : [];
  if (candidates.length === 1 && input.conversationId) {
    const [only] = candidates;
    const ref = { kind: "project_brain_recommendation" as const, assistantTurnId: only.assistantTurnId, statementId: only.statementId };
    const row = input.messages.find((m) => m.id === only.assistantTurnId) ?? null;
    const validated = validateRecommendationTarget({ row, conversationId: input.conversationId, workspaceId: input.workspaceId, scope: input.scope, ref });
    if (!validated.ok) return { kind: "needs_target", candidates };
    return { kind: "resolved", targetRef: { ...ref, resolvedBy: "single_candidate" }, recommendationText: validated.text, recommendationAnchors: validated.anchors };
  }
  return { kind: "needs_target", candidates };
}
