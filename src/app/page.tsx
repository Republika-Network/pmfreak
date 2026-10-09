import type { Metadata } from "next";
import Link from "next/link";

import {
  Burst,
  DecisionDoodle,
  LinkDoodle,
  Mascot,
  PaperDoodle,
  QuestionMark,
  RiskDoodle,
  Sparkle,
  SquiggleArrow,
  TaskDoodle,
} from "@/components/landing/doodles";
import { displayFont, markerFont } from "@/components/landing/fonts";
import { Arrow, HeroSection, primaryCtaClass } from "@/components/landing/hero-section";
import { ShowcaseProductWindow } from "@/components/landing/product-window";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNavbar } from "@/components/marketing-navbar";

export const metadata: Metadata = {
  description:
    "Freak out less. Manage more. PMFreak turns scattered project updates into one project memory: what changed, what needs you, and what to do next.",
};

// Every point is something the product does today (see the Command Center's
// Needs you / What changed panels and the governed decision path).
const clarityPoints = [
  "Keep decisions, risks and evidence in one project memory",
  "See what changed, in plain language",
  "Spot risks before they become escalations",
  "Know which decisions are waiting on you, and why",
] as const;

const benefits = [
  {
    Doodle: TaskDoodle,
    title: "Know what needs you",
    text: "Decisions and reviews waiting on you, each with why it matters.",
    tone: "text-calm-ink",
  },
  {
    Doodle: RiskDoodle,
    title: "Risks before they bite",
    text: "Scope, schedule and budget risks surfaced from your own project evidence.",
    tone: "text-freak-ink",
  },
  {
    Doodle: LinkDoodle,
    title: "Context that stays put",
    text: "Notes, emails and documents kept in one project memory.",
    tone: "text-calm-ink",
  },
  {
    Doodle: DecisionDoodle,
    title: "Decisions stay human",
    text: "PMFreak recommends. Someone with the authority decides, and it’s on record.",
    tone: "text-freak-ink",
  },
] as const;

const sectionShell = "mx-auto w-full max-w-6xl px-5 md:px-8";

/** A loose marker-brush swash used behind callouts. */
function BrushSwash({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 400 200" preserveAspectRatio="none" className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}>
      <path
        fill="currentColor"
        d="M14 34 C60 10 150 22 230 12 C300 4 360 8 392 26 C398 70 388 120 396 168 C330 192 250 182 170 190 C100 196 40 188 8 176 C2 130 12 86 4 52 Z"
      />
    </svg>
  );
}

