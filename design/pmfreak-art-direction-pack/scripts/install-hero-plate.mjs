// Validates a production hero plate against the landing layout, then installs it.
//
// Usage, from the repo root:
//   node design/pmfreak-art-direction-pack/scripts/install-hero-plate.mjs <source-image> [--dry-run]
//
// On success it writes public/brand/landing/hero-scene.webp (2400px wide). Then point
// HERO_PLATE in src/components/landing/hero-section.tsx at "/brand/landing/hero-scene.webp"
// and delete hero-scene-interim.webp. The checks mirror hero-plate-brief.md.
import sharp from "sharp";

const [source, flag] = process.argv.slice(2);
if (!source) {
  console.error("usage: install-hero-plate.mjs <source-image> [--dry-run]");
  process.exit(2);
}

const ASPECT = 660 / 552; // the hero lays the plate out at exactly this ratio
const MIN_WIDTH = 2400;
const OUT = "public/brand/landing/hero-scene.webp";

// Zones in plate fractions (x0, y0, x1, y1). See the brief for where they come from.
const COPY_ZONE = [0.47, 0.0, 1.0, 0.46]; // live headline + CTAs sit here on desktop
const SEAM_BAND = [0.74, 0.55, 0.86, 1.0]; // the chaos -> calm seam through the PM

const meta = await sharp(source).metadata();
const failures = [];
const notes = [];

if (meta.width < MIN_WIDTH) failures.push(`width ${meta.width}px < ${MIN_WIDTH}px`);
const aspect = meta.width / meta.height;
if (Math.abs(aspect - ASPECT) / ASPECT > 0.02) {
  failures.push(`aspect ${aspect.toFixed(3)} is not ${ASPECT.toFixed(3)} (660:552) within 2%`);
}

async function zoneStats([x0, y0, x1, y1]) {
  const left = Math.round(x0 * meta.width);
  const top = Math.round(y0 * meta.height);
  const width = Math.round((x1 - x0) * meta.width);
  const height = Math.round((y1 - y0) * meta.height);
  // stats() reads the pipeline's input, so the zone is rendered to a buffer first.
  const zone = await sharp(source).extract({ left, top, width, height }).removeAlpha().greyscale().png().toBuffer();
  const { channels } = await sharp(zone).stats();
  return { mean: channels[0].mean / 255, stdev: channels[0].stdev / 255 };
}

// Off-white text on this zone needs a near-charcoal, low-detail backdrop.
const copy = await zoneStats(COPY_ZONE);
notes.push(`copy zone: mean luminance ${copy.mean.toFixed(3)}, detail ${copy.stdev.toFixed(3)}`);
if (copy.mean > 0.14) failures.push(`copy zone too bright (mean ${copy.mean.toFixed(3)} > 0.14): headline contrast at risk`);
if (copy.stdev > 0.1) failures.push(`copy zone too busy (stdev ${copy.stdev.toFixed(3)} > 0.10): text would fight the art`);

// The seam band should carry contrast (the light split), so it is reported, not enforced.
const seam = await zoneStats(SEAM_BAND);
notes.push(`seam band: mean luminance ${seam.mean.toFixed(3)}, detail ${seam.stdev.toFixed(3)}`);

console.log(`${source}: ${meta.width}x${meta.height} ${meta.format}`);
for (const note of notes) console.log(`  · ${note}`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("  ✓ passes layout checks (still review text/logo/UI content by eye)");

if (flag !== "--dry-run") {
  await sharp(source)
    .resize({ width: MIN_WIDTH, height: Math.round(MIN_WIDTH / ASPECT), fit: "cover", position: "bottom" })
    .flatten({ background: "#0F1113" })
    .webp({ quality: 82 })
    .toFile(OUT);
  console.log(`  → wrote ${OUT}`);
}
