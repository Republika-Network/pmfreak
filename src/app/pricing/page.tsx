"use client";

import Link from "next/link";
import { Mascot, Sparkle } from "@/components/landing/doodles";
import { displayFont, markerFont } from "@/components/landing/fonts";
import { Arrow, secondaryOnDarkCtaClass } from "@/components/landing/hero-section";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNavbar } from "@/components/marketing-navbar";
import { PAID_PLANS, savePendingPlan, type PaidPlanTier } from "@/lib/billing-plans";

const plans: readonly {
  tier: PaidPlanTier | null;
  name: string;
  price: string;
  period: string | null;
  description: string;
  features: readonly string[];
}[] = [
  {
    tier: "pro",
    ...PAID_PLANS.pro,
    description: "For PMs who want clearer weekly priorities, better meeting prep, and faster follow-through.",
    features: ["Advanced AI actions", "Expanded upload + analysis limits", "Reporting exports"],
  },
  {
    tier: "pmo",
    ...PAID_PLANS.pmo,
    description: "For PMO and delivery teams who need shared visibility, aligned actions, and portfolio consistency.",
    features: ["Create PMO workspaces", "Invite team members", "PMO processes + directives"],
  },
  {
    tier: null,
    name: "Enterprise",
    price: "Custom",
    period: null,
    description: "For enterprise rollouts that need security review, procurement support, and guided onboarding.",
    features: ["Security + procurement support", "Tenant controls", "Guided rollout"],
  },
];

const salesHref = "mailto:sales@pmfreak.ai?subject=PMFreak%20Enterprise";

function Check({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full ${className}`}>
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    </span>
  );
}

export default function PricingPage() {
  return (
    <div className={`${displayFont.variable} ${markerFont.variable} pmf-brand flex min-h-screen flex-col bg-off-white`}>
      <MarketingNavbar brand="palette2026" />
      <main className="flex-1 text-charcoal">
        <section aria-labelledby="pricing-heading" className="pmf-on-dark relative isolate overflow-hidden bg-charcoal pb-36 pt-14 text-off-white md:pb-40 md:pt-20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_80%_at_85%_40%,rgba(20,184,166,0.18),transparent_70%),radial-gradient(35%_60%_at_8%_30%,rgba(255,138,0,0.08),transparent_70%)]"
          />
          <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 md:grid-cols-[1fr_auto] md:px-8">
            <div>
              <p className="font-marker -rotate-2 text-sm uppercase text-freak-orange md:text-base">PMFreak AI • Pricing</p>
              <h1 id="pricing-heading" className="font-display mt-4 max-w-3xl text-4xl font-extrabold leading-[1.02] tracking-[-0.02em] sm:text-5xl md:text-6xl">
                Choose the plan that fits <span className="text-mint">how you run projects.</span>
              </h1>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-off-white/80 md:text-lg">
                Start free, then upgrade when you need deeper support across teams.
              </p>
            </div>
            <div className="relative hidden md:block">
              <Mascot size={168} onDark className="h-40 w-40 rotate-3" />
              <Sparkle className="absolute -left-5 top-1 h-6 w-6 text-mint" />
            </div>
          </div>
        </section>

        <section aria-label="Plans" className="relative -mt-24 pb-16 md:pb-24">
          <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
            <div className="grid overflow-hidden rounded-xl border border-charcoal/10! bg-white shadow-[0_24px_60px_-28px_rgba(15,17,19,0.45)] lg:grid-cols-3">
              {plans.map((plan, index) => {
                const enterprise = plan.tier === null;
                return (
                  <article
                    key={plan.name}
                    aria-labelledby={`plan-${plan.name}`}
                    className={`flex flex-col p-7 md:p-9 ${
                      enterprise
                        ? "pmf-on-dark bg-charcoal text-off-white"
                        : `${index > 0 ? "border-t border-charcoal/10! lg:border-l lg:border-t-0" : ""}`
                    }`}
                  >
                    <div className={`h-1.5 w-12 rounded-full ${enterprise ? "bg-mint" : index === 0 ? "bg-calm-teal" : "bg-freak-orange"}`} aria-hidden />
                    <h2 id={`plan-${plan.name}`} className="font-display mt-5 text-2xl font-extrabold tracking-[-0.01em]">
                      {plan.name}
                    </h2>
                    <p className="mt-4 flex items-baseline gap-2">
                      <span className="font-display text-5xl font-extrabold tracking-[-0.03em]">{plan.price}</span>
                      {plan.period ? <span className="text-sm font-semibold text-charcoal/70">{plan.period}</span> : null}
                    </p>
                    <p className={`mt-4 text-sm leading-relaxed lg:min-h-[4.25rem] ${enterprise ? "text-off-white/80" : "text-charcoal/75"}`}>{plan.description}</p>

                    <ul className={`mt-6 space-y-3 border-t pt-6 text-sm font-medium ${enterprise ? "border-off-white/15!" : "border-charcoal/10!"}`}>
                      {plan.features.map((feature) => (
                        <li key={feature} className="flex items-start gap-3">
                          <Check className={enterprise ? "bg-mint text-charcoal" : "bg-calm-ink text-white"} />
                          {feature}
                        </li>
                      ))}
                    </ul>

                    <div className="mt-auto pt-8">
                      {plan.tier ? (
                        // Checkout runs on /billing, which has the workspace context the
                        // billing API requires. Signed-out visitors are sent through
                        // login first; the saved choice survives that detour.
                        <Link
                          href={`/billing?plan=${plan.tier}`}
                          onClick={() => savePendingPlan(window.localStorage, plan.tier as PaidPlanTier)}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-charcoal px-6 py-3 text-sm font-bold text-off-white transition hover:bg-charcoal/85"
                        >
                          Start {plan.name} <Arrow />
                        </Link>
                      ) : (
                        <a href={salesHref} className={`${secondaryOnDarkCtaClass} w-full justify-center`}>
                          Contact Sales
                        </a>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            <p className="mt-10 text-center text-sm text-charcoal/75">
              Not ready for a paid plan?{" "}
              <Link href="/signup" className="font-semibold text-calm-ink underline decoration-calm-ink/40 underline-offset-4 transition hover:text-charcoal">
                Create a free account
              </Link>
            </p>
            <p className="mt-3 text-center text-sm text-charcoal/75">
              Questions about a PMO or Enterprise rollout?{" "}
              <a href={salesHref} className="font-semibold text-calm-ink underline decoration-calm-ink/40 underline-offset-4 transition hover:text-charcoal">
                sales@pmfreak.ai
              </a>
            </p>
          </div>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
