import { getTranslations } from 'next-intl/server';
import {
  GANTT_MONTHS,
  GANTT_TRACK_UNITS,
  WORK_PACKAGE_ROWS,
  formatEur,
  formatEurDelta
} from '@/lib/landing-numbers';
import { PlanTrack } from './PlanTrack';

// 02 · The Record — blue agreed / orange changed / green closed, then the gantt
// that the whole encoding is about. The six package values sum to the contract
// total by construction (see landing-numbers.ts).

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
            <p>{t('explainer')}</p>
            <p className="note lp-micro">{t('note')}</p>
          </div>
        </div>

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
              {WORK_PACKAGE_ROWS.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className="name">
                    {t(`packages.${row.key}`)}
                  </th>
                  <td>
                    <PlanTrack
                      rowKey={row.key}
                      trackUnits={GANTT_TRACK_UNITS}
                      laneHeight={9}
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

          <ul className="lp-gantt__legend lp-micro">
            {LEGEND.map((key) => (
              <li key={key}>
                <span className="swatch" style={{ background: LEGEND_FILL[key] }} aria-hidden="true" />
                {t(`legend.${key}`)}
              </li>
            ))}
            <li className="audit">{t('legend.audit')}</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
