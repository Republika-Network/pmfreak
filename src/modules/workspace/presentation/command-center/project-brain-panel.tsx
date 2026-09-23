"use client";

import { useId, type ReactNode } from "react";

/**
 * Project Brain — the project's one persisted conversation, hosted in the Command Center.
 *
 * PB-CHAT-01 replaced the deterministic "Ask PMFreak" feed with the Project Brain
 * conversation and made it first-class: the screen opens it by default. Collapsing is
 * still offered, and it is still PRESENTATION ONLY:
 *
 *   - the transcript is persisted server-side (context_messages), so no client state
 *     is its source of truth;
 *   - the unsent draft is the conversation component's own local state, and local state
 *     only survives while the component stays mounted. So the conversation is ALWAYS
 *     mounted and collapsing only hides it. `hidden` is the whole mechanism: React keeps
 *     the subtree while the browser gives the region `display: none`, which takes it out
 *     of the layout, the tab order and the accessibility tree. An earlier cut rendered
 *     `{open ? children : null}`, which unmounted the composer and silently threw the
 *     draft away. The wrapper carries no display utility class, since one would override
 *     the `hidden` attribute's own `display: none`.
 */
export function ProjectBrainPanel({
  open,
  onToggle,
  messageCount,
  children,
}: {
  open: boolean;
  onToggle: (next: boolean) => void;
  /** Persisted messages in this project's thread, so a collapsed panel can say what it holds. */
  messageCount: number;
  /** The Project Brain conversation, mounted in both states. */
  children: ReactNode;
}) {
  const headingId = useId();
  const regionId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="cc-section-project-brain">
      <div className="flex items-center justify-between gap-2 px-1">
        <div>
          <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
            Project Brain
          </h2>
          <p className="text-xs text-zinc-500">Ask about this project</p>
        </div>
        {open && (
          <button
            type="button"
            onClick={() => onToggle(false)}
            className="rounded-lg px-2 py-1 text-[11px] text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
          >
            Collapse
          </button>
        )}
      </div>

      {!open && (
        <button
          type="button"
          onClick={() => onToggle(true)}
          aria-expanded={false}
          aria-controls={regionId}
          data-testid="cc-project-brain-open"
          className="mt-2 flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-white/20 hover:bg-white/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
        >
          <span className="truncate text-sm text-zinc-400">Ask Project Brain about this project...</span>
          {messageCount > 0 && (
            <span className="shrink-0 text-[11px] text-zinc-500">
              {messageCount} message{messageCount === 1 ? "" : "s"}
            </span>
          )}
        </button>
      )}

      {/* Always mounted, never conditionally rendered: an unsent draft is component state,
          and unmounting is what destroys it. */}
      <div
        id={regionId}
        hidden={!open}
        data-testid="cc-project-brain-region"
        className="mt-2 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]"
      >
        <div className="h-[520px] max-h-[70vh]">{children}</div>
      </div>
    </section>
  );
}
