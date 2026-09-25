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
 *
 * CHAT-SHELL-01 — ONE implementation, two layouts. `panel` is the compact
 * rendering a host frames at a fixed height. `surface` is the conversation as
 * the product's primary surface: it fills the centre of the shell, keeps a
 * readable measure, and pins the composer to the bottom. The layout changes
 * presentation only — the transcript, the send path, the client message id, the
 * idempotent retry and every grounding disclosure are the same code in both.
 */

type Variant = "dark" | "light";
type Layout = "panel" | "surface";

/**
 * Starter questions for an empty thread. They FILL the composer — they never
 * send on the user's behalf, so nothing is asked that the user did not submit.
 */
const STARTER_QUESTIONS = [
  "What needs my attention on this project right now?",
  "Which risks and issues are open?",
  "What changed recently?",
];

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
 * The primary-surface rendering (light). Turns read as a conversation, not as
 * cards in a feed: the question in a quiet bubble, the answer as text at a
 * readable measure — with its claims, citations and notices exactly as in the
 * panel, so moving the conversation to the centre weakens none of its
 * disclosure.
 */
const SURFACE_STYLES = {
  user: "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-slate-100 px-4 py-2.5 text-[15px] leading-relaxed text-slate-900",
  assistant: "whitespace-pre-wrap px-1 text-[15px] leading-7 text-slate-800",
  // The composer itself carries the focus indication (border + ring), so the textarea
  // inside it does not draw a second, nested focus box.
  composer: "flex flex-col gap-1 rounded-2xl border border-slate-300 bg-white px-3 pt-2 shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition focus-within:border-cyan-600 focus-within:ring-2 focus-within:ring-cyan-500/25",
  input: "block max-h-[220px] min-h-[2.75rem] w-full resize-none bg-transparent px-1 py-1.5 text-[15px] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400",
  send: "flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300",
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
  /** `surface` is the full-centre primary rendering (CHAT-SHELL-01); `panel` the compact one. */
  layout?: Layout;
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

function ProjectThread({ projectId, projectName, variant = "dark", layout = "panel", onTranscriptSizeChange }: ConversationProps) {
  const styles = STYLES[variant];
  const surface = layout === "surface";
  const [messages, setMessages] = useState<ProjectBrainMessageView[]>([]);
  const [generativeAvailable, setGenerativeAvailable] = useState(true);
  const [limitedModeReason, setLimitedModeReason] = useState<"not_included" | "unavailable" | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ message: string; turn: OutgoingTurn } | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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

  // The composer grows with what is typed, up to a ceiling, so a long question is
  // readable without the input becoming its own scroll prison.
  useEffect(() => {
    const input = inputRef.current;
    if (!input || !surface) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }, [draft, surface]);

  // As the primary surface, the first obvious action is typing — so the composer
  // takes focus once the thread has loaded. Only with a fine pointer: on a phone,
  // focusing would throw the keyboard over the conversation unasked.
  useEffect(() => {
    if (!surface || loading) return;
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [surface, loading]);

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

  const applyStarter = (question: string) => {
    setDraft(question);
    inputRef.current?.focus();
  };

  const upgraded = new Set(
    messages.filter((m) => m.brain?.mode === "generative" && m.replyToMessageId).map((m) => m.replyToMessageId),
  );

  const transcript = loading ? (
    <p className={`text-sm ${styles.muted}`}>Loading this project&apos;s conversation…</p>
  ) : loadError ? (
    <p className={styles.error}>{loadError}</p>
  ) : messages.length === 0 ? (
    surface ? (
      <div className="flex flex-1 flex-col items-center justify-center py-10 text-center" data-testid="project-brain-empty">
        <p className={`text-xs font-medium uppercase tracking-[0.18em] ${styles.muted}`}>{projectName}</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Ask Project Brain about this project</h2>
        <p className={`mt-2 max-w-md text-sm ${styles.muted}`}>
          Type a question below. Project Brain answers from this project&apos;s records and this conversation.
        </p>
        <div className="mt-6 flex max-w-xl flex-wrap justify-center gap-2" data-testid="project-brain-starters">
          {STARTER_QUESTIONS.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() => applyStarter(question)}
              className="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
            >
              {question}
            </button>
          ))}
        </div>
      </div>
    ) : (
      <div className="space-y-1">
        <p className="text-sm font-semibold">Ask Project Brain about {projectName}.</p>
        <p className={`text-xs ${styles.muted}`}>For example: &ldquo;What is the current status of this project?&rdquo; or &ldquo;Which risks are open?&rdquo;</p>
      </div>
    )
  ) : (
    messages.map((message) =>
      message.role === "user" ? (
        <div key={message.id} className="flex justify-end">
          <div className={surface ? SURFACE_STYLES.user : styles.user} data-testid="project-brain-user-message">
            {message.content}
          </div>
        </div>
      ) : (
        <div
          key={message.id}
          className={surface ? SURFACE_STYLES.assistant : styles.assistant}
          data-testid="project-brain-assistant-message"
          data-mode={message.brain?.mode ?? "legacy"}
        >
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
  );

  const limitedModeNotice = !generativeAvailable ? (
    <p className={`mb-2 ${styles.notice}`} data-testid="project-brain-limited-mode">
      {limitedModeReason === "not_included"
        ? "Full generative Project Brain answers aren't included in your current plan. Answers list what this project's records show."
        : "Project Brain is temporarily operating in limited mode: answers list what this project's records show, without a full generative answer."}
    </p>
  ) : null;

  const disclosure = (
    <p className={`mt-2 px-1 text-[11px] ${styles.muted}`} data-testid="project-brain-disclosure">
      Project Brain writes its answers from this project&apos;s records and this conversation. Listed claims show which records they cite; a citation is not proof of every sentence. It cannot change the project.
    </p>
  );

  const input = (
    <>
      <label htmlFor={`project-brain-input-${projectId}`} className="sr-only">
        Ask Project Brain
      </label>
      <textarea
        ref={inputRef}
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
        placeholder={surface ? `Ask about ${projectName}…` : "Ask Project Brain…"}
        className={surface ? SURFACE_STYLES.input : styles.input}
        // The global `:focus-visible` outline is unlayered and would outrank the utility;
        // in the surface layout the composer's own focus ring is the indicator.
        style={surface ? { outline: "none" } : undefined}
        data-testid="project-brain-input"
      />
    </>
  );

  const status = (
    <>
      {sending ? <p className={`text-xs ${styles.muted}`} data-testid="project-brain-thinking">Project Brain is thinking…</p> : null}
      {sendError ? (
        <p className={styles.error}>
          {sendError.message}{" "}
          <button type="button" className={styles.link} onClick={() => void submit(sendError.turn)} disabled={sending}>
            Retry
          </button>
        </p>
      ) : null}
    </>
  );

  if (surface) {
    return (
      <div className={styles.frame} data-testid="project-brain-conversation" data-project-id={projectId} data-layout="surface">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="project-brain-transcript">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6" aria-live="polite">
            {transcript}
            {status}
          </div>
        </div>

        <div className="shrink-0 bg-white px-4 pb-4 pt-2 sm:px-6" data-testid="project-brain-composer">
          <div className="mx-auto w-full max-w-3xl">
            {limitedModeNotice}
            <form
              className={SURFACE_STYLES.composer}
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              {input}
              {/* The composer's action row. PB-CHAT-02's richer inputs belong on the
                  left of it when they ship; nothing is shown there until they do. */}
              <div className="flex items-center justify-between gap-3 px-1 pb-1">
                <span className="text-[11px] text-slate-400">Enter to send · Shift+Enter for a new line</span>
                <button type="submit" disabled={sending || !draft.trim()} className={SURFACE_STYLES.send}>
                  <span className="sr-only">Send</span>
                  <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
                    <path d="M8 13V3.5M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </form>
            {disclosure}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.frame} data-testid="project-brain-conversation" data-project-id={projectId} data-layout="panel">
      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
        {transcript}
        {status}
      </div>

      <div className={`border-t px-4 py-3 sm:px-5 ${styles.divider}`}>
        {limitedModeNotice}
        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          {input}
          <button type="submit" disabled={sending || !draft.trim()} className={styles.send}>
            Send
          </button>
        </form>
        {disclosure}
      </div>
    </div>
  );
}
