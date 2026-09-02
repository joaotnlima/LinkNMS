// The pinned scroll sequence, as arithmetic (LINA-89, restored for LINA-113,
// re-tabled against the refreshed pen for LINA-117).
//
// This module is pure: no DOM, no gsap, no React. It answers one question —
// "at scroll progress `p`, what does the sequence look like?" — from the KF A–D
// table in `landing-numbers.ts` and nothing else. The renderer
// (`SequenceMotion.tsx`) only writes what it is told, which is what keeps the
// timings readable against the table instead of eyeballed in a tween call.
//
// The chain the spec asks for is literal here:
//
//   p  →  sequenceStateAt(p)  →  .rows  →  stageFor(rows)  →  the visible stage
//
// `stageFor` is the ONLY expression that names a stage, and `p` does not appear
// in it. That is deliberate: the house on screen is a consequence of what the
// bars say, never of a second set of timings that could drift from the first.

import {
  SEQUENCE_CHECK_GAP,
  SEQUENCE_CLOSED_LANE_OPACITY,
  SEQUENCE_KEYFRAMES,
  SEQUENCE_LANE_GAP,
  SEQUENCE_LANE_HEIGHT,
  SEQUENCE_ROW_GEOMETRY,
  SEQUENCE_ROW_KEYS,
  type SequenceKeyframe,
  type SequenceRowKey,
  type SequenceRowPhase
} from './landing-numbers';

export type KeyframeId = SequenceKeyframe['id'];
export type StageNumber = 1 | 2 | 3 | 4;

/** Where the actual bar waits while its row is still only a plan. */
export const PARKED_LANE_Y = SEQUENCE_LANE_HEIGHT + SEQUENCE_LANE_GAP;

/**
 * One row, fully resolved to what gets drawn. Every field is a number the
 * renderer writes straight onto an attribute — no phase is re-interpreted
 * downstream, which is why `phase` rides along for labelling only.
 */
export type SequenceRow = {
  plannedOffset: number;
  plannedWidth: number;
  actualOffset: number;
  actualWidth: number;
  /** 0 once the actual bar has joined the planned lane; PARKED_LANE_Y before that. */
  actualY: number;
  actualOpacity: number;
  /** Whole-lane opacity — both bars. Drops to 45% when the row closes. */
  laneOpacity: number;
  checkX: number;
  checkOpacity: number;
  phase: SequenceRowPhase;
};

export type SequenceRows = Record<SequenceRowKey, SequenceRow>;

export type SequenceState = {
  rows: SequenceRows;
  hudTone: 'cream' | 'closed';
  /** Which of the four captions is on screen. Captions label the approach to a keyframe. */
  captionId: KeyframeId;
  /** Bars, caption and HUD as a block. 0 at p=0 — the drawing arrives before the reading of it. */
  chromeOpacity: number;
  /** Cross-fade weight per stage. Exactly one or two entries are ever non-zero. */
  stageBlend: Record<StageNumber, number>;
  /** The keyframe whose state is currently committed — the analytics `keyframe`. */
  keyframeId: KeyframeId;
};

/**
 * Resolve one row at one keyframe into the numbers above.
 *
 * This is where the pen's three phases become geometry, and it is the only
 * place that knows the rule. The important line is `actualOffset`: once a row is
 * revealed, the orange bar is drawn immediately after the blue one rather than
 * at an offset of its own. That is not a simplification — it is what the frame
 * draws, and it is what makes the pair read as "agreed, then what it took".
 */
function resolveRow(key: SequenceRowKey, kf: SequenceKeyframe): SequenceRow {
  const geometry = SEQUENCE_ROW_GEOMETRY[key];
  const phase = kf.phases[key];
  const plannedOffset = kf.plannedOffsets?.[key] ?? geometry.plannedOffset;
  const { plannedWidth, actualWidth } = geometry;

  const parked = phase === 'planned';
  const closed = phase === 'closed';
  const actualOffset = parked ? geometry.parkedOffset : plannedOffset + plannedWidth;

  return {
    plannedOffset,
    plannedWidth,
    actualOffset,
    actualWidth,
    actualY: parked ? PARKED_LANE_Y : 0,
    actualOpacity: parked ? 0 : 1,
    laneOpacity: closed ? SEQUENCE_CLOSED_LANE_OPACITY : 1,
    checkX: plannedOffset + plannedWidth + actualWidth + SEQUENCE_CHECK_GAP,
    checkOpacity: closed ? 1 : 0,
    phase
  };
}

