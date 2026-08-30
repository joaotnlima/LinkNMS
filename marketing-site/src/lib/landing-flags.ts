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
 * Is the scrubbed scroll sequence actually built?
 *
 * True since LINA-89: the timeline, the p → barState → stage chain, the
 * wind-back and the sequence events all ship. Read by `landing-render-path.ts`,
 * which reports `render_path` to analytics — the flag exists so we never tell
 * PostHog we served an animated experience that does not exist.
 *
 * Note what this flag does NOT track: whether the four stage stills are in
 * `public/images` yet. That is `hasLandingImage()`'s job, it is decided per
 * asset at build time, and the animation is correct either way — the bars,
 * caption and HUD scrub identically on the ink ground, and the photography
 * appears on its own the moment the files land. Conflating the two would make
 * `render_path` report "static" for visitors who were, in fact, animated.
 */
export const ANIMATION_ENABLED = true;

/**
 * How stage 1 hands off to stage 2 (LINA-89 §8, LINA-78 §6 Q4).
 *
 * The camera moves between the current stage-1 still and stage 2, so dissolving
 * one into the other reads as a glitch rather than a build step. The founder
 * chose a stage-1 re-render on a matched camera, which makes a plain cross-fade
 * correct; that re-render is a Product Designer child issue of LINA-78 and has
 * not landed. Until it does, this stays on `cut`.
 *
 * Both paths live behind the single `applyStage1To2()` in `SequenceMotion.tsx`.
 * Flipping this constant is the whole change when the re-render arrives.
 */
export const STAGE_1_TO_2: 'crossfade' | 'cut' = 'cut';
