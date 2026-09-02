import { getTranslations } from 'next-intl/server';
import type { CSSProperties } from 'react';
import {
  GANTT_MONTHS,
  GANTT_TRACK_UNITS,
  WORK_PACKAGE_ROWS,
  formatEur,
  formatEurDelta
} from '@/lib/landing-numbers';
import { PlanTrack } from './PlanTrack';
import { RevealOnScroll } from './RevealOnScroll';
import { ScrollSequence } from './ScrollSequence';

// 02 · The Record — blue agreed / orange changed / green closed and the gantt
// the whole encoding is about. The six package values sum to the contract
// total by construction (see landing-numbers.ts).
//
// Order follows the pen's frame: encoding row, then the Scroll Reel, then the
// gantt, with the legend as a sibling after the card.
//
// The reel slot is the pinned scroll sequence, not a static four-up row. The
// pen's `Scroll Reel` frame draws four cards because a static design file can
// only draw the four stills side by side; `key-frames` is the frame that says
// what those stills actually do — one pinned section, ~300vh mapped to
// p ∈ [0,1], the four plates cross-fading under the bars and the HUD. Shipping
// the row *and* the sequence gave the page the same four photographs twice and
// turned the argument into the slideshow the coupling note warns about, so the
// row is gone and the sequence lives here, in the reel's slot, between the
// encoding row and the gantt it is coupled to.
//
// The sequence is a sibling of the two `.lp-wrap` blocks rather than a child:
// its image layer is full-bleed, and ScrollTrigger pins it in place here.

const LEGEND = ['baseline', 'actual', 'closed'] as const;
const LEGEND_FILL: Record<(typeof LEGEND)[number], string> = {
  baseline: 'var(--plan-baseline)',
  actual: 'var(--plan-actual)',
  closed: 'var(--plan-closed)'
};

export async function SectionRecord({ locale }: { locale: string }) {
  const t = await getTranslations('lp.record');

  return (
    <section className="lp-section lp-section--dark lp-record" id="the-record">
      <div className="lp-wrap">
        <div className="lp-labelbar lp-micro">
          <span>02</span>
          <span>{t('label')}</span>
          <span className="rule" aria-hidden="true" />
          <span className="right">{t('labelRight')}</span>
        </div>

        <div className="lp-record__row">
          <h2 className="lp-display lp-record__encoding">
            <span className="baseline">{t('agreed')}</span>
            <span className="actual">{t('changed')}</span>
            <span className="closed">{t('closed')}</span>
          </h2>
          <div className="lp-record__explainer">
            <p className="copy">{t('explainer')}</p>
            <p className="note lp-micro">{t('note')}</p>
            <p className="body body--mobile">{t('explainerMobile')}</p>
          </div>
        </div>

        <header className="lp-reel__head">
          <span className="lp-reel__index lp-reel__index--desktop">{t('reel.index')}</span>
          <span className="lp-reel__index lp-reel__index--mobile">{t('reel.indexMobile')}</span>
          <span className="lp-reel__title lp-reel__title--desktop">{t('reel.title')}</span>
          <span className="lp-reel__title lp-reel__title--mobile">{t('reel.titleMobile')}</span>
          <span className="rule" aria-hidden="true" />
        </header>
      </div>

      <ScrollSequence locale={locale} />

      <div className="lp-wrap">
        <RevealOnScroll variant="gantt">
          <div className="lp-gantt">
            <table>
              <caption className="lp-skip">{t('tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="lp-micro">
                    {t('colPackage')}
                  </th>
                  <th scope="col" className="months">
                    <div className="lp-gantt__months lp-micro">
                      {GANTT_MONTHS.map((m) => (
                        <span key={m}>{t(`months.${m}`)}</span>
                      ))}
                    </div>
                  </th>
                  <th scope="col" className="value lp-micro">
                    {t('colValue')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {WORK_PACKAGE_ROWS.map((row, i) => (
                  <tr key={row.key} style={{ '--delay': `${i * 150}ms` } as CSSProperties}>
                    <th scope="row" className="name">
                      {t(`packages.${row.key}`)}
                    </th>
                    <td>
                      <PlanTrack
                        rowKey={`gantt-${row.key}`}
                        trackUnits={GANTT_TRACK_UNITS}
                        laneHeight={9}
                        laneGap={5}
                        planned={{ offset: row.plannedOffset, width: row.plannedWidth }}
                        actual={{ offset: row.actualOffset, width: row.actualWidth, state: row.state }}
                      />
                    </td>
                    <td className="value">
                      <b>{formatEur(row.value, locale)}</b>
                      {row.delta !== undefined && (
                        <span className="delta lp-micro">{formatEurDelta(row.delta, locale)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="lp-gantt__legend lp-micro">
            {LEGEND.map((key, i) => (
              <li key={key} style={{ '--li': `${i * 160}ms` } as CSSProperties}>
                <span className="swatch" style={{ background: LEGEND_FILL[key] }} aria-hidden="true" />
                {t(`legend.${key}`)}
              </li>
            ))}
            <li className="audit">{t('legend.audit')}</li>
          </ul>
        </RevealOnScroll>
      </div>
    </section>
  );
}