"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
};

export type ContextChatScopeProps =
  | { contextType: "workspace" }
  | { contextType: "pmo"; pmoId: string }
  | { contextType: "project"; projectId: string };

type Props = ContextChatScopeProps & {
  title: string;
  subtitle: string;
  placeholder?: string;
  suggestions?: string[];
  /**
   * `card` is the framed panel; `surface` (CHAT-SHELL-01) renders the same
   * conversation as the page's primary surface — filling the shell's centre with
   * a readable measure and the composer pinned to the bottom. Presentation only:
   * the scope, the endpoint and every request are identical in both.
   */
  layout?: "card" | "surface";
};

function scopeParams(props: ContextChatScopeProps): URLSearchParams {
  const params = new URLSearchParams({ contextType: props.contextType });
  if (props.contextType === "pmo") params.set("pmoId", props.pmoId);
  if (props.contextType === "project") params.set("projectId", props.projectId);
  return params;
}

/**
 * Isolated chat surface for one context scope (workspace | pmo | project).
 * Every scope owns its own conversation and history — the panel never loads
 * or posts outside the scope it was mounted with.
 */
export function ContextChatPanel(props: Props) {
  const { title, subtitle, placeholder, suggestions, layout = "card" } = props;
  const surface = layout === "surface";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [contextId, setContextId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const scopeKey = `${props.contextType}:${props.contextType === "pmo" ? props.pmoId : props.contextType === "project" ? props.projectId : "root"}`;

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/context-chat?${scopeParams(props).toString()}`, { cache: "no-store" });
        const data = (await res.json()) as { messages?: ChatMessage[]; contextId?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? "Unable to load conversation.");
        if (active) {
          setMessages(data.messages ?? []);
          setContextId(data.contextId ?? "");
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Unable to load conversation.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
    // Reload whenever the scope identity changes — never reuse another scope's thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    setDraft("");
    try {
      const body: Record<string, string> = { contextType: props.contextType, message };
      if (props.contextType === "pmo") body.pmoId = props.pmoId;
      if (props.contextType === "project") body.projectId = props.projectId;

      const res = await fetch("/api/context-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { messages?: ChatMessage[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Unable to send message.");
      setMessages((prev) => [...prev, ...(data.messages ?? [])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send message.");
      setDraft(message);
    } finally {
      setSending(false);
    }
  }, [props, sending]);

  return (
    <section
      className={surface ? "flex h-full min-h-0 flex-col bg-white" : "flex h-full min-h-[28rem] flex-col rounded-3xl border border-slate-200 bg-white"}
      data-testid="context-chat-panel"
      data-layout={layout}
    >
      <header className={surface ? "sr-only" : "border-b border-slate-200 px-5 py-4"}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            <p className="mt-0.5 text-xs text-slate-600">{subtitle}</p>
          </div>
          {contextId ? (
            <span className="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-cyan-900" title="Isolated context — memory never crosses this boundary">
              Context {contextId}
            </span>
          ) : null}
        </div>
      </header>

      <div ref={scrollRef} className={surface ? "min-h-0 flex-1 overflow-y-auto" : "flex-1 overflow-y-auto px-5 py-4"}>
        <div className={surface ? "mx-auto w-full max-w-3xl space-y-4 px-4 py-6 sm:px-6" : "space-y-3"}>
        {loading ? (
          <p className="text-sm text-slate-600">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-800">Start your first conversation.</p>
            <p className="text-xs text-slate-500">This conversation is private to this {props.contextType}.</p>
            {suggestions && suggestions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 transition hover:border-cyan-300/40 hover:text-cyan-900"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl border px-3.5 py-2.5 text-sm leading-relaxed ${
                  message.role === "user"
                    ? "border-cyan-300/25 bg-cyan-400/10 text-cyan-950"
                    : "border-slate-200 bg-slate-50 text-slate-800"
                }`}
              >
                {message.content}
              </div>
            </div>
          ))
        )}
        {sending ? <p className="text-xs text-slate-500">Analyzing this context…</p> : null}
        {error ? <p className="text-xs text-rose-700">{error}</p> : null}
        </div>
      </div>

      <form
        className={surface ? "mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pb-5 pt-2 sm:px-6" : "flex items-end gap-2 border-t border-slate-200 px-5 py-4"}
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
          rows={2}
          placeholder={placeholder ?? "Ask about this context…"}
          className="block w-full resize-none rounded-xl border border-slate-200 bg-[#FCFBF9]/75 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/70"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="rounded-xl border border-cyan-200/45 bg-cyan-400/[0.1] px-4 py-2.5 text-sm font-semibold text-cyan-900 transition hover:bg-cyan-400/[0.16] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </section>
  );
}
