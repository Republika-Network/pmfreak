"use client";

import Link from "next/link";
import { useState } from "react";
import { LogoMark } from "@/components/brand/logo-mark";

const navLinks = [
  { label: "Product", href: "/#intelligence" },
  { label: "How it Works", href: "/#how-it-works" },
  { label: "Pricing", href: "/pricing" },
  { label: "Command Center", href: "/command-center" },
];

export function MarketingNavbar() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200/80 bg-[#fbfaf8]/92 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-4 px-5 py-3.5 md:px-8 lg:px-12">
        <Link href="/" className="flex items-center gap-3" aria-label="PMFreak home">
          <LogoMark size="navbar" priority />
        </Link>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Main">
          {navLinks.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="text-sm font-bold text-zinc-600 transition hover:text-zinc-950"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            href="/login"
            className="rounded-full px-4 py-2.5 text-sm font-bold text-zinc-700 transition hover:bg-white hover:text-zinc-950"
          >
            Sign In
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-zinc-950 px-5 py-2.5 text-sm font-bold text-white transition hover:-translate-y-0.5 hover:bg-zinc-800"
          >
            Start Free
          </Link>
        </div>

        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-950 md:hidden"
          aria-label="Toggle menu"
          aria-controls="mobile-main-menu"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((value) => !value)}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M5 8h14M5 12h14M5 16h14" />
          </svg>
        </button>
      </div>

      <div
        id="mobile-main-menu"
        className={`grid transition-all duration-300 md:hidden ${isOpen ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden border-t border-zinc-200 bg-[#fbfaf8] px-5">
          <div className="flex flex-col gap-1 py-4">
            {navLinks.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="rounded-xl px-3 py-3 text-base font-bold text-zinc-800 transition hover:bg-white"
                onClick={() => setIsOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-zinc-200 pt-4">
              <Link
                href="/login"
                className="rounded-full border border-zinc-200 bg-white px-4 py-3 text-center text-sm font-bold text-zinc-800"
                onClick={() => setIsOpen(false)}
              >
                Sign In
              </Link>
              <Link
                href="/signup"
                className="rounded-full bg-zinc-950 px-4 py-3 text-center text-sm font-bold text-white"
                onClick={() => setIsOpen(false)}
              >
                Start Free
              </Link>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
