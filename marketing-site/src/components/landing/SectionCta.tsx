import { getTranslations } from 'next-intl/server';
import { WaitlistForm } from '@/components/WaitlistForm';
import {
  CONTRACT_TOTAL,
  MATERIALS_DELTA_SINCE_MARCH,
  PHONE_PREVIEW,
  SEQUENCE_LANE_HEIGHT,
  SEQUENCE_TRACK_UNITS,
  formatEur,
  formatEurDelta
} from '@/lib/landing-numbers';
import { PlanTrack } from './PlanTrack';

// CTA — "stop arguing from memory", plus the phone preview.
//
// The phone shows the same build at the same moment as the rest of the page:
// the contract total and the March movement come from the numbers module, and
// its four bars use the same PlanTrack the pinned sequence uses, at the phone
// frame's 6px lanes rather than the desktop 7px.

const PHONE_ROWS = [
  { key: 'foundations', planned: { offset: 0, width: 30 }, actual: { offset: 0, width: 30, state: 'closed' as const } },
  { key: 'structure', planned: { offset: 30, width: 40 }, actual: { offset: 30, width: 40, state: 'closed' as const } },
  { key: 'envelope', planned: { offset: 70, width: 40 }, actual: { offset: 70, width: 40, state: 'closed' as const } },
  { key: 'finishes', planned: { offset: 110, width: 50 }, actual: { offset: 120, width: 40, state: 'actual' as const } }
];

/** The phone frame's track is 160 units wide, not the sequence's 320. */
const PHONE_TRACK_UNITS = SEQUENCE_TRACK_UNITS / 2;

export async function SectionCta({ locale, source }: { locale: string; source: string }) {
  const t = await getTranslations('lp.cta');
  const tp = await getTranslations('lp.phone');

  return (
    <section className="lp-cta" id="request-access">
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
            <span aria-hidden="true">▮</span>
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
          {PHONE_ROWS.map((row) => (
            <div className="lp-phone__row" key={row.key}>
              <p className="n">{tp(`rows.${row.key}`)}</p>
              <PlanTrack
                rowKey={`phone-${row.key}`}
                trackUnits={PHONE_TRACK_UNITS}
                laneHeight={SEQUENCE_LANE_HEIGHT - 1}
                laneGap={2}
                planned={row.planned}
                actual={row.actual}
              />
            </div>
          ))}
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
