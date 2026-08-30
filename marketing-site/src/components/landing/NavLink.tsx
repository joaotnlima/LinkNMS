'use client';

import type { ReactNode } from 'react';
import { track } from '@/lib/analytics-client';

// Navigational / in-page-jump link. Fires `nav_click` (event map v2 §3.2),
// which is kept separate from `cta_click` so waitlist intent stays a clean
// number. `from_section` is resolved at click time from the section the link
// sits in, so the same component works in the header, in a band and in the
// footer without being told where it is.

export type NavTarget =
  | 'problem'
  | 'how_it_works'
  | 'for_builders'
  | 'pricing'
  | 'hero_secondary'
  | 's03_handshake'
  | 'footer_product'
  | 'footer_for'
  | 'footer_company'
  | 'footer_legal';

function sectionOf(el: HTMLElement | null): string {
  const section = el?.closest('section, footer, header');
  return section?.id || section?.tagName.toLowerCase() || 'unknown';
}

export function NavLink({
  target,
  href,
  className,
  children
}: {
  target: NavTarget;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={(e) => track('nav_click', { target, from_section: sectionOf(e.currentTarget) })}
    >
      {children}
    </a>
  );
}
