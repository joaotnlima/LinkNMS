import { getTranslations } from 'next-intl/server';
import { hasLandingImage } from '@/lib/landing-assets';
import {
  SEQUENCE_CLOSED_BASELINE_OPACITY,
  SEQUENCE_FINAL_KEYFRAME,
  SEQUENCE_IMAGE_HEIGHT,
  SEQUENCE_IMAGE_WIDTH,
  SEQUENCE_KEYFRAMES,
  SEQUENCE_LANE_HEIGHT,
  SEQUENCE_PLANNED,
  SEQUENCE_ROW_KEYS,
  SEQUENCE_STAGES,
  SEQUENCE_TRACK_UNITS,
  formatSequenceHudCost
} from '@/lib/landing-numbers';
import { PlanTrack } from './PlanTrack';
import { SequenceMotion } from './SequenceMotion';

/**
 * The pinned scroll sequence — server-rendered at p = 1.
 *
 * This markup IS the final state: stage-4 visible, four green bars, the HUD
 * filled with the three values. It is deliberately NOT the empty state.
 * <SequenceMotion /> (LINA-89) reads this state out of the DOM, winds it back to
 * p = 0, and only then attaches the trigger — so no-JS, reduced-motion,
 * save-data and small-viewport visitors all get the finished house and the three
 * numbers, and a JS failure degrades to the most informative state rather than a
 * blank screen.
 *
 * There is no `p` anywhere in this file. The only client code it mounts is the
 * motion component, which is inert until its own guard says otherwise.
 *
 * ASSETS: the four stage stills are not in the repo yet (LINA-89 blocker).
 * The <picture> below points at the paths they will occupy. Until they land the
 * images are omitted entirely and the section renders on the ink ground with the
 * scrim, bars and HUD intact — degraded, but readable, correctly laid out, and
 * still fully scrubbed.
 */

const AVIF_SIZES = '(min-width: 1400px) 1400px, 100vw';

export async function ScrollSequence({ locale }: { locale: string }) {
  const t = await getTranslations('lp.sequence');
  const kf = SEQUENCE_FINAL_KEYFRAME;

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
                    // Every stage is below the fold at page load — the sequence
                    // is the fourth section — so none of them earn an eager,
                    // high-priority fetch that would delay first meaningful
                    // paint. Stage 4 (the server-visible p=1 frame) loads lazily
                    // like the rest; a no-JS or reduced-motion visitor reaches it
                    // after scrolling into the section regardless (LINA-89 perf).
                    loading="lazy"
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

        <div className="lp-sequence__panels">
          <div className="lp-bars">
            <p className="lp-bars__head lp-micro">{t('barsHead')}</p>
            {SEQUENCE_ROW_KEYS.map((rowKey) => {
              const row = kf.rows[rowKey];
              const closed = row.state === 'closed';
              return (
                <div className="lp-bars__row" key={rowKey} data-closed={closed ? 'true' : 'false'}>
                  <span className="name">{t(`rows.${rowKey}`)}</span>
                  <PlanTrack
                    rowKey={rowKey}
                    trackUnits={SEQUENCE_TRACK_UNITS}
                    laneHeight={SEQUENCE_LANE_HEIGHT}
                    planned={SEQUENCE_PLANNED[rowKey]}
                    actual={row}
                    // KF D: once every row has closed the blue baseline drops
                    // back to 35% — the agreed plan is still on the record, it
                    // is just no longer the thing being read.
                    baselineOpacity={closed ? SEQUENCE_CLOSED_BASELINE_OPACITY : 1}
                  />
                </div>
              );
            })}
          </div>

          <dl className="lp-hud" data-tone={kf.hud.tone}>
            <div className="lp-hud__cell">
              <dt className="label lp-micro">{t('hud.time')}</dt>
              <dd className="value">
                {(['B', 'C', 'D'] as const).map((r) => (
                  <span key={r} data-kf={r} data-visible={r === 'D' ? 'true' : 'false'}>
                    {t(`hud.readings.${r}.time`)}
                  </span>
                ))}
              </dd>
            </div>
            <div className="lp-hud__cell">
              <dt className="label lp-micro">{t('hud.cost')}</dt>
              <dd className="value">
                {(['B', 'C', 'D'] as const).map((r) => (
                  <span key={r} data-kf={r} data-visible={r === 'D' ? 'true' : 'false'}>
                    {formatSequenceHudCost(r, locale)}
                  </span>
                ))}
              </dd>
            </div>
            <div className="lp-hud__cell">
              <dt className="label lp-micro">{t('hud.scope')}</dt>
              <dd className="value">
                {(['B', 'C', 'D'] as const).map((r) => (
                  <span key={r} data-kf={r} data-visible={r === 'D' ? 'true' : 'false'}>
                    {t(`hud.readings.${r}.scope`)}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <SequenceMotion />
    </section>
  );
}
