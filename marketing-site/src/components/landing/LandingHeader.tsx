'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CtaLink } from '@/components/CtaLink';
import { SHOW_PRICING_NAV } from '@/lib/landing-flags';
import { LandingMark } from './icons';
import { LangMenu } from './LangMenu';
import { NavLink, type NavTarget } from './NavLink';

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS ELEMENT MUST STAY A SIBLING OF THE PINNED SECTION, NEVER A DESCENDANT.
 *
 * GSAP's ScrollTrigger `pin: true` wraps the pinned section in a `pin-spacer`
 * and may apply a transform to it. A `position: fixed` element inside a
 * transformed ancestor is positioned against that ancestor instead of the
 * viewport — the header would visibly detach and scroll away with the section.
 * Render <LandingHeader /> at page level, above <main>, and nowhere else.
 *
 * Space for the header is reserved by the *content layer inside* the pinned
 * stage (`padding-top: var(--header-h)` in .lp-sequence__content), not on the
 * section box and not via ScrollTrigger's `pinnedContainer`.
 * See LINA-82 `landing-redesign-technical-plan`, decision D1.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Stuck at 120px of scroll — deliberately not "when the hero ends". Waiting for
 *  the hero to clear leaves the header floating with no background over the top
 *  of section 01. */
const STUCK_AT = 120;

type HeaderLink = { key: 'problem' | 'how' | 'builders' | 'pricing'; href: string; target: NavTarget };

const NAV_LINKS: HeaderLink[] = [
  { key: 'problem', href: '#the-argument', target: 'problem' },
  { key: 'how', href: '#the-record', target: 'how_it_works' },
  { key: 'builders', href: '#who-it-is-for', target: 'for_builders' },
  // PRICING dropped by the founder (§6 Q2) — see landing-flags.ts.
  ...(SHOW_PRICING_NAV
    ? [{ key: 'pricing' as const, href: '#pricing', target: 'pricing' as const }]
    : [])
];

export function LandingHeader() {
  const t = useTranslations('lp.header');
  // Server renders the at-rest state; the first effect corrects it for a
  // restored scroll position before paint-relevant work happens.
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > STUCK_AT);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className="lp-header" data-stuck={stuck ? 'true' : 'false'}>
      <div className="lp-header__left">
        {/* Both slots are always in the DOM. The swap is a display toggle, so
            the header restyles without ever re-mounting. */}
        <span className="lp-header__status lp-micro">
          <span className="lp-header__dot" aria-hidden="true" />
          <span>{t('status')}</span>
        </span>
        <a className="lp-header__lockup" href="#top">
          <LandingMark />
          <span>linknms</span>
        </a>
      </div>

      <nav aria-label={t('navLabel')}>
        <ul className="lp-header__nav">
          {NAV_LINKS.map(({ key, href, target }) => (
            <li key={key} className="lp-header__navlink">
              <NavLink className="lp-micro" href={href} target={target}>
                {t(`nav.${key}`)}
              </NavLink>
            </li>
          ))}
          <li>
            <LangMenu />
          </li>
          <li>
            <CtaLink location="header" className="lp-header__cta lp-micro" href="#request-access">
              {t('cta')}
            </CtaLink>
          </li>
        </ul>
      </nav>
    </header>
  );
}
