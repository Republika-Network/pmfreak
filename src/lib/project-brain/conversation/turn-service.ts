// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — one turn, idempotently (PB-CHAT-01)
//
// A turn is identified by (conversation, clientMessageId). The state of a turn is
// read entirely from persisted rows — no workflow table, no mutable status:
//
//   user row only, younger than TURN_PENDING_WINDOW_MS   → PENDING (another
//        request is generating; answer 202, never run the model again)
//   user row only, older                                  → UNANSWERED: the
//        request that owned it died after persisting the question; a replay
//        recovers it by generating now
//   + generative reply                                    → COMPLETED
//   + degraded reply only                                 → COMPLETED (limited);
//        an explicit `retry` may attempt ONE generative answer
//
// Guarantees:
//   * one user row per clientMessageId       (partial unique index)
//   * at most one reply per (turn, mode)     (partial unique index)
//   * a replay of a completed turn returns it — no inference, no billing
//   * concurrent duplicates on one instance share one in-flight generation
//
// Everything I/O is injected, so the idempotency semantics are testable without
// a database or a provider. This module performs NO project-state write and
// calls NO memory store: its only writes are the two transcript rows.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextConversationRow, ContextMessageBrainMode, ContextMessageRow } from "@/lib/db/database-contract";
import { InferenceError, type InferenceRequest, type InferenceResponse } from "@/lib/ai/inference/types";
import type { ProjectBrainSourceReference, ProjectContextScope } from "../types";
import { PROJECT_BRAIN_CONSTITUTION_VERSION } from "../constitution";
import { PROJECT_BRAIN_INFERENCE, TURN_PENDING_WINDOW_MS } from "./context-budget";
import type { ProjectBrainContext, ProjectBrainHistoryMessage } from "./context-types";
import { buildDegradedReply, type DegradedReason } from "./degraded";
import { groundProjectBrainOutput, parseProjectBrainModelOutput, type CitationReport, type GroundedStatement } from "./output";
import { buildProjectBrainMessages, PROJECT_BRAIN_OUTPUT_SCHEMA } from "./prompt";

export const PROJECT_BRAIN_MODULE_ID = "project-brain";
export const PROJECT_BRAIN_METADATA_VERSION = 1;

export type ProjectBrainTurnStore = {
  findConversation(): Promise<ContextConversationRow | null>;
  getOrCreateConversation(): Promise<ContextConversationRow>;
  listMessages(conversationId: string): Promise<ContextMessageRow[]>;
  findUserMessage(conversationId: string, clientMessageId: string): Promise<ContextMessageRow | null>;
  insertUserMessage(conversationId: string, clientMessageId: string, content: string): Promise<{ row: ContextMessageRow } | { conflict: true }>;
  listReplies(conversationId: string, userMessageId: string): Promise<ContextMessageRow[]>;
  insertReply(input: {
    conversationId: string;
    replyToMessageId: string;
    mode: ContextMessageBrainMode;
    content: string;
    metadata: Record<string, unknown>;
  }): Promise<{ row: ContextMessageRow } | { conflict: true }>;
};

export type ProjectBrainTurnDeps = {
  scope: ProjectContextScope;
  userId: string;
  store: ProjectBrainTurnStore;
  loadContext(history: ProjectBrainHistoryMessage[]): Promise<ProjectBrainContext>;
  infer(request: InferenceRequest): Promise<InferenceResponse>;
  now(): Date;
};

export type ProjectBrainTurnInput = { clientMessageId: string; text: string; retry?: boolean };

export type ProjectBrainTurnResult =
  | {
      status: "completed";
      replayed: boolean;
      conversationId: string;
      userMessage: ContextMessageRow;
      reply: ContextMessageRow;
      /** Set when an explicit retry of a degraded turn could not produce a generative answer. */
      retryFailed?: boolean;
    }
  | { status: "pending"; replayed: true; conversationId: string; userMessage: ContextMessageRow; retryAfterMs: number };

export class ProjectBrainTurnConflictError extends Error {
  constructor(public readonly reason: "client_message_id_owned_by_another_user" | "client_message_id_reused_with_different_text") {
    super(reason);
    this.name = "ProjectBrainTurnConflictError";
  }
}

/** Metadata persisted on a Project Brain reply. Never holds prompts, keys, raw provider payloads or reasoning. */
export type ProjectBrainReplyMetadata = {
  projectBrain: {
    version: number;
    mode: ContextMessageBrainMode;
    statements: GroundedStatement[];
    sources: ProjectBrainSourceReference[];
    constitutionVersion: string;
    reason?: DegradedReason;
    provider?: string;
    model?: string;
    citations?: CitationReport;
    context: { sourceCount: number; truncated: boolean; unavailable: string[] };
  };
};

