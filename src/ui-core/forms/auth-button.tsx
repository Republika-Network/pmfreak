import { ButtonHTMLAttributes } from "react";

// Primary action on the light auth panel: charcoal for maximum contrast (mint is
// reserved for CTAs on dark surfaces, where it passes AA).
export const authButtonClass =
  "inline-flex w-full items-center justify-center gap-2 rounded-full bg-charcoal px-6 py-3 text-sm font-bold text-off-white transition hover:bg-charcoal/85 disabled:cursor-not-allowed disabled:opacity-60";

export function AuthButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`${authButtonClass} ${props.className ?? ""}`} />;
}

/** Inline text links inside auth forms (calm-ink passes AA on off-white). */
export const authLinkClass =
  "font-semibold text-calm-ink underline decoration-calm-ink/40 underline-offset-4 transition hover:text-charcoal hover:decoration-charcoal";
