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
//   * a turn that is not generatively entitled never calls the provider; it is
//     answered in limited mode (see generative-access.ts)
//
// Everything I/O is injected, so the idempotency semantics are testable without
// a database or a provider. This module performs NO project-state write and
// calls NO memory store: its only writes are the two transcript rows.
//
// PB-EXEC-01 — a turn has an OPERATION: `answer` (default, unchanged) or
// `execution_brief`. The user row stores the requested operation identity
// (`metadata.projectBrainRequest`); a replay whose identity differs is a 409, never a
// replay of another operation's answer. A brief request resolves its target BEFORE
// anything is written (execution-brief/target.ts): an invalid explicit target is
// refused (ProjectBrainExecutionTargetError → 400) and an ambiguous one returns
// `needs_target` — no conversation, user row, reply, provider call or usage row.
// A brief turn runs the dedicated `project_brain.execution_brief` operation INSTEAD
// of the answer inference (execution-brief/generate.ts): still one call per turn.
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
import { buildReportedContext } from "./reported-context";
import { canonicalJson } from "../execution-brief/canonical-json";
import { executionBriefReplyContent, generateExecutionBrief } from "../execution-brief/generate";
import { requestIdentityMetadata, resolveExecutionTarget, storedRequestIdentity, type TargetResolution } from "../execution-brief/target";
import {
  ANSWER_REQUEST_IDENTITY,
  type ExecutionBriefTargetCandidate,
  type ExecutionBriefV1,
  type ProjectBrainOperation,
  type ProjectBrainRequestIdentity,
} from "../execution-brief/types";

export const PROJECT_BRAIN_MODULE_ID = "project-brain";
export const PROJECT_BRAIN_METADATA_VERSION = 1;

export type ProjectBrainTurnStore = {
  findConversation(): Promise<ContextConversationRow | null>;
  getOrCreateConversation(): Promise<ContextConversationRow>;
  listMessages(conversationId: string): Promise<ContextMessageRow[]>;
  findUserMessage(conversationId: string, clientMessageId: string): Promise<ContextMessageRow | null>;
  /**
   * `metadata` is built HERE, server-side, and is only ever the bounded operation
   * identity `{ projectBrainRequest }` — never client-supplied metadata.
   */
  insertUserMessage(
    conversationId: string,
    clientMessageId: string,
    content: string,
    metadata?: { projectBrainRequest: ProjectBrainRequestIdentity },
  ): Promise<{ row: ContextMessageRow } | { conflict: true }>;
  /**
   * PB-EXEC-01: one row of THIS conversation (and workspace) by id, for explicit
   * target validation. Optional for older stores; the bounded transcript is searched
   * when absent.
   */
  findMessage?(conversationId: string, messageId: string): Promise<ContextMessageRow | null>;
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
  /**
   * Server-resolved (resolveProjectBrainGenerativeAccess): may this turn call the
   * provider at all? Required — there is deliberately no default, so no caller can
   * reach inference without having decided entitlement.
   */
  generativeEntitled: boolean;
  store: ProjectBrainTurnStore;
  loadContext(history: ProjectBrainHistoryMessage[]): Promise<ProjectBrainContext>;
  infer(request: InferenceRequest): Promise<InferenceResponse>;
  now(): Date;
};

export type ProjectBrainTurnInput = {
  clientMessageId: string;
  text: string;
  retry?: boolean;
  /** PB-EXEC-01: the requested operation identity; absent = `{ answer, null }`. */
  request?: ProjectBrainRequestIdentity;
};

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

/**
 * PB-EXEC-01 §9.2.1: an execution-brief request without a usable target. Nothing
 * was written and no model was called; the candidates come from persisted rows.
 * Only `runProjectBrainRequest` can return it — never an answer turn.
 */
export type ProjectBrainNeedsTargetResult = { status: "needs_target"; conversationId: string | null; candidates: ExecutionBriefTargetCandidate[] };

export class ProjectBrainTurnConflictError extends Error {
  constructor(
    public readonly reason:
      | "client_message_id_owned_by_another_user"
      | "client_message_id_reused_with_different_text"
      | "client_message_id_reused_with_different_operation",
  ) {
    super(reason);
    this.name = "ProjectBrainTurnConflictError";
  }
}

