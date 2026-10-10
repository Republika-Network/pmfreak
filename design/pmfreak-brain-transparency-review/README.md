# PMFreak — brain illustration transparency fix (review captures)

`public/Brain-Transparente.png` had its white fill keyed out in the side lobes, brain stem and
lower structures (alpha 0 over black RGB), so on the charcoal hero they read as dark patches.

The asset was rebuilt from the same artwork (same 1024×1024 canvas, no layout or code change):

1. Composite the existing PNG over white to recover the illustration as drawn.
2. Flood-fill light pixels from the image border; only that region (outside the brain
   silhouette) becomes transparent. Enclosed white areas inside the outline stay opaque white.
3. A 2px outer edge band is unmatted against white (black ink, alpha from darkness), so the
   outline keeps its anti-aliasing with no white or black halo.

Pixel audit (old → new): transparent pixels enclosed by the outline 69,470 → 10 (anti-aliasing
pixels inside the line, not holes); light semi-transparent (halo) pixels 54,017 → 0.

## Captures

`before/` = previous asset, `after/` = rebuilt asset, both on branch `feat/public-pages-logo-cleanup`.
Desktop 1440×900 and mobile 390×844 at 2× DPR, Next.js dev overlay hidden.
`home-hero-*` = top-of-page viewport; `brain-closeup-*` = the illustration in place, with surroundings.
