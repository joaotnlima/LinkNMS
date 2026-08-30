// Landing page feature gates.
//
// The §6 product questions were answered by the founder on 2026-08-29 and
// routed by the PM on LINA-78; the two that map to a rendered surface are
// recorded here so the decision and the code sit in the same place.

/**
 * §6 Q3 — "AVAILABLE ON iOS app · Mobile web · Desktop web".
 * Confirmed by founder 2026-08-29 (LINA-78 §6 interaction): "Yes — ship as designed."
 */
export const SHOW_PLATFORM_STRIP = true;

/**
 * §6 Q2 — the `PRICING` nav link has no destination.
 * Dropped by founder 2026-08-29 (LINA-78 §6 interaction): "Drop the link for now."
 */
export const SHOW_PRICING_NAV = false;

/**
 * Are the scroll reveals actually built?
 *
 * True since LINA-89 and repurposed by LINA-98: the reel fade-in and the gantt
 * bar advance (SectionRecord) replace the scrubbed scroll sequence. Read by
 * `landing-render-path.ts`, which reports `render_path` to analytics — the flag
 * exists so we never tell PostHog we served an animated experience that does
 * not exist.
 *
 * Note what this flag does NOT track: whether the four stage stills are in
 * `public/images` yet. That is `hasLandingImage()`'s job, it is decided per
 * asset at build time, and the animation is correct either way — the bars
 * advance identically on the ink ground, and the photography appears on its
 * own the moment the files land. Conflating the two would make `render_path`
 * report "static" for visitors who were, in fact, animated.
 */
export const ANIMATION_ENABLED = true;
