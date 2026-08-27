'use client';

import type { ReactNode } from 'react';
import { track } from '@/lib/analytics-client';

// A waitlist call-to-action anchor that emits `cta_click` with its placement.
// Used for the three CTAs that jump to the waitlist form: header, hero, final.
export function CtaLink({
  location,
  href,
  className,
  children
}: {
  location: 'header' | 'hero' | 'final';
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={() => track('cta_click', { cta_location: location })}
    >
      {children}
    </a>
  );
}
