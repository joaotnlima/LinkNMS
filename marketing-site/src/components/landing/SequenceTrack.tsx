import type { CSSProperties } from 'react';
import { SEQUENCE_LANE_HEIGHT, SEQUENCE_TRACK_UNITS } from '@/lib/landing-numbers';
import { PARKED_LANE_Y, laneTransform, type SequenceRow } from '@/lib/landing-sequence';
import { BadgeCheckIcon } from './icons';

/**
 * One row of the pinned sequence's gantt, in the `new-key-frames` idiom.
 *
 * This is deliberately NOT <PlanTrack />. PlanTrack draws two permanent lanes
 * and recolours the actual bar by plan state, which is what the S3 gantt and the
 * phone preview still do. The sequence's refreshed frame does something else:
 * the orange bar starts parked in a second lane at zero opacity, rises into the
 * planned lane to sit immediately after the blue bar, and the pair then dims to
 * 45% with a green check beside it. Bending PlanTrack to cover both would have
 * given it a mode flag and two meanings; two small components each mean one
 * thing.
 *
 * The bars are DOM SVG for the same reason as everywhere else on this page —
 * they carry plan semantics, so they stay crisp at any density and recolour with
 * the tokens. `preserveAspectRatio="none"` lets them stretch horizontally to the
 * column while the lanes keep their exact pixel height.
 *
 * The check mark is HTML, not SVG, and that is the one thing worth pausing on:
 * inside a non-uniformly scaled viewBox a round glyph would be stretched into an
 * ellipse. It is positioned instead at `--check-x`, the row's own fraction of
 * the track, and only ever animates opacity — its x is fixed, because a row's
 * check appears where the row closes and every row closes in one place.
 */

/** viewBox top edge: the pen hangs the 12-unit check 2 units above the lane. */
const VIEW_TOP = -2;
const VIEW_HEIGHT = PARKED_LANE_Y + SEQUENCE_LANE_HEIGHT - VIEW_TOP;

export type SequenceTrackProps = {
  rowKey: string;
  row: SequenceRow;
  /**
   * Where this row's check sits, in track units — taken from the row's CLOSED
   * geometry, which is the only phase in which it is visible.
   */
  checkX: number;
};

export function SequenceTrack({ rowKey, row, checkX }: SequenceTrackProps) {
  return (
    <div className="lp-seqtrack">
      <svg
        className="lp-seqtrack__bars"
        style={{ height: VIEW_HEIGHT }}
        viewBox={`0 ${VIEW_TOP} ${SEQUENCE_TRACK_UNITS} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="presentation"
        aria-hidden="true"
        data-row={rowKey}
      >
        {/* One group for the whole lane: closing dims the agreed bar and the
            actual bar together, because what dims is the row, not a colour. */}
        <g data-lane-group opacity={row.laneOpacity}>
          <g data-lane="planned" transform={laneTransform(row.plannedOffset, row.plannedWidth)}>
            <rect x="0" y="0" width="1" height={SEQUENCE_LANE_HEIGHT} fill="var(--plan-baseline)" />
          </g>
          <g
            data-lane="actual"
            opacity={row.actualOpacity}
            transform={laneTransform(row.actualOffset, row.actualWidth, row.actualY)}
          >
            <rect x="0" y="0" width="1" height={SEQUENCE_LANE_HEIGHT} fill="var(--plan-actual)" />
          </g>
        </g>
      </svg>

      <span
        className="lp-seqtrack__check"
        data-check={rowKey}
        style={{ '--check-x': checkX / SEQUENCE_TRACK_UNITS, opacity: row.checkOpacity } as CSSProperties}
        aria-hidden="true"
      >
        <BadgeCheckIcon size={12} />
      </span>
    </div>
  );
}
