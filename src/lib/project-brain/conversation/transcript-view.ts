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
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextMessageRow } from "@/lib/db/database-contract";
import { labelForEpistemicType } from "../language";
import { EPISTEMIC_TYPES, type EpistemicType } from "../types";

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
  brain: {
    mode: "generative" | "degraded";
    statements: ProjectBrainStatementView[];
    sources: ProjectBrainSourceChip[];
    reason: string | null;
    /**
     * Some generated claims could not be fully linked to project records: a citation
     * was rejected, a statement was downgraded, or a statement was dropped.
     */
    groundingAdjusted: boolean;
    /**
     * A generative answer with NO structured statements: conversational synthesis
     * (general or off-topic), never a set of source-backed project claims.
     */
    conversationalOnly: boolean;
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
  return {
    id: text(s.id) ?? "",
    text: body,
    epistemicType: type as EpistemicType,
    epistemicLabel: labelForEpistemicType(type as EpistemicType),
    confidence,
    sourceIds: sources.map((c) => c.id),
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
  if (row.role === "user") return { ...base, origin: "user", brain: null };
  if (!row.brain_mode) return { ...base, origin: "legacy_project_chat", brain: null };

  const meta = record(record(row.metadata)?.projectBrain);
  const statements = Array.isArray(meta?.statements)
    ? meta.statements.map(statement).filter((s): s is ProjectBrainStatementView => s !== null)
    : [];
  const sources = Array.isArray(meta?.sources) ? meta.sources.map(chip).filter((c): c is ProjectBrainSourceChip => c !== null) : [];
  const citations = record(meta?.citations);
  const groundingAdjusted =
    Number(citations?.rejectedCitations ?? 0) > 0 ||
    Number(citations?.downgradedStatements ?? 0) > 0 ||
    Number(citations?.droppedStatements ?? 0) > 0 ||
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
      conversationalOnly: row.brain_mode === "generative" && statements.length === 0,
    },
  };
}

export function toProjectBrainTranscript(rows: ContextMessageRow[]): ProjectBrainMessageView[] {
  return rows
    .map(toProjectBrainMessageView)
    .filter((m): m is ProjectBrainMessageView => m !== null)
    .sort((a, b) => a.sequence - b.sequence);
}
