import { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

// 2026 palette form controls for the public auth surfaces. Border colours carry
// `!` because the global unlayered `* { border-color }` rule outranks utilities.
const controlClass =
  "w-full rounded-lg border-2 border-charcoal/25! bg-white px-4 py-3 text-base text-charcoal placeholder:text-charcoal/45 transition outline-none hover:border-charcoal/45! focus:border-calm-ink! focus:ring-4 focus:ring-calm-teal/20 sm:text-sm";

export function AuthInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${controlClass} ${props.className ?? ""}`} />;
}

export function AuthSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${controlClass} ${props.className ?? ""}`} />;
}

/** A labelled input: the visible label stays put, unlike a placeholder. */
export function AuthField({
  label,
  id,
  hint,
  ...inputProps
}: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; hint?: ReactNode }) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-charcoal">
        {label}
      </label>
      <AuthInput id={id} aria-describedby={hintId} {...inputProps} />
      {hint ? (
        <p id={hintId} className="mt-1.5 text-xs text-charcoal/65">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Inline form feedback. Errors are announced assertively, success politely. */
export function AuthNotice({ tone, children }: { tone: "error" | "success"; children: ReactNode }) {
  // Success text stays charcoal: calm-ink on the mint wash falls just under AA.
  const toneClass =
    tone === "error"
      ? "border-red-700/30! bg-red-50 text-red-800"
      : "border-calm-ink/30! bg-mint/20 text-charcoal";
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm font-medium ${toneClass}`}
    >
      <svg aria-hidden viewBox="0 0 20 20" className={`mt-0.5 h-4 w-4 flex-none ${tone === "success" ? "text-calm-ink" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {tone === "error" ? (
          <>
            <circle cx="10" cy="10" r="8" />
            <path d="M10 6v4.5M10 13.5h.01" />
          </>
        ) : (
          <path d="M4.5 10.5l3.5 3.5 7.5-8" />
        )}
      </svg>
      <span>{children}</span>
    </p>
  );
}
