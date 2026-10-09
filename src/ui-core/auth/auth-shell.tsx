import { ReactNode } from "react";

import { LogoLockupOnDark } from "@/components/brand/logo-mark";
import { Mascot, Sparkle } from "@/components/landing/doodles";
import { displayFont, markerFont } from "@/components/landing/fonts";

// The calm side of the 2026 brand: the landing's charcoal + mint, without its
// chaos. Every point is something the product does today (mirrors the landing).
const calmPoints = [
  "See what changed, in plain language",
  "Know which decisions are waiting on you",
  "Keep decisions, risks and evidence in one project memory",
] as const;

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main
      className={`${displayFont.variable} ${markerFont.variable} pmf-brand grid min-h-screen grid-rows-[auto_1fr] bg-off-white text-charcoal lg:grid-rows-none lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]`}
    >
      <aside className="pmf-on-dark relative isolate overflow-hidden bg-charcoal px-5 py-4 text-off-white sm:px-8 lg:flex lg:flex-col lg:justify-between lg:px-12 lg:py-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(70%_55%_at_30%_70%,rgba(20,184,166,0.20),transparent_70%)]"
        />
        <LogoLockupOnDark />

        <div className="hidden lg:block">
          <div className="relative w-fit">
            <Mascot size={176} onDark className="h-44 w-44" />
            <Sparkle className="absolute -right-6 top-2 h-6 w-6 text-mint" />
            <p className="font-marker absolute -right-36 bottom-4 max-w-[9rem] -rotate-6 text-sm leading-tight text-mint">
              Same brain. Just more clarity.
            </p>
          </div>
          <p className="font-display mt-10 text-4xl font-extrabold leading-[1.02] tracking-[-0.02em] xl:text-5xl">
            Freak out less.
            <br />
            <span className="text-mint">Manage more.</span>
          </p>
          <ul className="mt-8 space-y-3">
            {calmPoints.map((point) => (
              <li key={point} className="flex items-start gap-3 text-sm font-medium text-off-white/85">
                <span aria-hidden className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-mint text-charcoal">
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>

        <p className="hidden text-xs text-off-white/60 lg:block">
          Project clarity for real humans.
        </p>
      </aside>

      <section className="flex items-start justify-center px-5 py-10 sm:px-8 sm:py-16 lg:items-center lg:py-12">
        <div className="w-full max-w-md">
          <h1 className="font-display text-3xl font-extrabold leading-tight tracking-[-0.02em] text-charcoal sm:text-4xl">
            {title}
          </h1>
          <p className="mt-2 text-base text-charcoal/75">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </section>
    </main>
  );
}