/** PB-EXEC-01: an explicit `targetRef` failed server-side validation (§9.2 rules 1–5). Nothing was written. */
export class ProjectBrainExecutionTargetError extends Error {
  readonly code = "invalid_execution_target";
  constructor() {
    super("invalid_execution_target");
    this.name = "ProjectBrainExecutionTargetError";
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
    /** reportCount (PB-REASON-02) is absent on older rows. */
    context: { sourceCount: number; truncated: boolean; unavailable: string[]; reportCount?: number };
    /** PB-EXEC-01: set on replies to an `execution_brief` turn (absent = an answer). */
    operation?: Extract<ProjectBrainOperation, "execution_brief">;
    /** PB-EXEC-01: the canonical, validated brief (generative brief replies only). Additive; version stays 1. */
    executionBrief?: ExecutionBriefV1;
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

function historyFrom(messages: ContextMessageRow[], before: ContextMessageRow, userId: string): ProjectBrainHistoryMessage[] {
  // Messages strictly before this turn. A degraded reply is boilerplate about the
  // provider, not conversation, so it is left out when shaping history.
  // PB-REASON-02: a user row keeps its id and, when it has an authenticated author
  // (RLS: created_by_user_id = auth.uid()), who wrote it — only such a row can later
  // become a report. Assistant rows never get an author.
  return messages
    .filter((m) => m.message_seq < before.message_seq && (m.role === "user" || m.role === "assistant") && m.brain_mode !== "degraded")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      createdAt: m.created_at,
      id: m.id,
      ...(m.role === "user" && m.created_by_user_id
        ? { author: m.created_by_user_id === userId ? ("you" as const) : ("another project member" as const) }
        : {}),
    }));
}

function contextSummary(context: ProjectBrainContext) {
  return { sourceCount: context.sources.length, truncated: context.truncated, unavailable: [...context.unavailable], reportCount: context.reports?.length ?? 0 };
}

async function generate(
  deps: ProjectBrainTurnDeps,
  conversation: ContextConversationRow,
  userMessage: ContextMessageRow,
  existingDegraded: ContextMessageRow | null,
  replayed: boolean,
  brief: BriefTurn | null = null,
): Promise<ProjectBrainTurnResult> {
  if (brief) return generateBriefTurn(deps, conversation, userMessage, existingDegraded, replayed, brief);
  const { scope, store } = deps;
  const history = historyFrom(await store.listMessages(conversation.id), userMessage, deps.userId);
  // PB-REASON-02: the report map is built from the BOUNDED history the context
  // kept, plus this turn — never from the loader, never from assistant rows.
  const context = buildReportedContext(await deps.loadContext(history), { id: userMessage.id, createdAt: userMessage.created_at });
  const generatedAt = deps.now().toISOString();

  let generative: { content: string; metadata: ProjectBrainReplyMetadata } | null = null;
  let reason: DegradedReason = "invalid_output";
  if (!deps.generativeEntitled) {
    // Not entitled to generative Project Brain: answer in limited mode WITHOUT any
    // provider call (no inference, no billing, no usage row).
    reason = "not_entitled";
  } else {
    try {
      const response = await deps.infer({
        moduleId: PROJECT_BRAIN_MODULE_ID,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        actorId: deps.userId,
        actorType: "user",
        dataSensitivity: "confidential",
        chainDepth: 0,
        messages: buildProjectBrainMessages(context, userMessage.content, { asOf: generatedAt }),
        responseFormat: { type: "json_schema", jsonSchema: PROJECT_BRAIN_OUTPUT_SCHEMA },
        temperature: PROJECT_BRAIN_INFERENCE.temperature,
        maxTokens: PROJECT_BRAIN_INFERENCE.maxTokens,
        timeoutMs: PROJECT_BRAIN_INFERENCE.timeoutMs,
        maxAttempts: PROJECT_BRAIN_INFERENCE.maxAttempts,
        retryDelayMs: PROJECT_BRAIN_INFERENCE.retryDelayMs,
        operationName: "project_brain.turn",
        idempotencyKey: `project-brain:${userMessage.id}:${existingDegraded ? "retry" : "first"}`,
      });
      if (response.finishReason === "length") {
        // The provider stopped at the output-token ceiling. Identifiers and the
        // finish reason only — never content. The truncated JSON fails parsing below
        // and the turn degrades honestly.
        console.warn(JSON.stringify({ event: "project_brain.output_truncated", projectId: scope.projectId, finishReason: response.finishReason, maxTokens: PROJECT_BRAIN_INFERENCE.maxTokens }));
      }
      const parsed = parseProjectBrainModelOutput({ parsedJson: response.parsedJson, content: response.content });
      const grounded = parsed
        ? groundProjectBrainOutput({ output: parsed, context, statementIdPrefix: userMessage.id, generatedAt, question: userMessage.content })
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
            finishReason: response.finishReason ?? null,
            failureCodes: grounded && !grounded.ok ? grounded.failures.map((f) => f.code) : [],
          }),
        );
      }
    } catch (error) {
      reason = classifyInferenceFailure(error);
      console.warn(JSON.stringify({ event: "project_brain.inference_unavailable", projectId: scope.projectId, reason }));
    }
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

  const degraded = buildDegradedReply(context, reason);
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

// ─── PB-EXEC-01: the execution-brief operation ───────────────────────────────

type BriefTurn = { identity: ProjectBrainRequestIdentity; resolution: TargetResolution | null };

