import { getTranslations } from 'next-intl/server';
import type { CSSProperties } from 'react';
import { SCROLL_REEL_STAGES } from '@/lib/landing-numbers';
import { hasLandingImage } from '@/lib/landing-assets';

/**
 * The Scroll Reel (S3 of `landing-page`): four stage cards, each showing the
 * build photo at its stage, a `p` chip (0.15 / 0.40 / 0.72 / 1.00 — the same
 * progress the gantt tracks), and a caption. One shared note per breakpoint:
 * "The image and the chart move together." on desktop, "Moves with the gant."
 * on mobile.
 *
 * Cards stay server-rendered (no JS): when the still is in `public/images`
 * (`hasLandingImage`) the photo is light-loaded via `<picture>`; before then
 * the card's ink ground carries the same chip and caption, exactly the pen's
 * layout. `--d` is the stagger delay the reveal reads (landing.css).
 */
export async function ScrollReel() {
  const t = await getTranslations('lp.record');

  return (
    <div className="lp-reel">
      <header className="lp-reel__head">
        <span className="lp-reel__index lp-reel__index--desktop">{t('reel.index')}</span>
        <span className="lp-reel__index lp-reel__index--mobile">{t('reel.indexMobile')}</span>
        <span className="lp-reel__title lp-reel__title--desktop">{t('reel.title')}</span>
        <span className="lp-reel__title lp-reel__title--mobile">{t('reel.titleMobile')}</span>
        <span className="rule" aria-hidden="true" />
      </header>

      <div className="lp-reel__cards">
        {SCROLL_REEL_STAGES.map((stage, i) => (
          <figure
            key={stage.slug}
            className="lp-reel__card"
            style={{ '--d': `${i * 90}ms` } as CSSProperties}
          >
            {hasLandingImage(`${stage.slug}-700`) && (
              <picture className="lp-reel__img">
                <source
                  type="image/avif"
                  srcSet={`/images/${stage.slug}-700.avif 700w, /images/${stage.slug}-1400.avif 1400w`}
                  sizes="(min-width: 940px) 400px, (min-width: 480px) 240px, 90vw"
                />
                <source
                  type="image/webp"
                  srcSet={`/images/${stage.slug}-700.webp 700w, /images/${stage.slug}-1400.webp 1400w`}
                  sizes="(min-width: 940px) 400px, (min-width: 480px) 240px, 90vw"
                />
                <img
                  src={`/images/${stage.slug}-700.webp`}
                  alt={t(`reel.alt.${stage.stage}`)}
                  loading="lazy"
                  decoding="async"
                  width={700}
                  height={560}
                  fetchPriority="low"
                />
              </picture>
            )}
            <span className="lp-reel__scrim" aria-hidden="true" />
            <span className="lp-reel__chip">{`p ${stage.p.toFixed(2)}`}</span>
            <figcaption className="lp-reel__caption">
              <span className="lp-reel__stage">{t(`reel.labels.${stage.stage}`)}</span>
              <span className="lp-reel__note lp-reel__note--desktop">{t('reel.note')}</span>
              <span className="lp-reel__note lp-reel__note--mobile">{t('reel.noteMobile')}</span>
            </figcaption>
          </figure>
        ))}
      </div>

      <p className="lp-reel__scroll-note">{t('reel.scrollNote')}</p>
    </div>
  );
}