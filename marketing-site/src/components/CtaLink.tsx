'use client';

import type { ReactNode } from 'react';
import { track } from '@/lib/analytics-client';
import { setPlanIntent } from '@/lib/plan-intent';
import type { Persona } from '@/lib/pricing';

// A waitlist-intent call-to-action. Per `landing-event-map-v2` §3.2 the
// `cta_location` enum is deliberately NOT widened to cover the new links the
// redesign adds: `cta_click` means "asked for access", and mixing in-page
// navigation into it would silently inflate the intent number the whole funnel
// is read against. Navigation goes through <NavLink> and `nav_click` instead.
export function CtaLink({
  location,
  href,
  persona,
  className,
  children
}: {
  location: 'header' | 'hero' | 'final' | 'pricing';
  href: string;
  /**
   * Which side of the Owner/Builder split this CTA sits on (LINA-189).
   *
   * Set only where the CTA genuinely belongs to one persona — today that is the
   * builder ribbon, the one pricing CTA that carries no plan key and so has no
   * other way to say who pressed it. The header/hero/final CTAs are deliberately
   * left unset: they sit above the Owner/Builder split, and inventing a persona
   * for them would put a confident wrong answer in the database instead of an
   * honest null.
   */
  persona?: Persona;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={() => {
        track('cta_click', { cta_location: location, cta_action: 'request_access' });
        // A persona-only intent: no plan, so the waitlist form still submits a
        // plain signup — it just knows which side of the page it came from.
        if (persona) setPlanIntent({ plan: '', label: '', persona });
      }}
    >
      {children}
    </a>
  );
}