function ChaosToClaritySection() {
  return (
    <section aria-labelledby="clarity-heading" className="relative overflow-hidden bg-off-white py-16 md:py-24">
      <span id="intelligence" className="absolute -top-24" aria-hidden />
      <div className={`${sectionShell} grid items-center gap-12 lg:grid-cols-[1fr_1.15fr_0.95fr] lg:gap-8`}>
        <div>
          <h2 id="clarity-heading" className="font-display text-4xl font-extrabold leading-[1.02] tracking-[-0.02em] text-charcoal md:text-5xl">
            From <span className="text-freak-ink">chaos</span>
            <br />
            to <span className="text-calm-ink">clarity.</span>
          </h2>
          <p className="mt-5 max-w-sm text-base leading-relaxed text-charcoal/80">
            PMFreak keeps every moving part of a project in one memory &mdash; so you
            can stop reconstructing what happened and move the work forward.
          </p>
          <ul className="mt-6 space-y-3">
            {clarityPoints.map((point) => (
              <li key={point} className="flex items-start gap-3 text-sm font-medium text-charcoal/90">
                <span aria-hidden className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-freak-orange text-charcoal">
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>

        {/* The mascot carries the emotion: freaked debris on the left, calm marks on the right. */}
        <div className="relative mx-auto aspect-square w-full max-w-[420px]">
          <QuestionMark className="absolute left-[4%] top-[12%] h-12 w-9 -rotate-12 text-freak-orange" />
          <PaperDoodle className="absolute left-[16%] top-[0%] h-14 w-14 -rotate-12 text-charcoal" />
          <Burst className="absolute left-[2%] top-[42%] h-10 w-10 text-freak-orange" />
          <PaperDoodle className="absolute bottom-[22%] left-[0%] h-12 w-12 rotate-[18deg] text-charcoal" />
          <QuestionMark className="absolute bottom-[6%] left-[30%] h-9 w-7 rotate-12 text-freak-orange" />
          <Sparkle className="absolute right-[10%] top-[6%] h-8 w-8 text-calm-teal" />
          <TaskDoodle className="absolute right-[0%] top-[30%] h-16 w-16 rotate-6 text-calm-teal" />
          <Sparkle className="absolute bottom-[26%] right-[6%] h-6 w-6 text-calm-teal" />
          <PaperDoodle className="absolute bottom-[8%] right-[14%] h-12 w-12 -rotate-6 text-calm-ink" />
          <Mascot size={420} className="absolute inset-[14%]" />
          <p className="font-marker absolute -bottom-2 left-[2%] -rotate-6 text-sm uppercase leading-tight text-charcoal md:text-base">
            <SquiggleArrow className="mb-1 h-8 w-14 -scale-y-100 text-charcoal" />
            Less chaos.
            <br />
            More impact.
          </p>
        </div>

        <figure className="relative mx-auto max-w-sm px-8 py-10 text-charcoal">
          <BrushSwash className="text-mint/45" />
          <blockquote className="relative">
            <p className="font-display text-xl font-bold leading-snug md:text-2xl">
              &ldquo;Every PM has freaked out over status, risks, deadlines &mdash; and
              being handed one more project.&rdquo;
            </p>
          </blockquote>
          <figcaption className="relative mt-4 text-sm font-semibold text-charcoal/75">
            Why it&rsquo;s called PMFreak. The name comes from that feeling; the product
            is how you get past it.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function ProductShowcaseSection() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="showcase-heading"
      className="pmf-on-dark relative scroll-mt-20 overflow-hidden bg-charcoal py-16 text-off-white md:py-24"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_75%_50%,rgba(20,184,166,0.16),transparent_70%)]"
      />
      <div className={`${sectionShell} relative grid items-center gap-12 lg:grid-cols-[0.72fr_1.5fr]`}>
        <div>
          <p className="font-marker -rotate-2 text-sm uppercase leading-snug text-freak-orange md:text-base">
            A single place for everything that matters
          </p>
          <h2 id="showcase-heading" className="font-display mt-4 text-4xl font-extrabold leading-[1.02] tracking-[-0.02em] md:text-5xl">
            Less juggling.
            <br />
            <span className="text-mint">More progress.</span>
          </h2>
          <p className="mt-5 max-w-sm text-base leading-relaxed text-off-white/80">
            Open a project and PMFreak answers the first questions a PM asks: what needs
            me, and what changed &mdash; each one backed by your own project evidence.
          </p>
          <div className="mt-8">
            <Link href="/command-center" className={primaryCtaClass}>
              Open Command Center <Arrow />
            </Link>
          </div>
        </div>

        <figure>
          <ShowcaseProductWindow />
          <figcaption className="mt-3 text-xs text-off-white/60">
            The real Command Center panels, shown with a sample project. Names and items are illustrative.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function BenefitsSection() {
  return (
    <section id="security" aria-labelledby="benefits-heading" className="scroll-mt-20 bg-off-white py-16 md:py-20">
      <div className={sectionShell}>
        <h2 id="benefits-heading" className="sr-only">
          What PMFreak does for you
        </h2>
        <ul className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-0">
          {benefits.map(({ Doodle, title, text, tone }, index) => (
            <li
              key={title}
              className={`relative px-2 text-center lg:px-7 ${index > 0 ? "lg:border-l lg:border-charcoal/15!" : ""}`}
            >
              <div className="relative mx-auto h-14 w-14">
                <Doodle className={`h-14 w-14 ${tone}`} />
                <Burst className={`absolute -right-6 -top-3 h-6 w-6 ${index % 2 ? "text-freak-orange" : "text-calm-teal"}`} />
              </div>
              <h3 className="font-display mt-4 text-xl font-bold text-charcoal">{title}</h3>
              <p className="mx-auto mt-2 max-w-[16rem] text-sm leading-relaxed text-charcoal/75">{text}</p>
            </li>
          ))}
        </ul>
        <p className="mx-auto mt-12 max-w-2xl text-center text-xs leading-relaxed text-charcoal/65">
          Built on Soberanía Protocol &mdash; the governance foundation behind how
          project knowledge, AI-assisted actions, decisions and audit-ready records are managed.
        </p>
      </div>
    </section>
  );
}

function FinalCtaSection() {
  return (
    <section aria-labelledby="final-cta-heading" className="bg-off-white px-3 pb-16 md:pb-20">
      <div className="relative mx-auto max-w-6xl">
        <BrushSwash className="text-mint" />
        <div className="relative grid items-center gap-6 px-6 py-12 text-center md:grid-cols-[auto_1fr_auto] md:px-12 md:text-left">
          <Mascot size={160} className="mx-auto h-28 w-28 -rotate-6 md:h-36 md:w-36" />
          <div className="md:text-center">
            <h2 id="final-cta-heading" className="font-display text-3xl font-extrabold tracking-[-0.02em] text-charcoal md:text-4xl">
              Your projects don&rsquo;t have to be chaotic.
            </h2>
            <p className="mt-2 text-sm font-medium text-charcoal/80 md:text-base">
              Create a free account and bring in your first project.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 rounded-full bg-charcoal px-6 py-3 text-sm font-bold text-off-white transition hover:bg-charcoal/85"
              >
                Get started free <Arrow />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-full border-2 border-charcoal! px-6 py-2.5 text-sm font-bold text-charcoal transition hover:bg-charcoal/5"
              >
                Sign in
              </Link>
            </div>
          </div>
          <p className="font-marker hidden -rotate-6 text-base uppercase leading-tight text-charcoal md:block">
            Same human.
            <br />
            More progress.
            <Sparkle className="ml-auto mt-2 h-6 w-6 text-calm-ink" />
          </p>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <div className={`${displayFont.variable} ${markerFont.variable} pmf-landing flex min-h-screen flex-col bg-charcoal`}>
      <MarketingNavbar brand="palette2026" />

      <main className="text-charcoal">
        <HeroSection />
        <ChaosToClaritySection />
        <ProductShowcaseSection />
        <BenefitsSection />
        <FinalCtaSection />
      </main>

      <MarketingFooter onHomepage />
    </div>
  );
}
