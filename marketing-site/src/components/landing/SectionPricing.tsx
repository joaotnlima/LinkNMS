import { getTranslations } from 'next-intl/server';
import { CtaLink } from '@/components/CtaLink';
import { ArrowRightIcon } from './icons';
import { SectionPricingToggle } from './SectionPricingToggle';

// 06 · Pricing — Owner/Builder toggle.
//
// Owner panel is implementable from the approved plan (free early-access,
// first 50 seats). Builder panel is a scaffold — content will fill in once
// the pen pricing frames are committed (LINA-167 blocker).
//
// Toggle is a client component so state lives at the edge; both panels are
// server-rendered and switched via CSS data-attribute selectors.

export async function SectionPricing() {
  const t = await getTranslations('lp.pricing');

  return (
    <section className="lp-section lp-pricing" id="pricing">
      <div className="lp-wrap">
        <div className="lp-labelbar lp-micro">
          <span>06</span>
          <span>{t('label')}</span>
          <span className="rule" aria-hidden="true" />
          <span className="right">{t('labelRight')}</span>
        </div>

        <SectionPricingToggle labelOwner={t('toggleOwner')} labelBuilder={t('toggleBuilder')}>
          <div data-pricing-panel="owner" className="lp-pricing__panel">
            <p className="lp-micro lp-pricing__kicker">{t('owner.kicker')}</p>
            <h2 className="lp-display lp-pricing__headline">{t('owner.headline')}</h2>
            <p className="lp-pricing__body">{t('owner.body')}</p>
            <div className="lp-pricing__actions">
              <CtaLink location="pricing" className="lp-btn lp-btn--ink" href="#request-access">
                {t('owner.cta')}
                <ArrowRightIcon />
              </CtaLink>
              <p className="lp-micro lp-pricing__reassure">{t('owner.reassure')}</p>
            </div>
          </div>

          <div data-pricing-panel="builder" className="lp-pricing__panel">
            <p className="lp-micro lp-pricing__kicker">{t('builder.kicker')}</p>
            <h2 className="lp-display lp-pricing__headline">{t('builder.headline')}</h2>
            <p className="lp-pricing__body">{t('builder.body')}</p>
          </div>
        </SectionPricingToggle>
      </div>
    </section>
  );
}