/** First line of a limited-mode reply to a brief request: no partial brief, and why. */
export const BRIEF_DEGRADED_NOTICE =
  "Project Brain is temporarily operating in limited mode, so I can't prepare the execution brief right now. Execution briefs require generative Project Brain; no partial brief was produced.";
export const BRIEF_NOT_ENTITLED_NOTICE =
  "Project Brain is in limited mode because full generative answers aren't included in your current plan, so I can't prepare an execution brief: execution briefs require generative Project Brain.";

/** The ordinary reply-metadata source list: the brief's provenance sources without their digests. */
function withoutDigest({ sourceContextDigest, ...reference }: ExecutionBriefV1["provenance"]["sources"][number]): ProjectBrainSourceReference {
  void sourceContextDigest;
  return reference;
}

async function loadMessage(deps: ProjectBrainTurnDeps, conversationId: string, messageId: string, messages: ContextMessageRow[]): Promise<ContextMessageRow | null> {
  if (deps.store.findMessage) return deps.store.findMessage(conversationId, messageId);
  return messages.find((m) => m.id === messageId) ?? null;
}

/** Deterministic, read-only target resolution (execution-brief/target.ts). */
async function resolveBriefTarget(
  deps: ProjectBrainTurnDeps,
  conversation: ContextConversationRow | null,
  identity: ProjectBrainRequestIdentity,
  text: string,
  beforeSeq?: number,
): Promise<TargetResolution> {
  const messages = conversation ? await deps.store.listMessages(conversation.id) : [];
  const requested = identity.targetRef;
  const explicitRow =
    conversation && requested?.kind === "project_brain_recommendation" ? await loadMessage(deps, conversation.id, requested.assistantTurnId, messages) : null;
  return resolveExecutionTarget({
    requested,
    text,
    messages,
    explicitRow,
    conversationId: conversation?.id ?? null,
    workspaceId: deps.scope.workspaceId,
    scope: deps.scope,
    beforeSeq,
  });
}

