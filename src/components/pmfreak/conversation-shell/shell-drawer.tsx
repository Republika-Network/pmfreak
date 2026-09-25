"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { anotherModalOwnsKeyboard, isPresented } from "./modal-stack";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal side sheet for the conversation shell's small-screen surfaces: the
 * navigator on the left, the operational tools on the right.
 *
 * It behaves as a dialog because it is one: while open it traps Tab inside
 * itself, Escape and the scrim close it, and focus returns to whatever opened it.
 * While closed it is unmounted from the accessibility tree (`hidden`), so a
 * screen reader never walks into an off-screen panel.
 *
 * `className` scopes WHERE it is modal — e.g. `lg:hidden` for the navigator,
 * which is a permanent column from `lg` up and only needs a sheet below it.
 *
 * `dismissWhen` (CHAT-SHELL-01 F3) is the media query at which the sheet stops being
 * needed. CSS alone would only HIDE an open sheet when, say, a tablet rotates into the
 * desktop layout — leaving its document-level Tab/Escape trap active over content no
 * one can see. Crossing that breakpoint therefore CLOSES the sheet, and the key handler
 * independently refuses to act for a sheet that is not presented.
 */
export function ShellDrawer({
  open,
  onClose,
  side,
  label,
  className = "",
  widthClass = "w-[19rem] max-w-[88vw]",
  dismissWhen,
  focusFallback,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side: "left" | "right";
  label: string;
  className?: string;
  widthClass?: string;
  /** Media query at which the sheet is no longer modal content and must close (e.g. the permanent-nav breakpoint). */
  dismissWhen?: string;
  /**
   * Where focus goes on close when the opener is no longer presented — e.g. after a
   * breakpoint dismissal hid the ☰ button. Without it, focus would stay parked where the
   * now-hidden sheet was, and a keyboard user would lose their place in the page.
   */
  focusFallback?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => {
      const opener = returnFocus.current;
      if (opener && opener.isConnected && isPresented(opener)) opener.focus();
      else focusFallback?.()?.focus();
    };
    // `focusFallback` is read at close time; re-running this effect for a new callback
    // identity would re-take focus while the sheet is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !dismissWhen || typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(dismissWhen);
    if (query.matches) {
      queueMicrotask(onClose);
      return;
    }
    const onChange = () => {
      if (query.matches) onClose();
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [open, dismissWhen, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // A sheet nobody can see owns no keys, and a dialog stacked on top of it owns them first.
      if (!panel.current || !isPresented(panel.current)) return;
      if (anotherModalOwnsKeyboard(panel.current)) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
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
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"} ${className}`} hidden={!open} data-testid={`shell-drawer-${side}`}>
      <div aria-hidden onClick={onClose} className="absolute inset-0 bg-slate-900/25 backdrop-blur-[1px]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`absolute top-0 flex h-full flex-col bg-[#F6F5F1] shadow-2xl outline-none ${widthClass} ${side === "left" ? "left-0 border-r" : "right-0 border-l"} border-slate-200`}
      >
        {children}
      </div>
    </div>
  );
}
