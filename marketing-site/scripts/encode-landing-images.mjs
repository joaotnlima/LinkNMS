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

// The two persona portraits of `S6 Who It Is For`. The pen references them by
// their generator filenames; the web slugs are the readable ones the section
// asks for. Portrait crop, so they are sized by width at the 2x/1x of the
// pen's 320pt column — 640 and 320.
const PORTRAITS = [
  { src: 'generated-1787956648904.png', slug: 'persona-marta' },
  { src: 'generated-1787956650899.png', slug: 'persona-joao' }
];

for (const { src: file, slug } of PORTRAITS) {
  const src = join(SRC, file);
  for (const width of [640, 320]) {
    for (const [ext, quality] of [['avif', AVIF_QUALITY], ['webp', WEBP_QUALITY]]) {
      const out = join(OUT, `${slug}-${width}.${ext}`);
      const info = await sharp(src)
        .resize({ width, withoutEnlargement: true })
        [ext]({ quality })
        .toFile(out);
      total += info.size;
      console.log(`${slug}-${width}.${ext}  ${(info.size / 1024).toFixed(1)} KB`);
    }
  }
}

console.log(`\nTOTAL (q${AVIF_QUALITY} avif / q${WEBP_QUALITY} webp): ${(total / 1024).toFixed(1)} KB`);
