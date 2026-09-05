import { getTranslations } from 'next-intl/server';
import { CtaLink } from '@/components/CtaLink';
import { FREE_FOUNDING_PLAN_KEY, type PaidPlanKey } from '@/lib/pricing';
import { foundingSeats } from '@/lib/seats';
import { CheckIcon } from './icons';
import { PlanCta } from './PlanCta';
import { pricingPanelId, pricingTabId } from './pricingTabs';
import { SectionPricingToggle } from './SectionPricingToggle';

// 06 · Pricing — the pen's S7 Pricing frames (owner + builder).
//
// Both views share the label bar, head + Owner/Builder toggle, the Core band,
// the Billing / "how it works" flow and the foot; the Ribbon and the three plan
// cards differ per audience. Everything for both audiences is server-rendered
// once and shown/hidden through `data-pricing-view` on the pricing root, which
// the toggle (a client component) drives. Accent colour is owner-blue
// (--plan-baseline) vs builder-clay (--plan-actual), keyed off that same root.

type Plan = {
  name: string;
  sub: string;
  price: string;
  proj: string;
  plus?: string;
  feats: string[];
  cta: string;
};

// The founding ribbon's seat counter is read from the database at request time
// (LINA-189) — see `foundingSeats()`. It used to be `const SEATS_CLAIMED = 18`,
// a number chosen to fill 36% of the bar. A scarcity counter on a trust product
// is the one number that must not be decorative: it is a public commitment
// about how many seats are left, and it now counts the same `identity.seat`
// rows that the database's hard cap counts.

// Plan-key mapping (LINA-175). The translated `plansOwner` / `plansBuilder`
// arrays carry display copy only; the stable key each card checks out with
// lives here, positionally, and must stay in step with the message arrays.
// Keys are the paid subset of LINA-172's PLAN_KEYS — see PAID_PLAN_KEYS in
// `@/lib/pricing`. The free founding seat is NOT here: it has no card, it is
// claimed through the owner ribbon CTA (LINA-180), which hands `free_founding`
// to the waitlist form the same way a card CTA hands its paid key.
const OWNER_PLAN_KEYS: PaidPlanKey[] = ['personal', 'build_plus', 'real_estate_investor'];
const BUILDER_PLAN_KEYS: PaidPlanKey[] = [
  'independent_builder',
  'growing_builder',
  'construction_business'
];

function PlanCard({
  plan,
  planKey,
  perMonth,
  popular,
  popularLabel
}: {
  plan: Plan;
  planKey: PaidPlanKey;
  perMonth: string;
  popular: boolean;
  popularLabel: string;
}) {
  return (
    <article className="lp-plan" data-popular={popular ? 'true' : 'false'}>
      <div className="lp-plan__top">
        {popular && <span className="lp-plan__pop lp-micro">{popularLabel}</span>}

        <div className="lp-plan__head">
          <span className="lp-plan__ico" aria-hidden="true" />
          <div className="lp-plan__ht">
            <p className="lp-plan__name">{plan.name}</p>
            <p className="lp-plan__sub">{plan.sub}</p>
          </div>
        </div>

        <div className="lp-plan__price">
          <span className="p lp-display">{plan.price}</span>
          <span className="per lp-micro">{perMonth}</span>
        </div>

        <p className="lp-plan__proj lp-micro">{plan.proj}</p>

        <ul className="lp-plan__feats">
          {plan.plus && <li className="lp-plan__plus">{plan.plus}</li>}
          {plan.feats.map((feat) => (
            <li key={feat} className="lp-plan__feat">
              <CheckIcon className="lp-plan__check" />
              <span>{feat}</span>
            </li>
          ))}
        </ul>
      </div>

      <PlanCta plan={planKey} label={plan.name} className="lp-btn lp-plan__cta">
        {plan.cta}
      </PlanCta>
    </article>
  );
}

