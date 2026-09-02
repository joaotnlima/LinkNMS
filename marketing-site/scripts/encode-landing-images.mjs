// Encode the four landing stage stills into AVIF + WebP at 1400w and 700w.
//
// Sources are the founder's 1402×1122 PNGs in cowork/pen/images. Per technical
// plan D2: AVIF q50 primary at 1400w/700w, WebP q70 as the correctness
// fallback, never upscaled past the native 1402w. Stage-2 is the banding probe:
// if q50 bands in the sky gradient, prefer q55 (still fits the ≤900 KB budget).
//
// Naming matches what ScrollReel.tsx's <picture> and hasLandingImage() expect:
//   {slug}-1400.{avif,webp}, {slug}-700.{avif,webp}

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const OUT = join(root, 'public', 'images');
const SRC = join(root, '..', 'cowork', 'pen', 'images');

mkdirSync(OUT, { recursive: true });

const SLUGS = [
  'stage-1-design',
  'stage-2-structure',
  'stage-3-finishing',
  'stage-4-house-built'
];

const AVIF_QUALITY = process.env.AVIF_Q ? Number(process.env.AVIF_Q) : 50;
const WEBP_QUALITY = 70;

let total = 0;

for (const slug of SLUGS) {
  const src = join(SRC, `${slug}.png`);
  for (const [width, suffix] of [[1400, '1400'], [700, '700']]) {
    for (const [ext, quality] of [['avif', AVIF_QUALITY], ['webp', WEBP_QUALITY]]) {
      const out = join(OUT, `${slug}-${suffix}.${ext}`);
      const info = await sharp(src)
        .resize({ width, withoutEnlargement: true })
        [ext]({ quality })
        .toFile(out);
      total += info.size;
      console.log(`${slug}-${suffix}.${ext}  ${(info.size / 1024).toFixed(1)} KB`);
    }
  }
}

// The two persona portraits of `S6 Who It Is For` (LINA-83 blocker (a)).
// SectionWho.tsx and .lp-persona__portrait are already on main and already ask
// for these slugs behind hasLandingImage() — only the files were missing, so
// this block adds them and changes nothing that ships.
//
// The pen references the portraits by their generator filenames; the web slugs
// are the readable ones the section asks for. The pen's Photo rect is 640×470
// at mode "fill" and the CSS mirrors it (aspect-ratio: 640/470, object-fit:
// cover), so encode to that box rather than by width alone: a width-only
// resize ships a ~1150px-tall frame the browser then crops to 470, paying for
// pixels nobody sees.
//
// The crop is placed by hand rather than by sharp's `attention` strategy: both
// sources are full-body frames on a site, and attention scores the
// high-contrast clutter (tools, scaffolding) over the face — it cropped Marta
// to the torso with her head cut off. `focusY` is where the face actually sits
// in each source, as a fraction of its height.
const PORTRAITS = [
  { src: 'generated-1787956648904.png', slug: 'persona-marta', focusY: 0.22 },
  { src: 'generated-1787956650899.png', slug: 'persona-joao', focusY: 0.155 }
];

// Land the face this far down the crop: clear of the top edge, and above the
// scrim's dark half (it reaches #16181d99 at 52%) where the quote is set.
const FACE_AT = 0.32;

for (const { src: file, slug, focusY } of PORTRAITS) {
  const src = join(SRC, file);
  const meta = await sharp(src).metadata();

  // Only the 640 set: SectionWho declares a single-URL srcSet at `-640`, so a
  // `-320` file would ship unreferenced, and pointing the section at it means
  // editing a component that is already on main. Encoded at the pen's 640×470.
  for (const [width, height] of [[640, 470]]) {
    const scaledHeight = Math.round((meta.height * width) / meta.width);
    const top = Math.max(
      0,
      Math.min(scaledHeight - height, Math.round(focusY * scaledHeight - FACE_AT * height))
    );

    for (const [ext, quality] of [['avif', AVIF_QUALITY], ['webp', WEBP_QUALITY]]) {
      const out = join(OUT, `${slug}-${width}.${ext}`);
      const info = await sharp(src)
        .resize({ width, withoutEnlargement: true })
        .extract({ left: 0, top, width, height })
        [ext]({ quality })
        .toFile(out);
      total += info.size;
      console.log(`${slug}-${width}.${ext}  ${(info.size / 1024).toFixed(1)} KB`);
    }
  }
}

console.log(`\nTOTAL (q${AVIF_QUALITY} avif / q${WEBP_QUALITY} webp): ${(total / 1024).toFixed(1)} KB`);
