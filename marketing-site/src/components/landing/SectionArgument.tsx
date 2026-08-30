import { getTranslations } from 'next-intl/server';
import { CONTRACT_TOTAL, ORIGINAL_QUOTE, formatEur } from '@/lib/landing-numbers';

// 01 · The Argument — "nobody is lying, nothing is written down".
// The two figures come from the numbers module and are injected into the copy
// as ICU values, so pt/es cannot drift from the euro amounts the rest of the
// page uses.

// The thread quotes both figures back, so its lines are translated keys with
// ICU placeholders rather than a raw array — a raw array would let the numbers
// be retyped per locale, which is exactly the failure this page cannot have.
const THREAD = [
  { key: 'thread1', from: 'owner' },
  { key: 'thread2', from: 'builder' },
  { key: 'thread3', from: 'owner' }
] as const;

export async function SectionArgument({ locale }: { locale: string }) {
  const t = await getTranslations('lp.argument');
  const values = {
    quote: formatEur(ORIGINAL_QUOTE, locale),
    total: formatEur(CONTRACT_TOTAL, locale)
  };

  return (
    <section className="lp-section lp-argument" id="the-argument">
      <div className="lp-wrap">
        <div className="lp-labelbar lp-micro">
          <span>01</span>
          <span>{t('label')}</span>
          <span className="rule" aria-hidden="true" />
          <span className="right">{t('labelRight')}</span>
        </div>

        <div className="lp-argument__row">
          <div>
            <h2 className="lp-display">
              {t('headline', values)}
              <span className="accent">{t('headlineAccent', values)}</span>
            </h2>
            <p className="lp-argument__sub">{t('sub')}</p>
          </div>

          <div>
            <div className="lp-thread">
              {THREAD.map(({ key, from }) => (
                <p key={key} className={`lp-thread__bubble lp-thread__bubble--${from}`}>
                  {t(key, values)}
                </p>
              ))}
            </div>
            <p className="lp-thread__caption lp-micro">{t('threadCaption')}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
