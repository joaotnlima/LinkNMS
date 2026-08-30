'use client';

import { useEffect } from 'react';
import { track } from '@/lib/analytics-client';

/**
 * `section_view` — the replacement for `scroll_depth` (event map v2 §3.3).
 *
 * With a pinned 300vh section, "scrolled 50% of the page" stops meaning
 * "read half the page", so reading progress is measured per section instead:
 * a section counts as viewed when it is ≥50% in the viewport for ≥1s, once per
 * section per pageview.
 *
 * One observer for the whole page, mounted once. It reads the section list off
 * the DOM rather than taking it as a prop so adding a section cannot silently
 * drop it from the funnel.
 */

const VISIBLE_RATIO = 0.5;
const DWELL_MS = 1000;

// Slugs match the event map's section vocabulary, in page order.
const SECTIONS: { id: string; slug: string }[] = [
  { id: 'top', slug: 'hero' },
  { id: 'the-argument', slug: 's01_argument' },
  { id: 'the-record', slug: 's02_record' },
  { id: 'the-sequence', slug: 's02_sequence' },
  { id: 'getting-the-plan-in', slug: 's03_plan_in' },
  { id: 'materials-and-money', slug: 's04_materials' },
  { id: 'who-it-is-for', slug: 's05_who_for' },
  { id: 'request-access', slug: 's06_cta' }
];

export function SectionViewTracker() {
  useEffect(() => {
    const fired = new Set<string>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id;
          const section = SECTIONS.find((s) => s.id === id);
          if (!section || fired.has(id)) continue;

          // A section taller than the viewport can never reach a 0.5
          // intersectionRatio, so "half visible" is measured against whichever
          // is smaller: the section or the viewport.
          const reference = Math.min(
            entry.boundingClientRect.height,
            entry.rootBounds?.height ?? window.innerHeight
          );
          const visible = reference > 0 ? entry.intersectionRect.height / reference : 0;

          if (visible >= VISIBLE_RATIO) {
            if (timers.has(id)) continue;
            // The dwell requirement is what keeps a fast scroll past a section
            // from counting as having read it.
            timers.set(
              id,
              setTimeout(() => {
                fired.add(id);
                timers.delete(id);
                track('section_view', {
                  section: section.slug,
                  index: SECTIONS.indexOf(section)
                });
              }, DWELL_MS)
            );
          } else {
            const timer = timers.get(id);
            if (timer) {
              clearTimeout(timer);
              timers.delete(id);
            }
          }
        }
      },
      // Fine-grained thresholds so the callback runs as a tall section crosses
      // the halfway mark, not only when it is fully in or fully out.
      { threshold: [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 1] }
    );

    for (const { id } of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => {
      observer.disconnect();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);

  return null;
}