export async function SectionPricing() {
  const t = await getTranslations('lp.pricing');
  const seats = await foundingSeats();

  const plansOwner = t.raw('plansOwner') as Plan[];
  const plansBuilder = t.raw('plansBuilder') as Plan[];
  const coreItems = t.raw('core.items') as { t: string; d: string }[];
  const steps = t.raw('billing.steps') as string[];

  const labelBar = (
    <div className="lp-labelbar lp-micro">
      <span>06</span>
      <span>{t('label')}</span>
      <span className="rule" aria-hidden="true" />
      <span className="right" data-view="owner">
        {t('labelRightOwner')}
      </span>
      <span className="right" data-view="builder">
        {t('labelRightBuilder')}
      </span>
    </div>
  );

  const head = (
    <>
      <h2 className="lp-display lp-pricing__title">{t('title')}</h2>
      <p className="lp-pricing__sub">{t('sub')}</p>
    </>
  );

  const hints = (
    <>
      <span className="lp-pricing__hint" data-view="owner">
        {t('hintOwner')}
      </span>
      <span className="lp-pricing__hint-div" aria-hidden="true" />
      <span className="lp-pricing__hint" data-view="builder">
        {t('hintBuilder')}
      </span>
    </>
  );

  return (
    <section className="lp-section lp-section--dark lp-pricing" id="pricing">
      <div className="lp-wrap">
        <SectionPricingToggle
          labelBar={labelBar}
          head={head}
          hints={hints}
          ariaLabel={t('toggleAria')}
          toggle={{
            owner: { title: t('toggle.ownerTitle'), sub: t('toggle.ownerSub') },
            builder: { title: t('toggle.builderTitle'), sub: t('toggle.builderSub') }
          }}
        >
          {/* Owner panel — ribbon + plans. The tabpanel wrapper is what the
              toggle's Owner tab points at with aria-controls; CSS hides the
              inactive panel wholesale, so its contents leave the a11y tree. */}
          <div
            className="lp-pricing__panel"
            data-view="owner"
            id={pricingPanelId('owner')}
            role="tabpanel"
            aria-labelledby={pricingTabId('owner')}
          >
            <div className="lp-pricing__ribbon lp-pricing__ribbon--owner" data-view="owner">
              <div className="lp-ribbon__left">
                <div className="lp-ribbon__badges lp-micro">
                  <span className="lp-ribbon__badge lp-ribbon__badge--fill">
                    {t('ribbonOwner.badge1')}
                  </span>
                  <span className="lp-ribbon__badge">{t('ribbonOwner.badge2')}</span>
                </div>
                <p className="lp-ribbon__h lp-display">{t('ribbonOwner.h')}</p>
                <p className="lp-ribbon__s">{t('ribbonOwner.s')}</p>
              </div>
              <div className="lp-ribbon__right">
                <div className="lp-ribbon__count">
                  <span className="n lp-display">
                    {t('ribbonOwner.count', { claimed: seats.claimed, total: seats.total })}
                  </span>
                  <span className="x lp-micro">{t('ribbonOwner.countLabel')}</span>
                </div>
                <div
                  className="lp-ribbon__bar"
                  role="progressbar"
                  aria-valuenow={seats.claimed}
                  aria-valuemin={0}
                  aria-valuemax={seats.total}
                  aria-label={t('ribbonOwner.countLabel')}
                >
                  <span
                    className="lp-ribbon__fill"
                    style={{ width: `${(seats.claimed / seats.total) * 100}%` }}
                  />
                </div>
                <PlanCta
                  plan={FREE_FOUNDING_PLAN_KEY}
                  label={t('ribbonOwner.planLabel')}
                  className="lp-btn lp-ribbon__cta"
                >
                  {t('ribbonOwner.cta')}
                </PlanCta>
              </div>
            </div>

            <div className="lp-pricing__plans" data-view="owner">
              <p className="lp-pricing__plans-label lp-micro">{t('plansLabelOwner')}</p>
              <div className="lp-pricing__cards">
                {plansOwner.map((plan, i) => (
                  <PlanCard
                    key={plan.name}
                    plan={plan}
                    planKey={OWNER_PLAN_KEYS[i]}
                    perMonth={t('perMonth')}
                    popular={i === 1}
                    popularLabel={t('popular')}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Builder panel — same shape, builder ribbon + builder plans. */}
          <div
            className="lp-pricing__panel"
            data-view="builder"
            id={pricingPanelId('builder')}
            role="tabpanel"
            aria-labelledby={pricingTabId('builder')}
          >
            <div className="lp-pricing__ribbon lp-pricing__ribbon--builder" data-view="builder">
              <div className="lp-ribbon__left">
                <div className="lp-ribbon__badges lp-micro">
                  <span className="lp-ribbon__badge lp-ribbon__badge--fill">
                    {t('ribbonBuilder.badge1')}
                  </span>
                  <span className="lp-ribbon__badge">{t('ribbonBuilder.badge2')}</span>
                </div>
                <p className="lp-ribbon__h lp-display">{t('ribbonBuilder.h')}</p>
                <p className="lp-ribbon__s">{t('ribbonBuilder.s')}</p>
                <div className="lp-ribbon__chips lp-micro">
                  <span className="lp-ribbon__chip">{t('ribbonBuilder.chip1')}</span>
                  <span className="lp-ribbon__chip">{t('ribbonBuilder.chip2')}</span>
                </div>
              </div>
              <div className="lp-ribbon__right">
                <CtaLink
                  location="pricing"
                  href="#request-access"
                  className="lp-btn lp-ribbon__cta"
                >
                  {t('ribbonBuilder.cta')}
                </CtaLink>
                <p className="lp-ribbon__note lp-micro">{t('ribbonBuilder.note')}</p>
              </div>
            </div>

            <div className="lp-pricing__plans" data-view="builder">
              <p className="lp-pricing__plans-label lp-micro">{t('plansLabelBuilder')}</p>
              <div className="lp-pricing__cards">
                {plansBuilder.map((plan, i) => (
                  <PlanCard
                    key={plan.name}
                    plan={plan}
                    planKey={BUILDER_PLAN_KEYS[i]}
                    perMonth={t('perMonth')}
                    popular={i === 1}
                    popularLabel={t('popular')}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Core — shared. */}
          <div className="lp-pricing__core">
            <div className="lp-core__cell lp-core__cell--lead">
              <p className="lp-core__t">{t('core.title')}</p>
              <p className="lp-core__d">{t('core.desc')}</p>
            </div>
            {coreItems.map((item) => (
              <div className="lp-core__cell" key={item.t}>
                <p className="lp-core__t">{item.t}</p>
                <p className="lp-core__d">{item.d}</p>
              </div>
            ))}
          </div>

          {/* Billing / how-it-works — shared. */}
          <div className="lp-pricing__billing">
            <div className="lp-billing__side">
              <p className="lp-billing__t">{t('billing.leftTitle')}</p>
              <p className="lp-billing__d">{t('billing.leftDesc')}</p>
            </div>

            <div className="lp-billing__flow">
              <p className="lp-billing__ft lp-micro">{t('billing.flowTitle')}</p>
              <ol className="lp-billing__steps">
                {steps.map((step, i) => (
                  <li key={step} className="lp-billing__step">
                    <span className="s">{step}</span>
                    {i < steps.length - 1 && (
                      <span className="lp-billing__arrow" aria-hidden="true">
                        →
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>

            <div className="lp-billing__side">
              <p className="lp-billing__t">{t('billing.rightTitle')}</p>
              <p className="lp-billing__d">{t('billing.rightDesc')}</p>
            </div>
          </div>

          <p className="lp-pricing__foot lp-micro">{t('foot')}</p>
        </SectionPricingToggle>
      </div>
    </section>
  );
}