// Per-instance single flight: two identical requests landing on the same server
// instance share one generation instead of both calling the provider.
const inFlight = new Map<string, Promise<ProjectBrainTurnResult>>();

export function classifyInferenceFailure(error: unknown): DegradedReason {
  if (error && typeof error === "object" && "guardrail" in error) {
    const guardrail = (error as { guardrail?: string }).guardrail;
    return guardrail === "circuit_open" ? "provider_unavailable" : "usage_limit";
  }
  if (error instanceof InferenceError) {
    if (error.errorClass === "timeout") return "timeout";
    if (error.errorClass === "rate_limited") return "rate_limited";
    if (error.errorClass === "auth_error") return "provider_unavailable";
    if (/no approved provider|not registered/i.test(error.message)) return "provider_unavailable";
    return "provider_error";
  }
  return "provider_error";
}

function historyFrom(messages: ContextMessageRow[], before: ContextMessageRow): ProjectBrainHistoryMessage[] {
  // Messages strictly before this turn. A degraded reply is boilerplate about the
  // provider, not conversation, so it is left out when shaping history.
  return messages
    .filter((m) => m.message_seq < before.message_seq && (m.role === "user" || m.role === "assistant") && m.brain_mode !== "degraded")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content, createdAt: m.created_at }));
}

function contextSummary(context: ProjectBrainContext) {
  return { sourceCount: context.sources.length, truncated: context.truncated, unavailable: [...context.unavailable] };
}

async function generate(
  deps: ProjectBrainTurnDeps,
  conversation: ContextConversationRow,
  userMessage: ContextMessageRow,
  existingDegraded: ContextMessageRow | null,
  replayed: boolean,
): Promise<ProjectBrainTurnResult> {
  const { scope, store } = deps;
  const history = historyFrom(await store.listMessages(conversation.id), userMessage);
  const context = await deps.loadContext(history);
  const generatedAt = deps.now().toISOString();

  let generative: { content: string; metadata: ProjectBrainReplyMetadata } | null = null;
  let reason: DegradedReason = "invalid_output";
  try {
    const response = await deps.infer({
      moduleId: PROJECT_BRAIN_MODULE_ID,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      actorId: deps.userId,
      actorType: "user",
      dataSensitivity: "confidential",
      chainDepth: 0,
      messages: buildProjectBrainMessages(context, userMessage.content),
      responseFormat: { type: "json_schema", jsonSchema: PROJECT_BRAIN_OUTPUT_SCHEMA },
      temperature: PROJECT_BRAIN_INFERENCE.temperature,
      maxTokens: PROJECT_BRAIN_INFERENCE.maxTokens,
      timeoutMs: PROJECT_BRAIN_INFERENCE.timeoutMs,
      maxAttempts: PROJECT_BRAIN_INFERENCE.maxAttempts,
      retryDelayMs: PROJECT_BRAIN_INFERENCE.retryDelayMs,
      operationName: "project_brain.turn",
      idempotencyKey: `project-brain:${userMessage.id}:${existingDegraded ? "retry" : "first"}`,
    });
    const parsed = parseProjectBrainModelOutput({ parsedJson: response.parsedJson, content: response.content });
    const grounded = parsed
      ? groundProjectBrainOutput({ output: parsed, context, statementIdPrefix: userMessage.id, generatedAt })
      : null;
    if (grounded?.ok) {
      generative = {
        content: grounded.value.reply,
        metadata: {
          projectBrain: {
            version: PROJECT_BRAIN_METADATA_VERSION,
            mode: "generative",
            statements: grounded.value.statements,
            sources: grounded.value.sources,
            constitutionVersion: PROJECT_BRAIN_CONSTITUTION_VERSION,
            provider: response.provider,
            model: response.model,
            citations: grounded.value.citations,
            context: contextSummary(context),
          },
        },
      };
    } else {
      console.warn(
        JSON.stringify({
          event: "project_brain.invalid_model_output",
          projectId: scope.projectId,
          stage: parsed ? "guardrails" : "schema",
          failureCodes: grounded && !grounded.ok ? grounded.failures.map((f) => f.code) : [],
        }),
      );
    }
  } catch (error) {
    reason = classifyInferenceFailure(error);
    console.warn(JSON.stringify({ event: "project_brain.inference_unavailable", projectId: scope.projectId, reason }));
  }

  if (generative) {
    const inserted = await store.insertReply({
      conversationId: conversation.id,
      replyToMessageId: userMessage.id,
      mode: "generative",
      content: generative.content,
      metadata: generative.metadata,
    });
    return settleInsert(deps, conversation, userMessage, "generative", inserted, replayed);
  }

  if (existingDegraded) {
    // An explicit retry that failed again: the turn keeps its one degraded reply.
    return { status: "completed", replayed: true, conversationId: conversation.id, userMessage, reply: existingDegraded, retryFailed: true };
  }

  const degraded = buildDegradedReply(context);
  const metadata: ProjectBrainReplyMetadata = {
    projectBrain: {
      version: PROJECT_BRAIN_METADATA_VERSION,
      mode: "degraded",
      statements: [],
      sources: degraded.sources,
      constitutionVersion: PROJECT_BRAIN_CONSTITUTION_VERSION,
      reason,
      context: contextSummary(context),
    },
  };
  const inserted = await store.insertReply({
    conversationId: conversation.id,
    replyToMessageId: userMessage.id,
    mode: "degraded",
    content: degraded.content,
    metadata,
  });
  return settleInsert(deps, conversation, userMessage, "degraded", inserted, replayed);
}

