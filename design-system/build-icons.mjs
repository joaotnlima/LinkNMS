#!/usr/bin/env node
// Regenerate the brand-kit icon set from the SVG master.
// Edit cowork/design/logos/icon.svg, run `npm run icons` — done.
// Icons carry NO text (the mark only); the wordmark is added per-surface.
//
// Deps: sharp (raster), svgo (optimise), png-to-ico (favicon).

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { optimize } from "svgo";
import pngToIco from "png-to-ico";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SRC = path.join(ROOT, "cowork/design/logos/icon.svg");
const OUT = path.join(ROOT, "cowork/design/brand-kit/icon");
const SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const rawSvg = await fs.readFile(SRC, "utf8");
const { data: svg } = optimize(rawSvg, { multipass: true });
await fs.mkdir(OUT, { recursive: true });

// One crisp high-res master, then downscale for every size.
const master = await sharp(Buffer.from(svg), { density: 2048 })
  .resize(1024, 1024, { fit: "contain", background: TRANSPARENT })
  .png()
  .toBuffer();

for (const s of SIZES) {
  await sharp(master)
    .resize(s, s, { fit: "contain", background: TRANSPARENT })
    .png()
    .toFile(path.join(OUT, `icon-${s}.png`));
}
await sharp(master).resize(512, 512).webp().toFile(path.join(OUT, "icon-512.webp"));

const ico = await pngToIco([16, 32, 48].map((s) => path.join(OUT, `icon-${s}.png`)));
await fs.writeFile(path.join(OUT, "favicon.ico"), ico);

console.log(`icons rebuilt from ${path.relative(ROOT, SRC)} → ${SIZES.length} PNG + webp + favicon.ico`);
