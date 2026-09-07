"use client";

import { useId, type ReactNode } from "react";

/**
 * "Ask PMFreak" — chat as the copilot layer, not the canvas.
 *
 * Nothing about the conversation itself changes here: the same `CommandFeed`, the same
 * deterministic gateway, the same message list. What changes is prominence. The Command
 * Center opens on what needs the PM's attention; the conversation waits one click away at
 * the bottom of the same page.
 *
 * Conversation state lives in the screen above this component, so collapsing the surface
 * hides the transcript, it never discards it — the collapsed control says how much is
 * there, and reopening shows the same messages.
 *
 * The composer's DRAFT, however, is `CommandFeed`'s own local state, and local state only
 * survives while the component stays mounted. The first cut of this panel rendered
 * `{open ? children : null}`, which unmounted the feed on collapse and silently threw away
 * whatever the PM had typed but not sent. Reopening gave them an empty box.
 *
 * So the conversation is ALWAYS mounted and collapsing only hides it. `hidden` is the whole
 * mechanism: React keeps the subtree — same type, same position, same state — while the
 * browser gives the region `display: none`, which takes it out of the layout, out of the
 * tab order and out of the accessibility tree. That last part matters as much as the draft:
 * a merely transparent or off-screen composer would still be focusable, and a keyboard user
 * would tab into a control nobody can see. The wrapper deliberately carries no display
 * utility class, since one would override the `hidden` attribute's own `display: none`.
 */
export function AskPmfreakPanel({
  open,
  onToggle,
  messageCount,
  children,
}: {
  open: boolean;
  onToggle: (next: boolean) => void;
  /** Messages currently in the conversation, so a collapsed panel can say what it holds. */
  messageCount: number;
  /** The real conversation surface, rendered only while expanded. */
  children: ReactNode;
}) {
  const headingId = useId();
  const regionId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="cc-section-ask-pmfreak">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id={headingId} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          Ask PMFreak
        </h2>
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
          data-testid="cc-ask-pmfreak-open"
          className="mt-2 flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-white/20 hover:bg-white/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40"
        >
          <span className="truncate text-sm text-zinc-500">Ask PMFreak about this project...</span>
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
        data-testid="cc-ask-pmfreak-region"
        className="mt-2 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]"
      >
        <div className="h-[420px] max-h-[60vh]">{children}</div>
      </div>
    </section>
  );
}
