import Image from "next/image";
import Link from "next/link";
import { ReactNode } from "react";

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
      <aside className="pmf-on-dark relative isolate overflow-hidden bg-charcoal px-5 py-5 text-off-white sm:px-8 lg:flex lg:flex-col lg:justify-center lg:px-12 lg:py-10">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(70%_55%_at_30%_70%,rgba(20,184,166,0.20),transparent_70%)]"
        />
        {/* One brand mark per page: the face with the wordmark beside it (no corner lockup).
            It stays the link home, which the auth pages otherwise lack. */}
        <Link href="/" aria-label="PMFreak home" className="relative mx-auto flex w-fit items-center gap-3 lg:mx-0 lg:gap-4 xl:gap-5">
          <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-off-white p-1.5 ring-2 ring-mint/60 lg:hidden">
            <Image src="/brand/palette-2026/pmfreak-face-trimmed.png" alt="" width={112} height={102} preload className="h-full w-full object-contain" />
          </span>
          <span className="hidden shrink-0 lg:block">
            <Mascot size={176} onDark className="h-28 w-28 xl:h-40 xl:w-40 2xl:h-44 2xl:w-44" />
          </span>
          <span className="flex flex-col items-start">
            <Image
              src="/brand/palette-2026/pmfreak-lettering-trimmed.png"
              alt="PMFreak"
              width={711}
              height={196}
              preload
              className="h-10 w-auto lg:h-12 xl:h-16 2xl:h-[4.5rem]"
            />
            <span className="font-marker mt-3 hidden -rotate-3 text-sm leading-tight text-mint lg:block xl:text-base">
              Same brain.
              <br />
              Just more clarity.
            </span>
          </span>
          <Sparkle className="absolute -right-5 -top-2 hidden h-6 w-6 text-mint lg:block" />
        </Link>

        <div className="hidden lg:block">
          <p className="font-display mt-12 text-4xl font-extrabold leading-[1.02] tracking-[-0.02em] xl:text-5xl">
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

        <p className="absolute bottom-10 left-12 hidden text-xs text-off-white/60 lg:block">
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
