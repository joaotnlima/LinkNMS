import { getTranslations } from 'next-intl/server';
import { WaitlistForm } from '@/components/WaitlistForm';
import { hasLandingImage } from '@/lib/landing-assets';
import {
  CONTRACT_TOTAL,
  MATERIALS_DELTA_SINCE_MARCH,
  PHONE_PREVIEW,
  PHONE_TRACK_UNITS,
  PHONE_CLOSED_BASELINE_OPACITY,
  TRACK_LANE_HEIGHT,
  formatEur,
  formatEurDelta
} from '@/lib/landing-numbers';
import { PlanTrack } from './PlanTrack';

// CTA — "stop arguing from memory", plus the phone preview.
//
// The phone shows the same build at the same moment as the rest of the page:
// the contract total and the March movement come from the numbers module, and
// its four bars use the same PlanTrack the gantt uses, at the phone frame's
// 6px lanes rather than the gantt's 9px.
//
// The photo background is the `stage-4-house-built` still, the same one the
// Scroll Reel ends on — the CTA is the finished build folded into the ask.
// It loads lazily (below the fold, LINA-89 deferral policy) behind a scrim that
// is darkest where the copy sits. The scrim and ghost sit between the photo and
// the content, so the copy stays legible over the photograph.

const PHONE_ROWS = [
  { key: 'foundations', planned: { offset: 0, width: 30 }, actual: { offset: 0, width: 30, state: 'closed' as const } },
  { key: 'structure', planned: { offset: 30, width: 40 }, actual: { offset: 30, width: 40, state: 'closed' as const } },
  { key: 'envelope', planned: { offset: 70, width: 40 }, actual: { offset: 70, width: 40, state: 'closed' as const } },
  { key: 'finishes', planned: { offset: 110, width: 50 }, actual: { offset: 120, width: 40, state: 'actual' as const } }
];

/** The phone frame's track is 160 units wide, not the 320-unit phone track. */
const PHONE_TRACK_UNITS_160 = PHONE_TRACK_UNITS / 2;

export async function SectionCta({ locale, source }: { locale: string; source: string }) {
  const t = await getTranslations('lp.cta');
  const tp = await getTranslations('lp.phone');

  const CTA_AVIF_SIZES = '(min-width: 980px) 1400px, 100vw';

  return (
    <section className="lp-cta" id="request-access">
      {hasLandingImage('stage-4-house-built-1400') && (
        <picture className="lp-cta__photo">
          {/* AVIF q50 at the native 1402w (capped to 1400w) is the budget primary;
              WebP q70 is the correctness fallback, same as the Scroll Reel. */}
          <source
            type="image/avif"
            srcSet="/images/stage-4-house-built-700.avif 700w, /images/stage-4-house-built-1400.avif 1400w"
            sizes={CTA_AVIF_SIZES}
          />
          <source
            type="image/webp"
            srcSet="/images/stage-4-house-built-700.webp 700w, /images/stage-4-house-built-1400.webp 1400w"
            sizes={CTA_AVIF_SIZES}
          />
          <img
            src="/images/stage-4-house-built-1400.webp"
            alt=""
            width={1400}
            height={1120}
            decoding="async"
            loading="lazy"
            fetchPriority="low"
          />
        </picture>
      )}
      <span className="lp-cta__scrim" aria-hidden="true" />

      <span className="lp-cta__ghost" aria-hidden="true">
        LINKNMS
      </span>

      <div className="lp-cta__inner lp-wrap">
        <div>
          <p className="lp-micro">{t('kicker')}</p>
          <h2 className="lp-display">{t('headline')}</h2>
          <p className="lp-cta__sub">{t('sub')}</p>
          <WaitlistForm source={source} />
        </div>

        <div className="lp-phone" role="img" aria-label={tp('aria')}>
          <div className="lp-phone__status">
            <span>9:41</span>
            <span className="lp-phone__island" aria-hidden="true" />
            <span className="lp-phone__battery" aria-hidden="true" />
          </div>
          <p className="lp-phone__build">{PHONE_PREVIEW.buildName}</p>
          <p className="lp-phone__week">
            {tp('week', { week: PHONE_PREVIEW.week, total: PHONE_PREVIEW.totalWeeks })}
          </p>
          <div className="lp-phone__seg" aria-hidden="true">
            <span data-active="true">{tp('tabs.schedule')}</span>
            <span>{tp('tabs.money')}</span>
            <span>{tp('tabs.history')}</span>
          </div>
          <div className="lp-phone__bars">
            {PHONE_ROWS.map((row) => {
              const open = row.actual.state !== 'closed';
              return (
                <div className="lp-phone__row" key={row.key} data-open={open ? 'true' : 'false'}>
                  <p className="n">{tp(`rows.${row.key}`)}</p>
                  <PlanTrack
                    rowKey={`phone-${row.key}`}
                    trackUnits={PHONE_TRACK_UNITS_160}
                    // Pen: 6px lanes, 3px apart — the shared gap default.
                    laneHeight={TRACK_LANE_HEIGHT - 1}
                    planned={row.planned}
                    actual={row.actual}
                    // Same rule the sequence ends on: once a row has closed, the
                    // blue baseline drops to 35% — still on the record, no longer
                    // the thing being read. The open row keeps its baseline full,
                    // because that is the bar the slip is measured against.
                    baselineOpacity={open ? 1 : PHONE_CLOSED_BASELINE_OPACITY}
                  />
                </div>
              );
            })}
          </div>
          <div className="lp-phone__money">
            <span>
              <span className="ml lp-micro" style={{ display: 'block' }}>
                {tp('contractTotal')}
              </span>
              <span className="md">
                {tp('sinceMarch', { delta: formatEurDelta(MATERIALS_DELTA_SINCE_MARCH, locale) })}
              </span>
            </span>
            <span className="mv">{formatEur(CONTRACT_TOTAL, locale)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
