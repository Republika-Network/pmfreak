"use client";

import Link from "next/link";
import { useState } from "react";
import { LogoLockupOnDark, LogoMark } from "@/components/brand/logo-mark";

const navLinks = [
  { label: "Product", href: "/#intelligence" },
  { label: "How it Works", href: "/#how-it-works" },
  { label: "Pricing", href: "/pricing" },
  { label: "Command Center", href: "/command-center" },
];

// brand="palette2026" opts a page into the 2026 palette (used by the landing).
// The default keeps the original styling for pages not yet migrated (pricing).
export function MarketingNavbar({ brand = "original" }: { brand?: "original" | "palette2026" } = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const v2 = brand === "palette2026";
  const headerClass = v2
    ? "pmf-on-dark sticky top-0 z-50 border-b border-off-white/10! bg-charcoal/95 backdrop-blur-xl"
    : "sticky top-0 z-50 border-b border-zinc-200 bg-white/80 shadow-[0_0_24px_rgba(236,72,153,0.22)] backdrop-blur-xl";
  const linkHover = v2 ? "hover:text-mint" : "hover:text-cyan-200";
  const textClass = v2 ? "text-off-white" : "text-zinc-900";
  const ctaClass = v2
    ? "inline-flex items-center rounded-full bg-mint px-5 py-2 text-base font-bold text-charcoal transition hover:bg-calm-teal"
    : "rounded-full border border-fuchsia-300/70 bg-gradient-to-r from-[#ff008c] to-white px-5 py-2 text-lg font-semibold text-slate-950 shadow-[0_0_24px_rgba(236,72,153,0.22)] hover:brightness-110";
  const mobileCtaClass = v2
    ? "rounded-full bg-mint px-4 py-2.5 text-center text-lg font-bold text-charcoal"
    : "rounded-full bg-gradient-to-r from-[#ff008c] to-white px-4 py-2.5 text-center text-lg font-semibold text-slate-950";

  return (
    <header className={headerClass}>
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 py-3 md:px-8">
        <div className="flex items-center gap-3">
          {v2 ? <LogoLockupOnDark preload /> : <LogoMark size="navbar" priority />}
        </div>

        <nav className="hidden items-center gap-10 md:flex" aria-label="Main">
          {navLinks.map((link) => (
            <Link key={link.label} href={link.href} className={`${v2 ? "text-base" : "text-lg"} font-semibold ${textClass} transition ${linkHover}`}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link href="/login" className={v2 ? "rounded-full border border-transparent px-4 py-2 text-base font-semibold text-off-white transition hover:border-mint/50!" : "rounded-full border border-transparent px-4 py-2 text-lg font-semibold text-zinc-900 transition hover:border-cyan-300/50 hover:text-cyan-700"}>
            <span className={v2 ? "font-semibold" : "font-semibold text-zinc-900"}>Sign In</span>
          </Link>
          <Link href="/signup" className={ctaClass}>
            Get Started
          </Link>
        </div>

        <button type="button" className={`mr-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl md:hidden ${v2 ? "text-off-white" : "text-black"}`} aria-label="Toggle menu" aria-controls="mobile-main-menu" aria-expanded={isOpen} onClick={() => setIsOpen((v) => !v)}>
          <svg viewBox="0 0 24 24" className="h-8 w-8 stroke-[3]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>

      <div id="mobile-main-menu" className={`grid transition-all duration-300 md:hidden ${isOpen ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"}`}>
        <div className={`overflow-hidden px-4 pb-4 ${v2 ? "border-t border-off-white/10! bg-charcoal" : "border-t border-zinc-200 bg-white/95"}`}>
          <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-zinc-200/80 bg-white/90 p-3 backdrop-blur-xl">
            {navLinks.map((link) => (
              <Link key={link.label} href={link.href} className="rounded-lg px-3 py-2 text-lg font-medium text-zinc-900 transition hover:bg-zinc-100" onClick={() => setIsOpen(false)}>
                {link.label}
              </Link>
            ))}
            <Link href="/login" className="rounded-lg border border-zinc-200 px-3 py-2.5 text-center text-lg font-semibold text-zinc-900" onClick={() => setIsOpen(false)}>
              <span className="font-semibold text-zinc-900">Sign In</span>
            </Link>
            <Link href="/signup" className={mobileCtaClass} onClick={() => setIsOpen(false)}>
              Get Started
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
