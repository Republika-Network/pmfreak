"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProjectBrainMessageView,
  ProjectBrainSourceChip,
  ProjectBrainStatementView,
} from "@/lib/project-brain/conversation/transcript-view";

/**
 * PB-CHAT-01 — the ONE Project Brain conversation for a project.
 *
 * Persisted (context_conversations / context_messages), project-isolated,
 * generative when the provider is healthy and explicitly "limited mode" when it
 * is not. Every send carries a client-generated id, so a retry — automatic or the
 * user's — is the same turn, never a duplicate.
 *
 * What the customer is told, precisely: the prose of an answer is the model's
 * conversational SYNTHESIS. The listed claims are the structured layer — each
 * validated against the records supplied for this turn and labelled with its
 * epistemic status — and their chips show which project records were cited. A
 * citation proves which record was used, not that it semantically supports every
 * sentence of the prose; nothing here claims otherwise.
 *
 * Deliberately absent (PB-CHAT-02/03): attachments, screenshots, slash commands,
 * "create risk/decision" controls, "Add to project". Nothing here writes project
 * state; the only thing a send persists is the conversation itself.
 */

type Variant = "dark" | "light";

type TurnResponse = {
  status?: "completed" | "pending";
  messages?: Array<ProjectBrainMessageView | null>;
  retryAfterMs?: number;
  retryFailed?: boolean;
  error?: string;
};

type OutgoingTurn = { clientMessageId: string; text: string; retry?: boolean };

const STYLES: Record<Variant, Record<string, string>> = {
  dark: {
    frame: "flex h-full min-h-0 flex-col",
    user: "max-w-2xl self-end whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-gradient-to-br from-sky-500 to-indigo-600 px-4 py-3 text-sm text-white",
    assistant: "max-w-2xl whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.03] px-4 py-3.5 text-sm leading-relaxed text-zinc-200",
    muted: "text-zinc-500",
    chip: "rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-zinc-300",
    divider: "border-white/10",
    composer: "flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2 focus-within:border-sky-500/40",
    input: "block max-h-40 min-h-[2.5rem] w-full resize-none bg-transparent py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500",
    send: "rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40",
    notice: "rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200",
    error: "text-xs text-rose-300",
    link: "text-xs font-medium text-sky-300 underline-offset-2 hover:underline",
  },
  light: {
    frame: "flex h-full min-h-0 flex-col",
    user: "max-w-2xl self-end whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-cyan-300/40 bg-cyan-50 px-4 py-3 text-sm text-cyan-950",
    assistant: "max-w-2xl whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm leading-relaxed text-slate-800",
    muted: "text-slate-500",
    chip: "rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-700",
    divider: "border-slate-200",
    composer: "flex items-end gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 focus-within:border-cyan-400",
    input: "block max-h-40 min-h-[2.5rem] w-full resize-none bg-transparent py-2 text-sm text-slate-900 outline-none placeholder:text-slate-500",
    send: "rounded-xl border border-cyan-300 bg-cyan-50 px-3.5 py-2 text-xs font-semibold text-cyan-900 transition hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-40",
    notice: "rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900",
    error: "text-xs text-rose-700",
    link: "text-xs font-medium text-cyan-800 underline-offset-2 hover:underline",
  },
};

/**
 * Customer wording for the epistemic contract — a label, never the ontology.
 * FACT says only what the server checked: the claim CITES valid project records (identity
 * and scope). It must not suggest the records prove the claim or that it came from them.
 */
const EPISTEMIC_BADGE: Record<string, string> = {
  FACT: "Cites project records",
  REPORTED: "Reported",
  INFERENCE: "Inference",
  ASSUMPTION: "Unverified",
  OPEN_QUESTION: "Open question",
  CONTRADICTION: "Records conflict",
  RECOMMENDATION: "Suggestion · needs your approval",
  UNKNOWN: "Not known yet",
};

const FAMILY_LABEL: Record<string, string> = {
  PROJECT: "Project",
  ONBOARDING: "Project setup",
  EVIDENCE: "Evidence",
  SIGNAL: "Signal",
  RISK: "Risk",
  ISSUE: "Issue",
  RECOMMENDATION: "Recommendation",
  DECISION: "Decision",
  ACTION: "Action",
  TASK: "Task",
  OUTCOME: "Outcome",
  MILESTONE: "Milestone",
  RAID_DISCOVERY: "Discovery",
};

const MAX_PENDING_POLLS = 3;

function newClientMessageId(): string {
  return crypto.randomUUID();
}

