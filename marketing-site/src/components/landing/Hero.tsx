import { getTranslations } from 'next-intl/server';
import { CtaLink } from '@/components/CtaLink';
import { hasLandingImage } from '@/lib/landing-assets';
import { SHOW_PLATFORM_STRIP } from '@/lib/landing-flags';
import { ArrowDownIcon, ArrowRightIcon, BrowserIcon, DesktopIcon, LandingMark, PhoneIcon } from './icons';
import { NavLink } from './NavLink';

// Hero. The brand at rest is the 196px wordmark here — which is why the header
// carries no lockup until it sticks (spec §2, "Why the lockup").
//
// ASSET: /images/hero-* is not in the repo yet (LINA-83 blocker (a)). Until it
// lands the hero renders on the ink ground with the scrim — dark and legible,
// not broken.

const PLATFORM_ICONS = {
  ios: PhoneIcon,
  mobileWeb: BrowserIcon,
  desktopWeb: DesktopIcon
} as const;

export async function Hero() {
  const t = await getTranslations('lp.hero');

  return (
    <section className="lp-hero" id="top">
      {hasLandingImage('hero-1600') && (
        <div className="lp-hero__media" aria-hidden="true">
          <picture>
            <source type="image/avif" srcSet="/images/hero-700.avif 700w, /images/hero-1600.avif 1600w" sizes="100vw" />
            <source type="image/webp" srcSet="/images/hero-700.webp 700w, /images/hero-1600.webp 1600w" sizes="100vw" />
            <img src="/images/hero-1600.webp" alt="" decoding="async" fetchPriority="high" />
          </picture>
        </div>
      )}
      <div className="lp-hero__scrim" aria-hidden="true" />

      <div className="lp-hero__inner lp-wrap">
        <h1 className="lp-hero__wordmark">LINKNMS</h1>

        <div className="lp-hero__row">
          <div>
            <p className="lp-hero__lede">{t('lede')}</p>
            <p className="lp-hero__meta lp-micro">{t('meta')}</p>

            {/* §6 Q3 — approved by the founder, ships as designed. */}
            {SHOW_PLATFORM_STRIP && (
              <div className="lp-hero__platforms">
                <p className="lp-micro" style={{ color: 'var(--lp-cream-60)' }}>
                  {t('platforms.head')}
                </p>
                <ul className="lp-hero__platformrow">
                  {(['ios', 'mobileWeb', 'desktopWeb'] as const).map((key) => {
                    const Icon = PLATFORM_ICONS[key];
                    return (
                      <li className="lp-hero__platform" key={key}>
                        <Icon />
                        <span>{t(`platforms.${key}`)}</span>
                      </li>
                    );
                  })}
                </ul>
                <p className="lp-hero__platformnote">{t('platforms.note')}</p>
              </div>
            )}

            <div className="lp-hero__actions" style={{ marginTop: 36 }}>
              <CtaLink location="hero" className="lp-btn" href="#request-access">
                {t('primary')}
                <ArrowRightIcon />
              </CtaLink>
              {/* The secondary CTA is navigation, not waitlist intent, so it
                  fires `nav_click` and stays out of the `cta_click` number
                  (event map v2 §3.2). */}
              <NavLink className="lp-btn lp-btn--ghost" href="#the-record" target="hero_secondary">
                {t('secondary')}
                <ArrowDownIcon />
              </NavLink>
            </div>
            <p className="lp-hero__reassure lp-micro">{t('reassure')}</p>
          </div>

          <div className="lp-hero__card">
            <h2>{t('card.title')}</h2>
            <div className="lp-dashed" aria-hidden="true" />
            <p>{t('card.body')}</p>
          </div>
        </div>
      </div>

      <span className="lp-hero__sticker" hidden>
        <LandingMark />
      </span>
    </section>
  );
}