function rowsFor(kf: SequenceKeyframe): SequenceRows {
  return SEQUENCE_ROW_KEYS.reduce((acc, key) => {
    acc[key] = resolveRow(key, kf);
    return acc;
  }, {} as SequenceRows);
}

/**
 * A node is a keyframe the timeline interpolates through: the four from the
 * table, and nothing else.
 *
 * There is deliberately no synthetic zero node ahead of KF A. An earlier pass
 * grew the planned bars out of zero width across `p 0.00 → 0.15`, which meant
 * the moment the section pinned carried no bars at all. The pen does not draw
 * that: KF A is captioned "the plan is drawn" and shows all six blue baselines
 * at full width, and the founder's note on LINA-117 is explicit — "the first
 * image should already have the blue (plan) bars showing the original plan".
 * So KF A's geometry is what `p ≤ 0.15` holds, and the first thing the drawing
 * plate carries is the agreed plan.
 */
type Node = { id: KeyframeId; p: number; rows: SequenceRows };

const FIRST_KEYFRAME = SEQUENCE_KEYFRAMES[0];

const NODES: readonly Node[] = SEQUENCE_KEYFRAMES.map((kf) => ({
  id: kf.id,
  p: kf.p,
  rows: rowsFor(kf)
}));

/**
 * How many rows have closed at each keyframe: [0, 2, 3, 6] off the table.
 * `stageFor` reads this and nothing else, so adding a row to the pen's frame
 * moves the stage boundaries automatically rather than silently disagreeing
 * with a hand-maintained second list.
 */
const CLOSED_COUNT_AT_KEYFRAME: readonly number[] = SEQUENCE_KEYFRAMES.map(
  (kf) => SEQUENCE_ROW_KEYS.filter((key) => kf.phases[key] === 'closed').length
);

export const EMPTY_STAGE_BLEND: Record<StageNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

/** Numeric fields of a row, interpolated frame by frame. */
const LERPED = [
  'plannedOffset',
  'plannedWidth',
  'actualOffset',
  'actualWidth',
  'actualY',
  'actualOpacity',
  'laneOpacity',
  'checkX',
  'checkOpacity'
] as const;