async function settleInsert(
  deps: ProjectBrainTurnDeps,
  conversation: ContextConversationRow,
  userMessage: ContextMessageRow,
  mode: ContextMessageBrainMode,
  inserted: { row: ContextMessageRow } | { conflict: true },
  replayed: boolean,
): Promise<ProjectBrainTurnResult> {
  if ("row" in inserted) {
    return { status: "completed", replayed, conversationId: conversation.id, userMessage, reply: inserted.row };
  }
  // Another request answered this turn first; its reply is the answer.
  const replies = await deps.store.listReplies(conversation.id, userMessage.id);
  const winner = replies.find((r) => r.brain_mode === mode) ?? replies.find((r) => r.brain_mode === "generative") ?? replies[0];
  if (!winner) throw new Error("Project Brain reply conflicted but no reply exists.");
  return { status: "completed", replayed: true, conversationId: conversation.id, userMessage, reply: winner };
}

export async function runProjectBrainTurn(deps: ProjectBrainTurnDeps, input: ProjectBrainTurnInput): Promise<ProjectBrainTurnResult> {
  const { store } = deps;
  const conversation = (await store.findConversation()) ?? (await store.getOrCreateConversation());

  let userMessage = await store.findUserMessage(conversation.id, input.clientMessageId);
  let replayed = userMessage !== null;
  if (!userMessage) {
    const inserted = await store.insertUserMessage(conversation.id, input.clientMessageId, input.text);
    if ("row" in inserted) {
      userMessage = inserted.row;
    } else {
      userMessage = await store.findUserMessage(conversation.id, input.clientMessageId);
      replayed = true;
      if (!userMessage) throw new Error("User turn conflicted but could not be re-read.");
    }
  }
  if (userMessage.created_by_user_id !== deps.userId) {
    throw new ProjectBrainTurnConflictError("client_message_id_owned_by_another_user");
  }
  if (userMessage.content !== input.text) {
    throw new ProjectBrainTurnConflictError("client_message_id_reused_with_different_text");
  }

  const replies = await store.listReplies(conversation.id, userMessage.id);
  const generativeReply = replies.find((r) => r.brain_mode === "generative");
  const degradedReply = replies.find((r) => r.brain_mode === "degraded") ?? null;
  if (generativeReply) {
    return { status: "completed", replayed: true, conversationId: conversation.id, userMessage, reply: generativeReply };
  }
  if (degradedReply && !input.retry) {
    return { status: "completed", replayed: true, conversationId: conversation.id, userMessage, reply: degradedReply };
  }

  const key = userMessage.id;
  const running = inFlight.get(key);
  if (running) return running.then((result) => ({ ...result, replayed: true }) as ProjectBrainTurnResult);

  if (!degradedReply && replayed) {
    const ageMs = deps.now().getTime() - new Date(userMessage.created_at).getTime();
    if (ageMs < TURN_PENDING_WINDOW_MS) {
      return {
        status: "pending",
        replayed: true,
        conversationId: conversation.id,
        userMessage,
        retryAfterMs: Math.max(1000, TURN_PENDING_WINDOW_MS - ageMs),
      };
    }
  }

  const work = generate(deps, conversation, userMessage, degradedReply, replayed).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

/** Read-only transcript. Never creates a conversation. */
export async function readProjectBrainTranscript(store: Pick<ProjectBrainTurnStore, "findConversation" | "listMessages">) {
  const conversation = await store.findConversation();
  if (!conversation) return { conversation: null, messages: [] as ContextMessageRow[] };
  return { conversation, messages: await store.listMessages(conversation.id) };
}
