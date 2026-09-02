import { getTranslations } from 'next-intl/server';
import { hasLandingImage } from '@/lib/landing-assets';

// 05 · Who It Is For — Marta (owner) and João (builder).
//
// These replace the four audience cards from LINA-34/46. The old
// `audience_card_click {persona}` event is deliberately NOT wired here: the
// element and the persona set have both changed, and whether that event is
// remapped or renamed is LINA-83 blocker (b). Guessing costs a rename.
//
// ASSET: the two portraits are the pen's `S6 Who It Is For / Row / {Marta,
// João} / Portrait / Photo` fills, encoded by scripts/encode-landing-images.mjs
// at 320w/640w. `hasLandingImage` still guards them: if the derived files are
// ever missing the portrait falls back to the ink ground with the scrim, so the
// quote and identity stay readable.

const PORTRAIT_SIZES = '(min-width: 940px) 460px, 90vw';

const PERSONAS = [
  { key: 'marta', slug: 'persona-marta', tick: 'var(--plan-baseline)', traits: ['t1', 't2', 't3'] },
  { key: 'joao', slug: 'persona-joao', tick: 'var(--plan-actual)', traits: ['t1', 't2', 't3'] }
] as const;

export async function SectionWho() {
  const t = await getTranslations('lp.who');

  return (
    <section className="lp-section lp-who" id="who-it-is-for">
      <div className="lp-wrap">
        <div className="lp-labelbar lp-micro">
          <span>05</span>
          <span>{t('label')}</span>
          <span className="rule" aria-hidden="true" />
          <span className="right">{t('labelRight')}</span>
        </div>

        <div className="lp-personas">
          {PERSONAS.map((p) => (
            <article key={p.key}>
              <div className="lp-persona__portrait">
                {hasLandingImage(`${p.slug}-640`) && (
                  <picture>
                    <source
                      type="image/avif"
                      srcSet={`/images/${p.slug}-320.avif 320w, /images/${p.slug}-640.avif 640w`}
                      sizes={PORTRAIT_SIZES}
                    />
                    <source
                      type="image/webp"
                      srcSet={`/images/${p.slug}-320.webp 320w, /images/${p.slug}-640.webp 640w`}
                      sizes={PORTRAIT_SIZES}
                    />
                    <img
                      src={`/images/${p.slug}-640.webp`}
                      alt={t(`${p.key}.alt`)}
                      loading="lazy"
                      decoding="async"
                    />
                  </picture>
                )}
                <div className="scrim" aria-hidden="true" />
                <div className="lp-persona__overlay">
                  <blockquote className="lp-persona__quote">{t(`${p.key}.quote`)}</blockquote>
                  <div className="lp-persona__id">
                    <span className="tick" style={{ background: p.tick }} aria-hidden="true" />
                    <span>
                      <span className="name">{t(`${p.key}.name`)}</span>
                      <span className="role lp-micro" style={{ display: 'block' }}>
                        {t(`${p.key}.role`)}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
              <ul className="lp-persona__traits lp-micro">
                {p.traits.map((trait) => (
                  <li key={trait}>{t(`${p.key}.traits.${trait}`)}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
