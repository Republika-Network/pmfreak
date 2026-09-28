// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — transcript view model (PB-CHAT-01)
//
// The client-facing shape of a persisted transcript row. Built on the server
// from `context_messages`; the browser never sees raw metadata.
//
// Structured Project Brain data (statements, source chips, mode) is honoured
// ONLY on rows carrying `brain_mode`, a column that — for a project thread — only
// the service-role reply writer can set. A row without it (a user turn, or an
// older deterministic Project Chat reply) renders as plain text with no chips,
// so no member-authored row can ever display as a sourced Project Brain answer.
//
// PB-EXEC-01: a generative brief reply carries `executionBrief` — exposed ONLY after
// strict validation (execution-brief/validate.ts); a malformed or legacy brief is
// omitted (briefUnavailable) and the reply still renders. A user row exposes its
// validated operation identity (`request`) so a retry resends the SAME operation.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextMessageRow } from "@/lib/db/database-contract";
import { labelForEpistemicType } from "../language";
import { EPISTEMIC_TYPES, type EpistemicType } from "../types";
import { storedRequestIdentity } from "../execution-brief/target";
import type { ExecutionBriefV1, ProjectBrainOperation, ProjectBrainRequestIdentity } from "../execution-brief/types";
import { parseExecutionBriefV1 } from "../execution-brief/validate";

export type ProjectBrainSourceChip = {
  /** Server-validated stable source id (`<table>:<uuid>` or a project-configuration key). */
  id: string;
  family: string;
  label: string;
  recordedAt: string | null;
};

export type ProjectBrainStatementView = {
  id: string;
  text: string;
  epistemicType: EpistemicType;
  epistemicLabel: string;
  confidence: string;
  sourceIds: string[];
  /**
   * PB-REASON-02: ids of the user turns (context_messages.id) this claim rests on.
   * Empty on older rows and on claims that rest on project records only.
   */
  reportedTurnIds: string[];
  downgradedFrom: EpistemicType | null;
};

export type ProjectBrainMessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sequence: number;
  clientMessageId: string | null;
  replyToMessageId: string | null;
  /** project_brain = written by the Project Brain path; legacy = an earlier deterministic Project Chat reply. */
  origin: "user" | "project_brain" | "legacy_project_chat";
  /**
   * PB-EXEC-01, user rows only: the validated operation identity the turn was sent
   * with (`{ answer, null }` for older rows). Null on assistant rows or when the
   * stored identity is not a valid one.
   */
  request?: ProjectBrainRequestIdentity | null;
  brain: {
    mode: "generative" | "degraded";
    statements: ProjectBrainStatementView[];
    sources: ProjectBrainSourceChip[];
    reason: string | null;
    /**
     * Some generated claims could not be fully linked to project records: a citation
     * was rejected, a statement was downgraded or dropped, or the answer named a
     * reference (milestone code, PR number, percentage, …) no project record contains.
     */
    groundingAdjusted: boolean;
    /**
     * A generative answer with NO structured statements and NO execution brief:
     * conversational synthesis (general or off-topic), never a set of source-backed
     * project claims. A brief reply is never conversational-only.
     */
    conversationalOnly: boolean;
    /** PB-EXEC-01: which operation produced this reply. */
    operation: ProjectBrainOperation;
    /** PB-EXEC-01: the validated canonical brief, or null. Never raw metadata. */
    executionBrief: ExecutionBriefV1 | null;
    /** PB-EXEC-01: a generative brief reply whose stored brief failed validation (not shown). */
    briefUnavailable: boolean;
  } | null;
};

const EPISTEMIC_SET = new Set<string>(EPISTEMIC_TYPES);
type AnyRecord = Record<string, unknown>;
const record = (value: unknown): AnyRecord | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : null);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function chip(value: unknown): ProjectBrainSourceChip | null {
  const source = record(value);
  const id = text(source?.evidenceId);
  const label = text(source?.title);
  if (!source || !id || !label) return null;
  return { id, family: text(source.evidenceType) ?? "SOURCE", label, recordedAt: text(source.recordedAt) || null };
}

