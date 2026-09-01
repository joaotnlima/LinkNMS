'use client';

import { useEffect, useRef, useState } from 'react';
import { resolveRenderPath } from '@/lib/landing-render-path';

/**
 * Arms then reveals a section's scroll animation (LINA-98).
 *
 * The server HTML always renders the FINAL state — reel photo up, bars
 * closed — so no-JS / reduced-motion / save-data / small-viewport visitors get
 * exactly the pen's finished frame as their default. This component only
 * intervenes when `resolveRenderPath()` reports `animated`, and it does so in
 * two stages:
 *
 *  1. `is-animating` — added as soon as the effect runs (the reel and gantt
 *     are below the 940px hero, so that is still pre-scroll). Until
 *     `is-revealed` is present it can carry no transitions — landing.css gates
 *     every transition on `.is-animating.is-revealed` — so there is no visible
 *     flash while the animation is armed.
 *  2. `is-revealed` — added the first time the wrapper crosses the observer
 *     threshold. Only then do the card fades / bar advances run, exactly once.
 *
 * The classes are read by CSS only; the SVG attribute transforms remain the
 * static-path source of truth (see PlanTrack.tsx).
 */
export function RevealOnScroll({
  variant = 'reel',
  children
}: {
  variant?: 'reel' | 'gantt';
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [animated, setAnimated] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (resolveRenderPath().renderPath !== 'animated') return;

    setAnimated(true);

    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setRevealed(true);
          io.disconnect();
          break;
        }
      },
      { threshold: 0.25 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const classes = ['lp-reveal', `lp-reveal--${variant}`];
  if (animated) classes.push('is-animating');
  if (revealed) classes.push('is-revealed');

  return (
    <div ref={ref} className={classes.join(' ')}>
      {children}
    </div>
  );
}