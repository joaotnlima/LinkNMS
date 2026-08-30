import { getTranslations, setRequestLocale } from 'next-intl/server';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { Hero } from '@/components/landing/Hero';
import { SectionArgument } from '@/components/landing/SectionArgument';
import { SectionRecord } from '@/components/landing/SectionRecord';
import { ScrollSequence } from '@/components/landing/ScrollSequence';
import { SectionPlanIn } from '@/components/landing/SectionPlanIn';
import { SectionMaterials } from '@/components/landing/SectionMaterials';
import { SectionWho } from '@/components/landing/SectionWho';
import { SectionCta } from '@/components/landing/SectionCta';
import { SiteFooter } from '@/components/landing/SiteFooter';
import { SectionViewTracker } from '@/components/landing/SectionViewTracker';

/*
 * The landing page (LINA-83).
 *
 * <LandingHeader /> is a SIBLING of every section, including the pinned
 * <ScrollSequence />, and must stay that way — see the comment at the top of
 * LandingHeader.tsx for why nesting it inside the pinned section breaks the
 * fixed positioning outright.
 */

export default async function Home({
  params,
  searchParams
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ confirmed?: string; confirm?: string; source?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const source = typeof sp.source === 'string' ? sp.source : 'organic';

  const t = await getTranslations();

  const confirmBanner =
    sp.confirmed === '1'
      ? { title: t('waitlist.confirmedTitle'), body: t('waitlist.confirmedBody'), error: false }
      : sp.confirm === 'invalid'
        ? { title: t('waitlist.confirmInvalidTitle'), body: t('waitlist.confirmInvalidBody'), error: true }
        : null;

  return (
    <div className="lp">
      <a className="lp-skip" href="#the-argument">
        {t('lp.skip')}
      </a>

      <LandingHeader />
      {/* Fires `section_view`, the event map's replacement for `scroll_depth`. */}
      <SectionViewTracker />

      <main>
        <Hero />
        <SectionArgument locale={locale} />
        <SectionRecord locale={locale} />
        <ScrollSequence locale={locale} />
        <SectionPlanIn locale={locale} />
        <SectionMaterials locale={locale} />
        <SectionWho />

        {confirmBanner && (
          <div className="lp-wrap" style={{ paddingBlock: 32 }}>
            <div
              className={`lp-form__msg${confirmBanner.error ? ' lp-form__msg--error' : ''}`}
              role="status"
              style={{ background: '#16181d0a', borderColor: 'var(--lp-ink-hair)' }}
            >
              <p className="mt">{confirmBanner.title}</p>
              <p className="mb" style={{ color: 'var(--lp-ink-70)' }}>
                {confirmBanner.body}
              </p>
            </div>
          </div>
        )}

        <SectionCta locale={locale} source={source} />
      </main>

      <SiteFooter />
    </div>
  );
}