function clamp01(value: number): number {
  // Not a Number is not a scroll position — fail safe to the start of the
  // sequence (p=0) rather than letting a comparison with NaN fall through to
  // the end of the table.
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function lerp(from: number, to: number, t: number): number {
  // Snap the endpoints. `from + (to - from) * 1` is not exactly `to` in binary
  // floating point (1 + (0.45 - 1) * 1 is 0.44999999999999996), and the endpoints
  // are exactly where this module promises to reproduce the pen's table. Every
  // keyframe sits at a segment boundary, so this is the difference between
  // landing on the table and landing next to it.
  if (t <= 0) return from;
  if (t >= 1) return to;
  return from + (to - from) * t;
}

/**
 * Locate `p` between two nodes. `t` is progress within that segment.
 *
 * This is the one place `p` is turned into anything, which is why every other
 * export below takes a state or a row set rather than a number.
 */
function segmentAt(p: number): { prev: Node; next: Node; index: number; t: number } {
  const clamped = clamp01(p);
  for (let i = 1; i < NODES.length; i++) {
    const prev = NODES[i - 1];
    const next = NODES[i];
    if (clamped <= next.p || i === NODES.length - 1) {
      const span = next.p - prev.p;
      return { prev, next, index: i, t: span > 0 ? clamp01((clamped - prev.p) / span) : 1 };
    }
  }
  // Unreachable while NODES has ≥2 entries; keeps the return type honest.
  const last = NODES[NODES.length - 1];
  return { prev: last, next: last, index: NODES.length - 1, t: 1 };
}

/**
 * `p → bar state`.
 *
 * Geometry interpolates across the segment; semantics (the row's phase, the HUD
 * tone) do not — a row is closed or it is not, and a half-closed row would be a
 * lie about the record. Semantics therefore step at the segment midpoint, which
 * is also where the image cross-fade crosses 50%, so the wall going up and the
 * row closing land on the same frame rather than a beat apart.
 */
export function sequenceStateAt(p: number): SequenceState {
  const { prev, next, index, t } = segmentAt(p);
  const committed = t < 0.5 ? prev : next;
  const committedIndex = t < 0.5 ? index - 1 : index;

  const rows = SEQUENCE_ROW_KEYS.reduce((acc, key) => {
    const from = prev.rows[key];
    const to = next.rows[key];
    const row = { phase: committed.rows[key].phase } as SequenceRow;
    for (const field of LERPED) row[field] = lerp(from[field], to[field], t);
    acc[key] = row;
    return acc;
  }, {} as SequenceRows);

  // The blend endpoints come from `stageFor` — the same single selector the
  // rest of the app reads — applied to the two nodes' bar states. Reading the
  // table's `stage` column here instead would be a *second* place a stage is
  // decided, and the one the renderer actually paints; the two would agree
  // today and be free to drift tomorrow. `p` reaches this only by choosing
  // which two bar states to ask about, never by naming a stage.
  const stageBlend = { ...EMPTY_STAGE_BLEND };
  const fromStage = stageFor(prev.rows);
  const toStage = stageFor(next.rows);
  if (fromStage === toStage) {
    stageBlend[toStage] = 1;
  } else {
    stageBlend[fromStage] = 1 - t;
    stageBlend[toStage] = t;
  }

  const committedKeyframe =
    SEQUENCE_KEYFRAMES.find((kf) => kf.id === NODES[Math.max(0, committedIndex)].id) ??
    FIRST_KEYFRAME;

  return {
    rows,
    hudTone: committedKeyframe.hud.tone,
    // Captions label the *approach* to a keyframe, so the caption on screen is
    // the one being earned — except before KF A, which is not approached from
    // anywhere: it is where the sequence starts.
    captionId: clamp01(p) <= FIRST_KEYFRAME.p ? FIRST_KEYFRAME.id : next.id,
    // Always on. Every keyframe in the pen draws its Caption, Gantt and HUD at
    // full opacity, KF A included — the plan readout is not something the
    // section earns, it is the thing the drawing is being read against.
    chromeOpacity: 1,
    stageBlend,
    keyframeId: NODES[Math.max(0, committedIndex)].id
  };
}

/**
 * `bar state → stage`. The single expression that picks the visible stage.
 *
 * Read it against the table: KF A has nothing closed and shows stage 1, B has
 * two closed and shows 2, C three and 3, D all six and 4. The boundaries are
 * the table's own closed-counts, so the stage is literally "the last keyframe
 * whose closed-count the record has reached".
 *
 * `p` is deliberately not a parameter here. If this ever needs `p` to be
 * correct, the table and the animation have diverged and the table wins.
 */
export function stageFor(rows: SequenceRows): StageNumber {
  let closed = 0;
  for (const key of SEQUENCE_ROW_KEYS) {
    if (rows[key].phase === 'closed') closed++;
  }
  let stage: StageNumber = 1;
  for (let i = 0; i < CLOSED_COUNT_AT_KEYFRAME.length; i++) {
    if (closed >= CLOSED_COUNT_AT_KEYFRAME[i]) stage = (i + 1) as StageNumber;
  }
  return stage;
}

/** SVG transform for one lane, matching what `SequenceTrack` renders on the server. */
export function laneTransform(offset: number, width: number, y = 0): string {
  // A zero scale collapses the rect and some engines drop the node entirely;
  // clamping keeps it paintable while still reading as "not started".
  const safeWidth = width > 0.0001 ? width : 0.0001;
  return `translate(${offset} ${y}) scale(${safeWidth} 1)`;
}
