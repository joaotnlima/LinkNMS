import type { PlanState } from '@/lib/landing-numbers';

/**
 * A planned/actual bar pair, drawn as real DOM SVG.
 *
 * Never an image, never canvas, no clip-path and no mask (spec §3): the bars
 * carry the product's plan semantics and have to stay crisp at any density and
 * recolour with the tokens.
 *
 * Geometry is expressed in the source frame's track units and the viewBox does
 * the scaling, with `preserveAspectRatio="none"` so bars stretch horizontally
 * to the container while the lanes keep their exact pixel height.
 *
 * Each bar is a unit-width rect inside a `<g transform="translate(x) scale(w,1)">`.
 * That is deliberate: growing a bar is then a change to one `transform` on one
 * group — a compositor-friendly property — rather than a change to `width`,
 * which forces layout on every scrub frame and will not hold 60 fps.
 */

const STATE_FILL: Record<PlanState, string> = {
  baseline: 'var(--plan-baseline)',
  actual: 'var(--plan-actual)',
  closed: 'var(--plan-closed)'
};

export type PlanTrackProps = {
  trackUnits: number;
  laneHeight: number;
  /** Gap between the planned lane and the actual lane, in units. */
  laneGap?: number;
  planned: { offset: number; width: number };
  actual: { offset: number; width: number; state: PlanState };
  /** Opacity of the planned (baseline) lane. KF D drops it to 35% once all rows close. */
  baselineOpacity?: number;
  /** Stable id so the animation can address this row without a DOM query by index. */
  rowKey: string;
  className?: string;
};

export function PlanTrack({
  trackUnits,
  laneHeight,
  laneGap = 3,
  planned,
  actual,
  baselineOpacity = 1,
  rowKey,
  className
}: PlanTrackProps) {
  const height = laneHeight * 2 + laneGap;
  return (
    <svg
      className={className ?? 'lp-track'}
      style={{ height }}
      viewBox={`0 0 ${trackUnits} ${height}`}
      preserveAspectRatio="none"
      role="presentation"
      aria-hidden="true"
      data-row={rowKey}
    >
      <g
        data-lane="planned"
        opacity={baselineOpacity}
        transform={`translate(${planned.offset} 0) scale(${planned.width} 1)`}
      >
        <rect x="0" y="0" width="1" height={laneHeight} fill="var(--plan-baseline)" />
      </g>
      <g
        data-lane="actual"
        transform={`translate(${actual.offset} ${laneHeight + laneGap}) scale(${actual.width} 1)`}
      >
        <rect x="0" y="0" width="1" height={laneHeight} fill={STATE_FILL[actual.state]} />
      </g>
    </svg>
  );
}
