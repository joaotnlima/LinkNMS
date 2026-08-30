import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Is a landing image actually present in `public/images`?
 *
 * The hero still, the four stage stills and the two persona portraits are not
 * in the repo yet (LINA-83 blocker (a): the founder has to commit
 * `cowork/pen/images/`, and the derived web assets follow from those). Emitting
 * an `<img>` for a file that 404s puts Chrome's broken-image glyph on top of
 * the hero, which is a worse failure than no photograph at all — the sections
 * are designed on an ink ground and read perfectly without one.
 *
 * So the picture element is emitted only when the asset exists. This resolves
 * at build time on the server, costs nothing at runtime, and the photography
 * appears on its own the moment the files land — no code change, no follow-up
 * ticket to forget.
 */

const PUBLIC_IMAGES = join(process.cwd(), 'public', 'images');

export function hasLandingImage(slug: string): boolean {
  // The WebP is the fallback every <picture> on the page declares, so its
  // presence is what decides whether the set is usable at all.
  return existsSync(join(PUBLIC_IMAGES, `${slug}.webp`));
}
