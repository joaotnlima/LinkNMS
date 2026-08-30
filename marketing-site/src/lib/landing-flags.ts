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
 * False until LINA-83 blocker (a) clears — the four stage stills are still not
 * in the repo, so there is nothing to cross-fade. The server-rendered p=1 state
 * ships regardless and is the whole section until this flips.
 *
 * Read by `landing-render-path.ts`, which reports `render_path` to analytics.
 * Keeping it explicit is what stops us telling PostHog we served an animated
 * experience that does not exist yet.
 */
export const ANIMATION_ENABLED = false;
