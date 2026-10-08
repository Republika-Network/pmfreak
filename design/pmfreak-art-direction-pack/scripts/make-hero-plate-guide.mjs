import sharp from "sharp";
const [src, out] = process.argv.slice(2);
const W = 2640, H = Math.round(W * 552 / 660);
const r = (x0, y0, x1, y1) => `x="${x0*W}" y="${y0*H}" width="${(x1-x0)*W}" height="${(y1-y0)*H}"`;
const t = (x, y, s, c, txt) => `<text x="${x*W}" y="${y*H}" font-family="Arial, sans-serif" font-weight="700" font-size="${s}" fill="${c}">${txt}</text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
 <rect ${r(0.47,0,1,0.46)} fill="#0F1113" fill-opacity="0.55" stroke="#7FE1C1" stroke-width="8" stroke-dasharray="40 20"/>
 ${t(0.49,0.07,56,"#7FE1C1","A · COPY ZONE (live headline + CTAs)")}
 ${t(0.49,0.12,40,"#F4EFE6","near-charcoal #0F1113, low detail, no objects")}
 ${t(0.49,0.16,40,"#F4EFE6","checked: mean luminance ≤ 0.14, detail ≤ 0.10")}
 <rect ${r(0.303,0.402,1,1)} fill="none" stroke="#FFC05E" stroke-width="8" stroke-dasharray="24 16"/>
 ${t(0.315,0.44,44,"#FFC05E","B · PHONE CROP (PM + seam must read here)")}
 <rect ${r(0,0.402,1,1)} fill="none" stroke="#FF8A00" stroke-width="5" stroke-dasharray="10 14"/>
 ${t(0.01,0.385,40,"#FF8A00","C · TABLET CROP (full width, lower 60%)")}
 <line x1="${0.8*W}" y1="${0.5*H}" x2="${0.8*W}" y2="${H}" stroke="#14B8A6" stroke-width="10"/>
 ${t(0.81,0.53,44,"#14B8A6","D · SEAM x≈80%")}
 <rect ${r(0.86,0,1,1)} fill="#14B8A6" fill-opacity="0.18"/>
 ${t(0.865,0.97,36,"#7FE1C1","E · fades out under product window")}
 ${t(0.01,0.035,48,"#F4EFE6","CHAOS SIDE (orange/amber): x 0–75%")}
 ${t(0.01,0.985,34,"#F4EFE6","PMFreak hero plate guide · 660:552 · deliver ≥2400px wide (2640×2208 ideal) · background shown is the INTERIM plate, for placement only")}
</svg>`;
await sharp(src).resize(W, H).composite([{ input: Buffer.from(svg) }]).png().toFile(out);
