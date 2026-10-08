# PMFreak hero plate: production artwork brief

> **Status (2026-10):** installed. `public/brand/landing/hero-scene.webp` is the approved 1371px artwork Lanczos-upscaled (installed at 2400 × 2007), so it carries no native high-resolution detail. The interim plate, its build script and the guide image were retired. Re-run `install-hero-plate.mjs` when native ≥2400px artwork arrives; `make-hero-plate-guide.mjs <plate> <out.png>` redraws the zone guide over any plate.

Replaces the interim plate `public/brand/landing/hero-scene-interim.webp`, a 660px crop of the approved mockup.
Composition guide: `hero-plate-guide.png`, with zones drawn over the interim plate for placement.

## Deliverable
- **One raster scene plate, 660:552 (≈1.196:1), at least 2400px wide. Ideal: 2640 × 2208 px.** PNG or high-quality JPG/WebP, sRGB, no alpha.
- Must contain **no** text you could read as copy, no buttons, no navbar, no third-party logos (Slack, Notion, Jira…), no product UI, no mascot, no watermark. Handwriting on sticky notes is fine if it's short and generic ("RISKS!", "DELAY??", "Where is this file?!").
- Install with: `node design/pmfreak-art-direction-pack/scripts/install-hero-plate.mjs <file>`. It checks size, aspect and the copy zone, then writes `public/brand/landing/hero-scene.webp`.

## Scene (same concept as the approved mockup)
A project manager seen from behind, seated at a desk at night, head and shoulders centred on a vertical seam of light at **x ≈ 80%**. Hoodie, messy hair, human and relatable (not a corporate stock model).
- **Left, about x 0–75% (freaked out):** a wall and desk of overload in Freak Orange `#FF8A00` / Warm Amber `#FFC05E` light. Sticky notes, a laptop with an unread-message pile, coffee cups, crumpled paper, a desk lamp. Busy, warm and slightly comic.
- **Right of the seam (calm):** the same desk in Calm Teal `#14B8A6` / Mint `#7FE1C1` light: tidy, a plant, soft glow. Keep it sparse; from x ≈ 86% it fades out under the live product window.
- The seam is a thin, clean vertical light line through the PM, splitting the two moods.

## Layout zones (plate fractions; all are checked or drawn in the guide)
| Zone | Area | Requirement |
|---|---|---|
| A · copy zone | x 47–100%, y 0–46% | Near-charcoal `#0F1113`, very low detail, no objects. The live headline and CTAs sit here. Checked: mean luminance ≤ 0.14, detail (stdev) ≤ 0.10. |
| B · phone crop | x 30–100%, y 40–100% | The PM, the seam and some chaos must read in this crop alone. |
| C · tablet crop | x 0–100%, y 40–100% | The full lower band. |
| D · seam | x ≈ 80%, from y ≈ 50% down | The PM's head starts below y ≈ 50% so it never sits behind the headline. |
| E · right edge | x 86–100% | Masked to transparent on desktop. Keep it simple (teal glow and plant). |

## Style
Painterly-cinematic and illustrative, close to the approved mockup's rendering: warm/cool split lighting, rich but not neon. Charcoal shadows, with the palette above carrying the light.
**Avoid:** cosmic or sci-fi effects, holograms, floating dashboards, particle networks, glossy 3D SaaS characters, generic stock-photo look and heavy bloom.

## Generation prompt (starting point for an image model or illustrator)
> Cinematic illustrated scene, wide 6:5 format. A project manager seen from behind sitting at a desk at night, head and shoulders lower-right of centre, a thin vertical seam of light splitting the frame through the person at about 80% of the width. Left of the seam: a chaotic workspace bathed in warm orange (#FF8A00) and amber (#FFC05E) light, with a wall covered in sticky notes reading "RISKS!", "DELAY??", "Where is this file?!", "Too much context", plus a laptop with a pile of unread messages, coffee cups, crumpled paper and a desk lamp. Right of the seam: the same desk calm and tidy in teal (#14B8A6) and mint (#7FE1C1) light, with a plant. The entire upper-right area (top 45%, right half) is empty dark charcoal (#0F1113) wall in deep shadow with no objects, reserved for text. Painterly, premium, human, slightly rebellious; no logos, no UI, no readable brand names, no sci-fi, no holograms.

## After install
1. In `src/components/landing/hero-section.tsx`, set `HERO_PLATE` to `/brand/landing/hero-scene.webp` and delete the INTERIM comment block.
2. Delete `public/brand/landing/hero-scene-interim.webp` and `scripts/make-interim-hero-plate.mjs`.
3. Re-check at 390, 1024, 1280, 1440 and 1920px. The phone crop and the 1280 copy overlap are the sensitive spots.
