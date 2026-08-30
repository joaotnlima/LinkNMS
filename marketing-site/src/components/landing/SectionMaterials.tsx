import { getTranslations } from 'next-intl/server';
import {
  BUDGET_COMPOSITION,
  CONTRACT_TOTAL,
  MATERIALS,
  MATERIALS_DELTA_SINCE_MARCH,
  MATERIALS_SHARE_PCT,
  MATERIAL_SWAP,
  MATERIAL_SWAP_FROM_TOTAL,
  MATERIAL_SWAP_SAVING,
  MATERIAL_SWAP_TO_TOTAL,
  formatEur,
  formatEurDelta,
  formatNumber
} from '@/lib/landing-numbers';
import { DotFilledIcon, DotIcon } from './icons';

// 04 · Materials & Money — half the budget is a material decision.
//
// The composition bar's five slices sum to the contract total by construction:
// the last slice is derived as the remainder (see landing-numbers.ts, where the
// four-euro discrepancy in the design frame is documented). Slice widths are
// therefore percentages of a total that is guaranteed to be 100%.

const SLICE_TINT: Record<string, string> = {
  structure: '#fbfaf7e6',
  envelope: '#fbfaf7b3',
  mep: '#fbfaf773',
  finishes: '#fbfaf74d'
};

export async function SectionMaterials({ locale }: { locale: string }) {
  const t = await getTranslations('lp.materials');
  const swapDate = new Date(MATERIAL_SWAP.approvedOn);

  return (
    <section className="lp-section lp-section--dark lp-materials" id="materials-and-money">
      <div className="lp-wrap">
        <div className="lp-labelbar lp-micro">
          <span>04</span>
          <span>{t('label')}</span>
          <span className="rule" aria-hidden="true" />
          <span className="right">{t('labelRight')}</span>
        </div>

        <div className="lp-materials__row">
          <div>
            <h2 className="lp-display">{t('headline')}</h2>
            <div className="lp-materials__body">
              <p>{t('body')}</p>
              <p>{t('body2')}</p>
            </div>
          </div>

          <div className="lp-swap">
            <div className="lp-swap__head">
              <span className="title">{t('swap.title')}</span>
              <span className="lp-chip lp-micro">{t('swap.chip')}</span>
            </div>

            <div className="lp-swap__line lp-swap__line--from">
              <span style={{ color: 'var(--lp-cream-40)', display: 'inline-flex' }}>
                <DotIcon />
              </span>
              <span className="text">
                <span className="n">{t('swap.from')}</span>
                <span className="p lp-micro">
                  {t('swap.unitLine', {
                    price: formatEur(MATERIAL_SWAP.from.unitPrice, locale),
                    unit: MATERIAL_SWAP.unit,
                    area: formatNumber(MATERIAL_SWAP.area, locale)
                  })}
                </span>
              </span>
              <span className="tot">{formatEur(MATERIAL_SWAP_FROM_TOTAL, locale)}</span>
            </div>

            <div className="lp-swap__line lp-swap__line--to">
              <span style={{ color: 'var(--plan-actual)', display: 'inline-flex' }}>
                <DotFilledIcon />
              </span>
              <span className="text">
                <span className="n">{t('swap.to')}</span>
                <span className="p lp-micro">
                  {t('swap.unitLine', {
                    price: formatEur(MATERIAL_SWAP.to.unitPrice, locale),
                    unit: MATERIAL_SWAP.unit,
                    area: formatNumber(MATERIAL_SWAP.area, locale)
                  })}
                </span>
              </span>
              <span className="tot">{formatEur(MATERIAL_SWAP_TO_TOTAL, locale)}</span>
            </div>

            <div className="lp-swap__delta">
              <span className="avatar" aria-hidden="true" />
              <span className="by">
                {t('swap.approved', {
                  name: MATERIAL_SWAP.approvedBy,
                  when: new Intl.DateTimeFormat(locale, {
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit'
                  }).format(swapDate)
                })}
              </span>
              {/* A swap that lowers the cost is a saving: shown as a negative
                  delta in the closed-green, matching the design. */}
              <span className="amount">{formatEurDelta(-MATERIAL_SWAP_SAVING, locale)}</span>
            </div>
          </div>
        </div>

        <div className="lp-composition">
          <div className="lp-composition__head lp-micro">
            <span>{t('composition.head', { total: formatEur(CONTRACT_TOTAL, locale) })}</span>
            <span className="right">
              {t('composition.headRight', { pct: formatNumber(MATERIALS_SHARE_PCT, locale) })}
            </span>
          </div>

          <div
            className="lp-composition__bar"
            role="img"
            aria-label={t('composition.aria', {
              total: formatEur(CONTRACT_TOTAL, locale),
              materials: formatEur(MATERIALS, locale),
              pct: formatNumber(MATERIALS_SHARE_PCT, locale)
            })}
          >
            {BUDGET_COMPOSITION.map((slice) => (
              <span
                key={slice.key}
                style={{
                  flex: `${slice.value} 0 0`,
                  background: slice.highlight ? 'var(--plan-actual)' : SLICE_TINT[slice.key]
                }}
              />
            ))}
          </div>

          <ul className="lp-composition__legend lp-micro">
            {BUDGET_COMPOSITION.map((slice) => (
              <li key={slice.key} data-highlight={slice.highlight ? 'true' : 'false'}>
                <span className="n">{t(`composition.slices.${slice.key}`)}</span>
                <span className="v">
                  {formatEur(slice.value, locale)}
                  {slice.highlight &&
                    `  ${t('composition.sinceMarch', {
                      delta: formatEurDelta(MATERIALS_DELTA_SINCE_MARCH, locale)
                    })}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
