"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { OPERATIONAL_INSPECTOR_ID, ToolIcon } from "./operational-rail";
import { PROJECT_TOOLS, projectToolDefinition, type ProjectToolKey } from "./operational-tools";

const OVERLAY_QUERY = "(max-width: 1279px)";
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The inspector: supporting context beside the conversation, never instead of it.
 *
 * ONE element at every width, so the tool inside it mounts once:
 *
 *   ≥ 1280px  an inline column (≈380px) beside the centre. The conversation keeps
 *             the rest of the row and stays fully usable.
 *   < 1280px  the same element becomes a right-hand sheet over the page, with a
 *             scrim, a focus trap, Escape to close and focus returned to the
 *             opener — a dialog, because at that width it is one.
 *
 * Its body scrolls on its own, so opening a long tool never scrolls the
 * conversation. Closing it unmounts the tool (and stops its reads); the
 * conversation beside it is a sibling and is never touched.
 */
export function OperationalInspector({
  tool,
  onSelect,
  onClose,
  children,
}: {
  tool: ProjectToolKey | null;
  onSelect: (tool: ProjectToolKey) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const open = tool !== null;
  const panel = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [overlay, setOverlay] = useState(false);

  useEffect(() => {
    const query = window.matchMedia?.(OVERLAY_QUERY);
    if (!query) return;
    const update = () => setOverlay(query.matches);
    queueMicrotask(update);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // As an overlay it is modal: take focus in, trap Tab, close on Escape, and hand
  // focus back to whatever opened it.
  useEffect(() => {
    if (!open || !overlay) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current)?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        // A detail drawer opened from a tool handles its own Escape first.
        if (document.querySelector('[data-testid="cc-detail-drawer"][aria-hidden="false"]')) return;
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocus.current?.focus?.();
    };
  }, [open, overlay, onClose]);

  const definition = tool ? projectToolDefinition(tool) : null;

  return (
    <>
      {open ? <div aria-hidden onClick={onClose} className="fixed inset-0 z-30 bg-slate-900/20 xl:hidden" data-testid="operational-inspector-scrim" /> : null}
      <aside
        ref={panel}
        id={OPERATIONAL_INSPECTOR_ID}
        hidden={!open}
        aria-label={definition ? `${definition.label} — project tool` : "Project tools"}
        role={overlay ? "dialog" : "complementary"}
        aria-modal={overlay ? true : undefined}
        tabIndex={-1}
        data-testid="operational-inspector"
        data-tool={tool ?? undefined}
        className="fixed inset-y-0 right-0 z-40 flex w-[400px] max-w-[92vw] flex-col border-l border-slate-200 bg-white shadow-2xl outline-none xl:static xl:z-auto xl:w-[380px] xl:max-w-none xl:shrink-0 xl:shadow-none"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              {tool ? <ToolIcon tool={tool} className="h-4 w-4 text-cyan-700" /> : null}
              {definition?.label}
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">{definition?.description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close project tool"
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Whenever the inspector is a sheet (below `xl`) it covers the rail — or there is
            no rail at all below `md` — so the tools are switched from inside it. */}
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-slate-200 px-3 py-2 xl:hidden" role="group" aria-label="Switch project tool">
          {PROJECT_TOOLS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => onSelect(entry.key)}
              aria-pressed={entry.key === tool}
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                entry.key === tool ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:text-slate-900"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="operational-inspector-body">
          {children}
        </div>
      </aside>
    </>
  );
}