function statement(value: unknown): ProjectBrainStatementView | null {
  const s = record(value);
  const type = text(s?.epistemicType);
  const body = text(s?.text);
  if (!s || !type || !EPISTEMIC_SET.has(type) || !body) return null;
  const confidence = text(record(s.confidence)?.level) ?? "unknown";
  const sources = Array.isArray(s.sources) ? s.sources.map(chip).filter((c): c is ProjectBrainSourceChip => c !== null) : [];
  const downgraded = text(s.downgradedFrom);
  const reportedTurnIds = Array.isArray(s.reports)
    ? s.reports.map((r) => text(record(r)?.turnId)).filter((id): id is string => Boolean(id))
    : [];
  return {
    id: text(s.id) ?? "",
    text: body,
    epistemicType: type as EpistemicType,
    epistemicLabel: labelForEpistemicType(type as EpistemicType),
    confidence,
    sourceIds: sources.map((c) => c.id),
    reportedTurnIds,
    downgradedFrom: downgraded && EPISTEMIC_SET.has(downgraded) ? (downgraded as EpistemicType) : null,
  };
}

export function toProjectBrainMessageView(row: ContextMessageRow): ProjectBrainMessageView | null {
  if (row.role !== "user" && row.role !== "assistant") return null;
  const base = {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    sequence: Number(row.message_seq),
    clientMessageId: row.client_message_id ?? null,
    replyToMessageId: row.reply_to_message_id ?? null,
  };
  if (row.role === "user") {
    const identity = storedRequestIdentity(row);
    return { ...base, origin: "user", request: identity === "unknown" ? null : identity, brain: null };
  }
  if (!row.brain_mode) return { ...base, origin: "legacy_project_chat", brain: null };

  const meta = record(record(row.metadata)?.projectBrain);
  const statements = Array.isArray(meta?.statements)
    ? meta.statements.map(statement).filter((s): s is ProjectBrainStatementView => s !== null)
    : [];
  const operation: ProjectBrainOperation = meta?.operation === "execution_brief" || meta?.executionBrief !== undefined ? "execution_brief" : "answer";
  const executionBrief = row.brain_mode === "generative" && meta?.executionBrief !== undefined ? parseExecutionBriefV1(meta.executionBrief) : null;
  const briefUnavailable = row.brain_mode === "generative" && operation === "execution_brief" && executionBrief === null;
  const sources = executionBrief
    ? executionBrief.provenance.sources.map(chip).filter((c): c is ProjectBrainSourceChip => c !== null)
    : Array.isArray(meta?.sources)
      ? meta.sources.map(chip).filter((c): c is ProjectBrainSourceChip => c !== null)
      : [];
  const citations = record(meta?.citations);
  const groundingAdjusted =
    Boolean(executionBrief?.provenance.groundingAdjusted) ||
    Number(citations?.rejectedCitations ?? 0) > 0 ||
    Number(citations?.rejectedReports ?? 0) > 0 ||
    Number(citations?.downgradedStatements ?? 0) > 0 ||
    Number(citations?.droppedStatements ?? 0) > 0 ||
    Number(citations?.unsupportedReferences ?? 0) > 0 ||
    statements.some((s) => s.downgradedFrom);
  return {
    ...base,
    origin: "project_brain",
    brain: {
      mode: row.brain_mode,
      statements,
      sources,
      reason: row.brain_mode === "degraded" ? text(meta?.reason) : null,
      groundingAdjusted,
      conversationalOnly: row.brain_mode === "generative" && statements.length === 0 && executionBrief === null && operation === "answer",
      operation,
      executionBrief,
      briefUnavailable,
    },
  };
}

export function toProjectBrainTranscript(rows: ContextMessageRow[]): ProjectBrainMessageView[] {
  return rows
    .map(toProjectBrainMessageView)
    .filter((m): m is ProjectBrainMessageView => m !== null)
    .sort((a, b) => a.sequence - b.sequence);
}
