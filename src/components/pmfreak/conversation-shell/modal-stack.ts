/**
 * CHAT-SHELL-01 — who owns the keyboard when modal surfaces are stacked.
 *
 * The shell's sheets (the navigator drawer, the tool inspector below `xl`) are modal and
 * listen on `document` for Escape and Tab. So do the dialogs a tool can open on top of
 * them (the Tasks tool's `Modal` and `Drawer`, the Command Center's detail drawer). All
 * of those listeners fire for the same keystroke, and the sheet registered FIRST — so
 * without a rule, one Escape closed the sheet (unmounting the dialog with it) and two Tab
 * traps fought over focus.
 *
 * The rule is generic rather than a list of known children: a shell sheet owns the
 * keyboard only while no OTHER open modal dialog exists that is not the sheet itself or
 * one of its ancestors. The topmost dialog handles the key; the sheet waits.
 */

/** Is this element actually presented — rendered, not `hidden`, not inside an `aria-hidden` subtree? */
export function isPresented(element: Element): boolean {
  if (element.closest("[hidden]")) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  return element.getClientRects().length > 0;
}

/**
 * True when some other open modal dialog should receive keyboard handling instead of
 * `owner`: any presented `[aria-modal="true"]` element that is neither `owner` nor an
 * ancestor of it (a dialog nested INSIDE the owner counts — it is on top).
 */
export function anotherModalOwnsKeyboard(owner: Element | null): boolean {
  if (typeof document === "undefined") return false;
  for (const dialog of Array.from(document.querySelectorAll('[aria-modal="true"]'))) {
    if (dialog === owner) continue;
    if (owner && dialog.contains(owner)) continue;
    if (isPresented(dialog)) return true;
  }
  return false;
}