function mergeMessages(current: ProjectBrainMessageView[], incoming: ProjectBrainMessageView[]): ProjectBrainMessageView[] {
  const byId = new Map(current.filter((m) => !m.id.startsWith("local:")).map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  const confirmedClientIds = new Set(incoming.map((m) => m.clientMessageId).filter(Boolean));
  const stillLocal = current.filter((m) => m.id.startsWith("local:") && !confirmedClientIds.has(m.clientMessageId));
  return [...byId.values(), ...stillLocal].sort((a, b) => a.sequence - b.sequence);
}

function SourceChips({ sources, styles }: { sources: ProjectBrainSourceChip[]; styles: Record<string, string> }) {
  if (sources.length === 0) return null;
  return (
    <div className={`mt-3 border-t pt-2.5 ${styles.divider}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${styles.muted}`}>Records cited</p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5" data-testid="project-brain-sources">
        {sources.map((source) => (
          <li key={source.id}>
            <span
              className={styles.chip}
              data-source-id={source.id}
              data-source-family={source.family}
              title={source.recordedAt ? `Recorded ${source.recordedAt.slice(0, 10)}` : undefined}
            >
              <span className="font-semibold">{FAMILY_LABEL[source.family] ?? "Source"}</span> · {source.label.replace(/^[^—]+—\s*/, "")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Statements({ statements, styles }: { statements: ProjectBrainStatementView[]; styles: Record<string, string> }) {
  if (statements.length === 0) return null;
  return (
    <div className="mt-3">
      <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${styles.muted}`}>Claims about this project</p>
      <ul className="mt-1.5 space-y-1.5" data-testid="project-brain-statements">
        {statements.map((statement) => (
          <li key={statement.id} className="text-xs leading-relaxed" data-epistemic-type={statement.epistemicType}>
            <span className={`mr-1.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${styles.divider} ${styles.muted}`}>
              {EPISTEMIC_BADGE[statement.epistemicType] ?? statement.epistemicLabel}
            </span>
            {statement.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

type ConversationProps = {
  projectId: string;
  projectName: string;
  variant?: Variant;
  /** Lets a host (e.g. a collapsible panel) say how much the thread holds. */
  onTranscriptSizeChange?: (count: number) => void;
};

/**
 * Thread identity IS the project: the inner conversation is keyed by projectId, so
 * switching projects is a fresh mount that loads the other project's persisted thread —
 * no state from one project's thread can survive into another's.
 */
export function ProjectBrainConversation(props: ConversationProps) {
  return <ProjectThread key={props.projectId} {...props} />;
}

function ProjectThread({ projectId, projectName, variant = "dark", onTranscriptSizeChange }: ConversationProps) {
  const styles = STYLES[variant];
  const [messages, setMessages] = useState<ProjectBrainMessageView[]>([]);
  const [generativeAvailable, setGenerativeAvailable] = useState(true);
  const [limitedModeReason, setLimitedModeReason] = useState<"not_included" | "unavailable" | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ message: string; turn: OutgoingTurn } | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeProject = useRef(projectId);

  useEffect(() => {
    activeProject.current = projectId;
    let live = true;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/brain/turns`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          messages?: ProjectBrainMessageView[];
          generativeAvailable?: boolean;
          limitedModeReason?: "not_included" | "unavailable" | null;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "Unable to load the conversation.");
        if (!live) return;
        setMessages(data.messages ?? []);
        setGenerativeAvailable(data.generativeAvailable !== false);
        setLimitedModeReason(data.limitedModeReason ?? null);
      })
      .catch((error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : "Unable to load the conversation.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  useEffect(() => {
    onTranscriptSizeChange?.(messages.length);
  }, [messages.length, onTranscriptSizeChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, sending]);

  const submit = useCallback(
    async (turn: OutgoingTurn) => {
      const forProject = projectId;
      setSending(true);
      setSendError(null);
      if (!turn.retry) {
        setMessages((current) =>
          current.some((m) => m.clientMessageId === turn.clientMessageId)
            ? current
            : [
                ...current,
                {
                  id: `local:${turn.clientMessageId}`,
                  role: "user",
                  content: turn.text,
                  createdAt: new Date().toISOString(),
                  sequence: Number.MAX_SAFE_INTEGER,
                  clientMessageId: turn.clientMessageId,
                  replyToMessageId: null,
                  origin: "user",
                  brain: null,
                },
              ],
        );
      }
      try {
        for (let poll = 0; poll <= MAX_PENDING_POLLS; poll += 1) {
          const res = await fetch(`/api/projects/${encodeURIComponent(forProject)}/brain/turns`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(turn),
          });
          const data = (await res.json().catch(() => ({}))) as TurnResponse;
          if (activeProject.current !== forProject) return;
          if (!res.ok) throw new Error(data.error ?? "Project Brain could not answer just now.");
          const incoming = (data.messages ?? []).filter((m): m is ProjectBrainMessageView => m !== null);
          setMessages((current) => mergeMessages(current, incoming));
          if (data.status !== "pending") {
            if (data.retryFailed) setSendError({ message: "Project Brain is still in limited mode. Try again in a moment.", turn });
            return;
          }
          // Another request is still answering this same turn — wait, then ask for it
          // again with the SAME id. This never creates a second turn.
          await new Promise((resolve) => setTimeout(resolve, Math.min(data.retryAfterMs ?? 5000, 20_000)));
        }
        throw new Error("Project Brain is still working on this message.");
      } catch (error) {
        if (activeProject.current === forProject) {
          setSendError({ message: error instanceof Error ? error.message : "Project Brain could not answer just now.", turn });
        }
      } finally {
        if (activeProject.current === forProject) setSending(false);
      }
    },
    [projectId],
  );

  const send = () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    void submit({ clientMessageId: newClientMessageId(), text });
  };

  const retryDegraded = (reply: ProjectBrainMessageView) => {
    const question = messages.find((m) => m.id === reply.replyToMessageId);
    if (!question?.clientMessageId || sending) return;
    void submit({ clientMessageId: question.clientMessageId, text: question.content, retry: true });
  };

  const upgraded = new Set(
    messages.filter((m) => m.brain?.mode === "generative" && m.replyToMessageId).map((m) => m.replyToMessageId),
  );

  return (
    <div className={styles.frame} data-testid="project-brain-conversation" data-project-id={projectId}>
      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
        {loading ? (
          <p className={`text-sm ${styles.muted}`}>Loading this project&apos;s conversation…</p>
        ) : loadError ? (
          <p className={styles.error}>{loadError}</p>
        ) : messages.length === 0 ? (
          <div className="space-y-1">
            <p className="text-sm font-semibold">Ask Project Brain about {projectName}.</p>
            <p className={`text-xs ${styles.muted}`}>For example: &ldquo;What is the current status of this project?&rdquo; or &ldquo;Which risks are open?&rdquo;</p>
          </div>
        ) : (
          messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <div className={styles.user} data-testid="project-brain-user-message">
                  {message.content}
                </div>
              </div>
            ) : (
              <div key={message.id} className={styles.assistant} data-testid="project-brain-assistant-message" data-mode={message.brain?.mode ?? "legacy"}>
                {message.brain?.mode === "degraded" ? (
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-500">Limited mode</p>
                ) : null}
                {message.origin === "legacy_project_chat" ? (
                  <p className={`mb-1 text-[11px] ${styles.muted}`}>Earlier rule-based Project Chat reply</p>
                ) : null}
                {message.brain?.mode === "generative" ? (
                  <p className={`mb-1 text-[11px] ${styles.muted}`} data-testid="project-brain-synthesis-label">AI-written answer</p>
                ) : null}
                <p>{message.content}</p>
                {message.brain?.conversationalOnly ? (
                  <p className={`mt-2 text-[11px] ${styles.muted}`} data-testid="project-brain-conversational-note">
                    General answer — not linked to this project&apos;s records.
                  </p>
                ) : null}
                {message.brain ? <Statements statements={message.brain.statements} styles={styles} /> : null}
                {message.brain ? <SourceChips sources={message.brain.sources} styles={styles} /> : null}
                {message.brain?.groundingAdjusted ? (
                  <p className={`mt-2 text-[11px] ${styles.muted}`} data-testid="project-brain-grounding-notice">
                    Some generated claims could not be fully linked to project records.
                  </p>
                ) : null}
                {message.brain?.mode === "degraded" && message.brain.reason !== "not_entitled" && !upgraded.has(message.replyToMessageId) ? (
                  <button type="button" className={`mt-2 ${styles.link}`} onClick={() => retryDegraded(message)} disabled={sending}>
                    Try again with Project Brain
                  </button>
                ) : null}
              </div>
            ),
          )
        )}
        {sending ? <p className={`text-xs ${styles.muted}`} data-testid="project-brain-thinking">Project Brain is thinking…</p> : null}
        {sendError ? (
          <p className={styles.error}>
            {sendError.message}{" "}
            <button type="button" className={styles.link} onClick={() => void submit(sendError.turn)} disabled={sending}>
              Retry
            </button>
          </p>
        ) : null}
      </div>

      <div className={`border-t px-4 py-3 sm:px-5 ${styles.divider}`}>
        {!generativeAvailable ? (
          <p className={`mb-2 ${styles.notice}`} data-testid="project-brain-limited-mode">
            {limitedModeReason === "not_included"
              ? "Full generative Project Brain answers aren't included in your current plan. Answers list what this project's records show."
              : "Project Brain is temporarily operating in limited mode: answers list what this project's records show, without a full generative answer."}
          </p>
        ) : null}
        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label htmlFor={`project-brain-input-${projectId}`} className="sr-only">
            Ask Project Brain
          </label>
          <textarea
            id={`project-brain-input-${projectId}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            rows={1}
            maxLength={4000}
            placeholder="Ask Project Brain…"
            className={styles.input}
            data-testid="project-brain-input"
          />
          <button type="submit" disabled={sending || !draft.trim()} className={styles.send}>
            Send
          </button>
        </form>
        <p className={`mt-2 px-1 text-[11px] ${styles.muted}`} data-testid="project-brain-disclosure">
          Project Brain writes its answers from this project&apos;s records and this conversation. Listed claims show which records they cite; a citation is not proof of every sentence. It cannot change the project.
        </p>
      </div>
    </div>
  );
}
