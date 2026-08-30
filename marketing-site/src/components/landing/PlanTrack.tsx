import { PLAN_STATE_FILL, TRACK_LANE_GAP, type PlanState } from '@/lib/landing-numbers';
import type { CSSProperties } from 'react';

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
 * which forces layout on every animation frame.
 *
 * The same translate/scale values are ALSO exposed as the `--lane-x/y/w`
 * custom properties, so the scroll-reveal (landing.css) can drive the identical
 * transform purely from CSS without ever touching the attribute. The attribute
 * remains the no-JS / static-path source of truth.
 */

export type PlanTrackProps = {
  trackUnits: number;
  laneHeight: number;
  /** Gap between the planned lane and the actual lane, in units. Defaults to the shared constant. */
  laneGap?: number;
  planned: { offset: number; width: number };
  actual: { offset: number; width: number; state: PlanState };
  /** Opacity of the planned (baseline) lane. */
  baselineOpacity?: number;
  /** Stable id so the reveal can address this row without a DOM query by index. */
  rowKey: string;
  className?: string;
};

export function PlanTrack({
  trackUnits,
  laneHeight,
  laneGap = TRACK_LANE_GAP,
  baselineOpacity = 1,
  rowKey,
  className,
  planned,
  actual
}: PlanTrackProps) {
  const height = laneHeight * 2 + laneGap;
  const actualY = laneHeight + laneGap;
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
        style={
          {
            '--lane-x': String(planned.offset),
            '--lane-y': '0',
            '--lane-w': String(planned.width)
          } as CSSProperties
        }
      >
        <rect x="0" y="0" width="1" height={laneHeight} fill="var(--plan-baseline)" />
      </g>
      <g
        data-lane="actual"
        transform={`translate(${actual.offset} ${actualY}) scale(${actual.width} 1)`}
        style={
          {
            '--lane-x': String(actual.offset),
            '--lane-y': String(actualY),
            '--lane-w': String(actual.width)
          } as CSSProperties
        }
      >
        <rect x="0" y="0" width="1" height={laneHeight} fill={PLAN_STATE_FILL[actual.state]} />
      </g>
    </svg>
  );
}
