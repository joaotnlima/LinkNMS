'use client';

import { ANIMATION_ENABLED } from './landing-flags';

/**
 * The fallback guard for the pinned scroll sequence, and the analytics answer
 * to "which experience was actually served?" (`landing-event-map-v2` §2).
 *
 * This module is the ONLY place the guard is expressed. The animation must call
 * `resolveRenderPath()` and return early on `static` **before** it `await
 * import()`s gsap / ScrollTrigger / Lenis — the acceptance criterion is zero
 * extra bytes on the reduced path, so a top-level import (or `next/dynamic` on
 * a component that renders unconditionally) fails it on every phone.
 *
 * Nothing in here imports an animation library, which is what makes it safe to
 * evaluate on every page load.
 */

export type RenderPath = 'animated' | 'static';

export type StaticReason =
  | 'reduced_motion'
  | 'small_viewport'
  | 'save_data'
  | 'slow_connection'
  | 'no_js'
  | 'not_implemented'
  | 'error'
  | null;

const SMALL_VIEWPORT_MAX = 767;
const SLOW_TYPES = new Set(['slow-2g', '2g', '3g']);

type NetworkInformation = { saveData?: boolean; effectiveType?: string };

export function resolveRenderPath(): { renderPath: RenderPath; staticReason: StaticReason } {
  if (typeof window === 'undefined') {
    // Server render. The HTML we emit is the static p=1 state by design, and a
    // visitor with JS off never corrects this — which is exactly `no_js`.
    return { renderPath: 'static', staticReason: 'no_js' };
  }

  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return { renderPath: 'static', staticReason: 'reduced_motion' };
    }
    if (window.innerWidth <= SMALL_VIEWPORT_MAX) {
      return { renderPath: 'static', staticReason: 'small_viewport' };
    }
    const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    if (conn?.saveData) {
      return { renderPath: 'static', staticReason: 'save_data' };
    }
    if (conn?.effectiveType && SLOW_TYPES.has(conn.effectiveType)) {
      return { renderPath: 'static', staticReason: 'slow_connection' };
    }
  } catch {
    // A guard that throws must fail closed to the static path — the server
    // already rendered the informative state, so there is nothing to lose.
    return { renderPath: 'static', staticReason: 'error' };
  }

  if (!ANIMATION_ENABLED) {
    // The guard would have allowed the animation, but the animation is not
    // built yet (LINA-83 blocker (a): the stage assets are not in the repo).
    // Reporting `animated` here would fabricate the exact comparison
    // `render_path` exists to make, so we report the truth and carry a reason
    // the event map does not have a value for yet — flagged to Analytics.
    return { renderPath: 'static', staticReason: 'not_implemented' };
  }

  return { renderPath: 'animated', staticReason: null };
}
