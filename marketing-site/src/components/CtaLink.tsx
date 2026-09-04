'use client';

import type { ReactNode } from 'react';
import { track } from '@/lib/analytics-client';

// A waitlist-intent call-to-action. Per `landing-event-map-v2` §3.2 the
// `cta_location` enum is deliberately NOT widened to cover the new links the
// redesign adds: `cta_click` means "asked for access", and mixing in-page
// navigation into it would silently inflate the intent number the whole funnel
// is read against. Navigation goes through <NavLink> and `nav_click` instead.
export function CtaLink({
  location,
  href,
  className,
  children
}: {
  location: 'header' | 'hero' | 'final' | 'pricing';
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={() => track('cta_click', { cta_location: location, cta_action: 'request_access' })}
    >
      {children}
    </a>
  );
}
