import { getTranslations } from 'next-intl/server';
import { hasLandingImage } from '@/lib/landing-assets';
import {
  SEQUENCE_FINAL_KEYFRAME,
  SEQUENCE_IMAGE_HEIGHT,
  SEQUENCE_IMAGE_WIDTH,
  SEQUENCE_KEYFRAMES,
  SEQUENCE_ROW_KEYS,
  SEQUENCE_STAGES,
  formatSequenceHudCost
} from '@/lib/landing-numbers';
import { sequenceStateAt } from '@/lib/landing-sequence';
import { SequenceMotion } from './SequenceMotion';
import { SequenceTrack } from './SequenceTrack';

/**
 * The pinned scroll sequence — server-rendered at p = 1 (LINA-113).
 *
 * This markup IS the final state: stage-4 visible, four green bars, the HUD
 * filled with the three values. It is deliberately NOT the empty state.
 * <SequenceMotion /> reads this state out of the DOM, winds it back to p = 0,
 * and only then attaches the trigger — so no-JS, reduced-motion, save-data and
 * small-viewport visitors all get the finished house and the three numbers, and
 * a JS failure degrades to the most informative state rather than a blank screen.
 *
 * There is no `p` anywhere in this file. The only client code it mounts is the
 * motion component, which is inert until its own guard says otherwise.
 *
 * ASSETS (plan D2): the four stage stills are served as AVIF q50 at 1400w/700w
 * (the primary budget path, capped at the native 1402px) with WebP q70 as the
 * correctness fallback. Stage-4 is the server-visible p=1 frame, so it loads
 * `eager` with `fetchpriority="high"`; the other three are `lazy`. If an asset
 * is missing, `hasLandingImage()` withholds it and the section renders on the
 * ink ground with the scrim, bars and HUD intact — degraded, but readable,
 * correctly laid out, and still fully scrubbed.
 */

const AVIF_SIZES = '(min-width: 1400px) 1400px, 100vw';

export async function ScrollSequence({ locale }: { locale: string }) {
  const t = await getTranslations('lp.sequence');
  const kf = SEQUENCE_FINAL_KEYFRAME;
  // The p=1 state, resolved by the same pure module the animation runs on, so
  // the server's HTML and the animation's last frame cannot describe the row
  // differently. Every closed row's check sits at the x this state gives it.
  const final = sequenceStateAt(1);

  return (
    <section className="lp-sequence" id="the-sequence" aria-label={t('label')}>
      <div className="lp-sequence__images">
        {SEQUENCE_STAGES.map(({ stage, slug }) => {
          const visible = stage === kf.stage;
          return (
            <div
              key={slug}
              className="lp-sequence__stage"
              data-stage={stage}
              data-visible={visible ? 'true' : 'false'}
            >
              {hasLandingImage(`${slug}-1400`) && (
                <picture>
                  {/* AVIF q50 at the native 1402w (capped to 1400w) is the
                        budget primary; WebP q70 is the correctness fallback, not
                        the budget path. See technical plan D2. */}
                  <source
                    type="image/avif"
                    srcSet={`/images/${slug}-700.avif 700w, /images/${slug}-1400.avif 1400w`}
                    sizes={AVIF_SIZES}
                  />
                  <source
                    type="image/webp"
                    srcSet={`/images/${slug}-700.webp 700w, /images/${slug}-1400.webp 1400w`}
                    sizes={AVIF_SIZES}
                  />
                  <img
                    src={`/images/${slug}-1400.webp`}
                    alt=""
                    width={SEQUENCE_IMAGE_WIDTH}
                    height={SEQUENCE_IMAGE_HEIGHT}
                    decoding="async"
                    loading={stage === 4 ? 'eager' : 'lazy'}
                    fetchPriority={stage === 4 ? 'high' : 'auto'}
                  />
                </picture>
              )}
            </div>
          );
        })}
      </div>

      <div className="lp-sequence__scrim" aria-hidden="true" />

      {/* Content layer. `padding-top: var(--header-h)` lives here — the image
          layer above stays full-bleed and runs behind the translucent header,
          which is the intended look (technical plan D1). */}
      <div className="lp-sequence__content lp-wrap">
        {/* Caption, bars and HUD share one row. The pen's KF Body is 1440×260
            with the caption at x 72, the gantt at x 530 and the HUD at x 1170 —
            three columns on the stage's bottom edge, not a caption stacked above
            a panel row. */}
        <div className="lp-sequence__body">
          <div className="lp-sequence__caption">
            {/* All four captions are server-rendered; the final one (KF D) is
                visible. <SequenceMotion /> swaps which one shows as p advances —
                the copy itself lives here once, on the server, never re-authored. */}
            {SEQUENCE_KEYFRAMES.map((k) => (
              <div
                key={k.id}
                className="lp-sequence__caption-block"
                data-caption={k.id}
                data-visible={k.id === kf.id ? 'true' : 'false'}
              >
                <p className="micro lp-micro">{t(`captions.${k.id}.micro`)}</p>
                <p className="line">{t(`captions.${k.id}.line`)}</p>
              </div>
            ))}
          </div>

          <div className="lp-bars">
            <p className="lp-bars__head lp-micro">{t('barsHead')}</p>
            {SEQUENCE_ROW_KEYS.map((rowKey) => {
              const row = final.rows[rowKey];
              return (
                <div
                  className="lp-bars__row"
                  key={rowKey}
                  data-closed={row.phase === 'closed' ? 'true' : 'false'}
                >
                  <span className="name">{t(`rows.${rowKey}`)}</span>
                  <SequenceTrack rowKey={rowKey} row={row} checkX={row.checkX} />
                </div>
              );
            })}
          </div>

          {/* Three readings, all four keyframes' worth server-rendered and
              stacked. The LABEL moves with the value — the pen relabels the
              middle cell BUDGET → SPENT → FINAL as the build goes from a
              forecast to a running total to a closed one — so the label is a
              per-keyframe span too, not a fixed heading with a swapping value
              underneath it. */}
          <dl className="lp-hud" data-tone={kf.hud.tone}>
            {(['time', 'cost', 'scope'] as const).map((cell) => (
              <div className="lp-hud__cell" key={cell}>
                <dt className="label lp-micro">
                  {SEQUENCE_KEYFRAMES.map((k) => (
                    <span key={k.id} data-kf={k.id} data-visible={k.id === kf.id ? 'true' : 'false'}>
                      {cell === 'cost' ? t(`hud.cost.${k.hud.cost.label}`) : t(`hud.${cell}`)}
                    </span>
                  ))}
                </dt>
                <dd className="value">
                  {SEQUENCE_KEYFRAMES.map((k) => (
                    <span key={k.id} data-kf={k.id} data-visible={k.id === kf.id ? 'true' : 'false'}>
                      {cell === 'cost'
                        ? formatSequenceHudCost(k.id, locale)
                        : t(`hud.readings.${k.id}.${cell}`)}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <SequenceMotion />
    </section>
  );
}