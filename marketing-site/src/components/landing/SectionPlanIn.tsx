import { Fragment } from 'react';
import { getTranslations } from 'next-intl/server';
import {
  CONTRACT_TOTAL,
  PLAN_FILENAME,
  PLAN_TABLE,
  ROWS_READ,
  SUB_TASKS,
  WORK_PACKAGES,
  formatEur,
  formatNumber
} from '@/lib/landing-numbers';
import { ArrowRightIcon, FileIcon, SparkIcon } from './icons';
import { NavLink } from './NavLink';

// 03 · Getting The Plan In — upload the spreadsheet you already quoted with.
// Every figure in the parsed-plan table (sub-task totals, package totals, the
// grand total, the row/package/sub-task counts) comes from the numbers module.

const STEPS = ['01', '02', '03'] as const;

export async function SectionPlanIn({ locale }: { locale: string }) {
  const t = await getTranslations('lp.planIn');

  return (
    <section className="lp-section lp-planin" id="getting-the-plan-in">
      <div className="lp-wrap">
        <div className="lp-labelbar lp-micro">
          <span>03</span>
          <span>{t('label')}</span>
          <span className="rule" aria-hidden="true" />
          <span className="right">{t('labelRight')}</span>
        </div>

        <div className="lp-planin__row">
          <div>
            <h2 className="lp-display">{t('headline')}</h2>
            <p className="lp-planin__sub">{t('sub')}</p>
            <ol className="lp-steps">
              {STEPS.map((n) => (
                <li key={n}>
                  <span className="lp-micro">{n}</span>
                  <span>
                    <span className="t">{t(`steps.${n}.t`)}</span>
                    <span className="d">{t(`steps.${n}.d`)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="lp-parsed">
            <div className="lp-parsed__filebar">
              <span style={{ color: 'var(--plan-closed)', display: 'inline-flex' }}>
                <FileIcon />
              </span>
              <span className="fname">{PLAN_FILENAME}</span>
              <span className="rows lp-micro">{t('rowsRead', { rows: formatNumber(ROWS_READ, locale) })}</span>
              <span className="lp-chip lp-micro">{t('columnsMapped')}</span>
            </div>

            <table>
              <caption className="lp-skip">{t('tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('colPackage')}</th>
                  <th scope="col" className="num">
                    {t('colQty')}
                  </th>
                  <th scope="col">{t('colUnit')}</th>
                  <th scope="col" className="num">
                    {t('colUnitPrice')}
                  </th>
                  <th scope="col" className="num">
                    {t('colTotal')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {PLAN_TABLE.map((group) => (
                  <Fragment key={group.key}>
                    <tr className="group">
                      <th scope="rowgroup" className="name">
                        {t(`packages.${group.key}`)}
                      </th>
                      <td className="num" />
                      <td />
                      <td className="num" />
                      <td className="num">{formatEur(group.total, locale)}</td>
                    </tr>
                    {group.rows.map((row) => (
                      <tr className="sub" key={row.key}>
                        <td className="name">{t(`rows.${row.key}`)}</td>
                        <td className="num">{formatNumber(row.qty, locale)}</td>
                        <td>{row.unit}</td>
                        <td className="num">{formatEur(row.unitPrice, locale)}</td>
                        <td className="num">{formatEur(row.total, locale)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>

            <div className="lp-parsed__foot">
              <span className="label lp-micro">
                {t('foot', { packages: WORK_PACKAGES, subTasks: SUB_TASKS })}
              </span>
              <span className="grand">{formatEur(CONTRACT_TOTAL, locale)}</span>
            </div>
          </div>
        </div>

        <div className="lp-band">
          <SparkIcon />
          <p>{t('band')}</p>
          <NavLink className="lp-micro" href="#the-record" target="s03_handshake">
            {t('bandLink')}
            <ArrowRightIcon size={12} />
          </NavLink>
        </div>
      </div>
    </section>
  );
}