async function generateBriefTurn(
  deps: ProjectBrainTurnDeps,
  conversation: ContextConversationRow,
  userMessage: ContextMessageRow,
  existingDegraded: ContextMessageRow | null,
  replayed: boolean,
  brief: BriefTurn,
): Promise<ProjectBrainTurnResult> {
  const { scope, store } = deps;
  const history = historyFrom(await store.listMessages(conversation.id), userMessage, deps.userId);
  const context = buildReportedContext(await deps.loadContext(history), { id: userMessage.id, createdAt: userMessage.created_at });
  const generatedAt = deps.now().toISOString();
  // A replay that must generate (unanswered, or an explicit retry) re-resolves the
  // target from the SAME persisted rows, strictly before this turn — deterministic,
  // and never a different target than the one the turn was created with.
  const resolution = brief.resolution ?? (await resolveBriefTarget(deps, conversation, brief.identity, userMessage.content, Number(userMessage.message_seq)));

  let reason: DegradedReason = "invalid_output";
  if (!deps.generativeEntitled) {
    reason = "not_entitled";
  } else if (resolution.kind === "resolved") {
    try {
      const outcome = await generateExecutionBrief({
        scope,
        userId: deps.userId,
        moduleId: PROJECT_BRAIN_MODULE_ID,
        conversationId: conversation.id,
        userMessage,
        context,
        targetRef: resolution.targetRef,
        recommendationText: resolution.recommendationText,
        generatedAt,
        retry: existingDegraded !== null,
        infer: deps.infer,
        newBriefId: () => crypto.randomUUID(),
      });
      if (outcome.ok) {
        const metadata: ProjectBrainReplyMetadata = {
          projectBrain: {
            version: PROJECT_BRAIN_METADATA_VERSION,
            mode: "generative",
            // The brief carries its own grounded structure; no ordinary statements are invented for it.
            statements: [],
            sources: outcome.brief.provenance.sources.map(withoutDigest),
            constitutionVersion: PROJECT_BRAIN_CONSTITUTION_VERSION,
            provider: outcome.provider,
            model: outcome.model,
            citations: {
              rejectedCitations: outcome.brief.provenance.citations.rejectedCitations,
              rejectedReports: outcome.brief.provenance.citations.rejectedReports,
              downgradedStatements: outcome.brief.provenance.citations.demotedItems,
              droppedStatements: outcome.brief.provenance.citations.droppedItems + outcome.brief.provenance.citations.credentialFindings + outcome.brief.provenance.citations.blockedCommands,
              unsupportedReferences: outcome.brief.provenance.citations.unsupportedReferences,
            },
            context: contextSummary(context),
            operation: "execution_brief",
            executionBrief: outcome.brief,
          },
        };
        const inserted = await store.insertReply({
          conversationId: conversation.id,
          replyToMessageId: userMessage.id,
          mode: "generative",
          content: executionBriefReplyContent(outcome.brief),
          metadata,
        });
        return settleInsert(deps, conversation, userMessage, "generative", inserted, replayed);
      }
      console.warn(JSON.stringify({ event: "project_brain.execution_brief.invalid_model_output", projectId: scope.projectId, stage: outcome.stage }));
    } catch (error) {
      reason = classifyInferenceFailure(error);
      console.warn(JSON.stringify({ event: "project_brain.execution_brief.inference_unavailable", projectId: scope.projectId, reason }));
    }
  }

  if (existingDegraded) {
    return { status: "completed", replayed: true, conversationId: conversation.id, userMessage, reply: existingDegraded, retryFailed: true };
  }

  const degraded = buildDegradedReply(context, reason);
  const [, ...rest] = degraded.content.split("\n");
  const metadata: ProjectBrainReplyMetadata = {
    projectBrain: {
      version: PROJECT_BRAIN_METADATA_VERSION,
      mode: "degraded",
      statements: [],
      sources: degraded.sources,
      constitutionVersion: PROJECT_BRAIN_CONSTITUTION_VERSION,
      reason,
      context: contextSummary(context),
      operation: "execution_brief",
    },
  };
  const inserted = await store.insertReply({
    conversationId: conversation.id,
    replyToMessageId: userMessage.id,
    mode: "degraded",
    content: [reason === "not_entitled" ? BRIEF_NOT_ENTITLED_NOTICE : BRIEF_DEGRADED_NOTICE, ...rest].join("\n"),
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

/** An ordinary turn (any operation whose target is already resolvable). Never returns needs_target. */
export async function runProjectBrainTurn(deps: ProjectBrainTurnDeps, input: ProjectBrainTurnInput): Promise<ProjectBrainTurnResult> {
  const result = await runProjectBrainRequest(deps, input);
  if (result.status === "needs_target") throw new ProjectBrainExecutionTargetError();
  return result;
}

/** The route's entry point: an answer turn, a brief turn, or a pre-turn target selection. */
export async function runProjectBrainRequest(deps: ProjectBrainTurnDeps, input: ProjectBrainTurnInput): Promise<ProjectBrainTurnResult | ProjectBrainNeedsTargetResult> {
  const { store } = deps;
  const identity = input.request ?? ANSWER_REQUEST_IDENTITY;
  const existing = await store.findConversation();

  let userMessage = existing ? await store.findUserMessage(existing.id, input.clientMessageId) : null;
  let replayed = userMessage !== null;
  let resolution: TargetResolution | null = null;
  if (!userMessage && identity.operation === "execution_brief") {
    // §9.2.1: resolve BEFORE anything is written. Reads only.
    resolution = await resolveBriefTarget(deps, existing, identity, input.text);
    if (resolution.kind === "invalid") throw new ProjectBrainExecutionTargetError();
    if (resolution.kind === "needs_target") return { status: "needs_target", conversationId: existing?.id ?? null, candidates: resolution.candidates };
  }

  const conversation = existing ?? (await store.getOrCreateConversation());
  if (!userMessage) {
    const inserted = await store.insertUserMessage(conversation.id, input.clientMessageId, input.text, requestIdentityMetadata(identity));
    if ("row" in inserted) {
      userMessage = inserted.row;
    } else {
      userMessage = await store.findUserMessage(conversation.id, input.clientMessageId);
      replayed = true;
      resolution = null;
      if (!userMessage) throw new Error("User turn conflicted but could not be re-read.");
    }
  }
  if (userMessage.created_by_user_id !== deps.userId) {
    throw new ProjectBrainTurnConflictError("client_message_id_owned_by_another_user");
  }
  if (userMessage.content !== input.text) {
    throw new ProjectBrainTurnConflictError("client_message_id_reused_with_different_text");
  }
  // PB-EXEC-01: never replay an answer as a brief, a brief as an answer, or one
  // target's brief as another's. A legacy row (no identity) is `{ answer, null }`.
  const stored = storedRequestIdentity(userMessage);
  if (stored === "unknown" || canonicalJson(stored) !== canonicalJson(identity)) {
    throw new ProjectBrainTurnConflictError("client_message_id_reused_with_different_operation");
  }
  const brief: BriefTurn | null = identity.operation === "execution_brief" ? { identity, resolution } : null;

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

  const work = generate(deps, conversation, userMessage, degradedReply, replayed, brief).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

/** Read-only transcript. Never creates a conversation. */
export async function readProjectBrainTranscript(store: Pick<ProjectBrainTurnStore, "findConversation" | "listMessages">) {
  const conversation = await store.findConversation();
  if (!conversation) return { conversation: null, messages: [] as ContextMessageRow[] };
  return { conversation, messages: await store.listMessages(conversation.id) };
}
