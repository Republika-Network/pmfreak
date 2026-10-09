import Image from "next/image";
import Link from "next/link";

import { Burst, Mascot, Sparkle } from "./doodles";
import { HeroProductWindow } from "./product-window";

// Hero: the approved composition — a PM seen from behind, operational chaos on the
// left in orange/amber, calm execution on the right in teal/mint, with the seam
// running through the PM. Everything legible is real HTML: headline, CTAs, the
// mascot (canonical artwork) and the product window (real Command Center panel).
//
// UPSCALED ART: `hero-scene.webp` is the approved 1371px artwork, Lanczos-upscaled
// to 2640px with a feathered #0F1113 overlay (45%) over the copy zone, then installed
// by design/pmfreak-art-direction-pack/scripts/install-hero-plate.mjs. Upscaling adds
// no detail; replace it with native ≥2400px artwork per hero-plate-brief.md.
const HERO_PLATE = "/brand/landing/hero-scene.webp";

export const primaryCtaClass =
  "inline-flex items-center gap-2 rounded-full bg-mint px-6 py-3 text-sm font-bold text-charcoal shadow-[0_8px_24px_-8px_rgba(127,225,193,0.8)] transition hover:bg-calm-teal";
export const secondaryOnDarkCtaClass =
  "inline-flex items-center gap-2 rounded-full border border-off-white/40! px-6 py-3 text-sm font-bold text-off-white transition hover:border-off-white/80! hover:bg-off-white/5";

export function Arrow() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10h11M11 5l5 5-5 5" />
    </svg>
  );
}

export function HeroSection() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="pmf-on-dark relative isolate overflow-hidden bg-charcoal text-off-white"
    >
      {/* Calm light spilling from the right, behind the product window. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_70%_at_88%_55%,rgba(20,184,166,0.22),transparent_70%),radial-gradient(40%_60%_at_10%_40%,rgba(255,138,0,0.10),transparent_70%)]"
      />

      <div className="relative mx-auto flex w-full max-w-[1600px] flex-col xl:block xl:aspect-[1440/760]">
        {/* Copy: centred over the dark band of the scene on desktop, first on mobile. */}
        <div className="relative z-20 px-5 pt-12 text-center xl:absolute xl:left-[30%] xl:top-[2.5%] xl:w-[35%] xl:px-0 xl:pt-0">
          <h1
            id="hero-heading"
            className="font-display text-[2.9rem] font-extrabold leading-[0.95] tracking-[-0.02em] sm:text-6xl xl:text-[clamp(2.4rem,3.7vw,4.2rem)]"
          >
            <span className="block text-off-white">Freak out less.</span>
            <span className="relative mt-1 inline-block">
              <span className="text-freak-orange">Manage</span>{" "}
              <span className="text-mint">more.</span>
              <svg aria-hidden viewBox="0 0 300 14" preserveAspectRatio="none" className="absolute -bottom-2.5 left-[41%] h-3 w-[56%] text-mint">
                <path d="M3 10 C70 3 160 2 297 6" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </span>
          </h1>
          <p className="mt-5 text-lg font-semibold text-off-white md:text-xl xl:mt-3 xl:text-lg 2xl:text-xl">Project clarity for real humans.</p>
          <p className="mx-auto mt-2 max-w-[25rem] text-sm leading-relaxed text-off-white/75 md:text-base xl:text-sm 2xl:text-base">
            Turn scattered updates into one project memory: what changed, what
            needs you, and what to do next.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3 xl:mt-4">
            <Link href="/signup" className={primaryCtaClass}>
              Get started free <Arrow />
            </Link>
            <Link href="#how-it-works" className={secondaryOnDarkCtaClass}>
              See how it works
            </Link>
          </div>
        </div>

        {/* The scene: chaos, the PM, and the seam. */}
        {/* Phones show the lower right of the plate (the PM and the seam), zoomed in;
            desktop shows the whole plate. */}
        <div className="relative z-0 mt-8 aspect-[460/330] w-full overflow-hidden xl:absolute xl:bottom-0 xl:left-0 xl:mt-0 xl:aspect-[660/552] xl:w-[64%] md:aspect-[660/330] pmf-hero-plate">
          <Image
            src={HERO_PLATE}
            alt="A project manager, seen from behind at their desk. To the left, a wall of sticky notes: risks, delays, “where is this file?!”. To the right, the same desk in calm teal light."
            width={660}
            height={552}
            preload
            sizes="(min-width: 1280px) 64vw, (min-width: 768px) 100vw, 144vw"
            className="absolute bottom-0 right-0 h-auto w-[143.5%] max-w-none md:w-full"
          />
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-charcoal to-transparent xl:hidden" />
          <div aria-hidden className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-charcoal to-transparent xl:hidden" />
        </div>

        {/* Calm side: the mascot and the product, already in order. */}
        <div className="relative z-10 mx-auto w-full px-5 pb-14 pt-2 md:max-w-2xl xl:absolute xl:max-w-none xl:right-[2.5%] xl:top-[3%] xl:w-[31%] xl:p-0">
          <div className="relative flex items-end justify-end gap-3 pr-2 xl:h-[clamp(120px,13vw,190px)]">
            <p className="font-marker mb-6 max-w-[11rem] -rotate-6 text-right text-sm leading-tight text-mint xl:text-base">
              Same brain. Just more clarity.
            </p>
            <Sparkle className="absolute right-[34%] top-2 h-5 w-5 text-mint" />
            <Burst className="absolute -left-1 bottom-10 hidden h-8 w-8 -scale-x-100 text-warm-amber xl:block" />
            <Mascot
              onDark
              size={180}
              preload
              alt="The PMFreak mascot: one half freaked out, the other calm and in control"
              className="relative z-10 -mb-3 mr-2 h-28 w-28 shrink-0 rotate-6 xl:h-[clamp(120px,12vw,180px)] xl:w-[clamp(120px,12vw,180px)]"
            />
          </div>
          <HeroProductWindow />
        </div>
      </div>
    </section>
  );
}
