// The pinned scroll sequence, as arithmetic (LINA-89).
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
  SEQUENCE_CLOSED_BASELINE_OPACITY,
  SEQUENCE_KEYFRAMES,
  SEQUENCE_ROW_KEYS,
  type PlanState,
  type SequenceKeyframe,
  type SequenceRowKey
} from './landing-numbers';

export type KeyframeId = SequenceKeyframe['id'];
export type StageNumber = 1 | 2 | 3 | 4;

export type SequenceRow = { offset: number; width: number; state: PlanState };
export type SequenceRows = Record<SequenceRowKey, SequenceRow>;

export type SequenceState = {
  rows: SequenceRows;
  /** Opacity of the planned (blue) lane. Falls to 35% once every row has closed. */
  baselineOpacity: number;
  hudTone: PlanState;
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
 * A node is a keyframe the timeline interpolates through. The four from the
 * table, plus a synthetic zero node at p = 0.
 *
 * The zero node is not invented geometry: it is KF A with every actual bar at
 * zero width, so `p 0.00 → 0.15` grows the bars out of nothing into A — exactly
 * what caption A ("the lines draw themselves") describes. Nothing about it is a
 * free parameter.
 */
type Node = {
  id: KeyframeId;
  p: number;
  rows: SequenceRows;
  baselineOpacity: number;
  hudTone: PlanState;
};

/**
 * The baseline lane's opacity is a *consequence* of the rows, not a fifth column
 * of the table: it drops the moment nothing is left to compare against.
 */
function baselineOpacityFor(rows: SequenceRows): number {
  return SEQUENCE_ROW_KEYS.every((key) => rows[key].state === 'closed')
    ? SEQUENCE_CLOSED_BASELINE_OPACITY
    : 1;
}

function toNode(kf: SequenceKeyframe): Node {
  return {
    id: kf.id,
    p: kf.p,
    rows: { ...kf.rows },
    baselineOpacity: baselineOpacityFor(kf.rows),
    hudTone: kf.hud.tone
  };
}

const FIRST_KEYFRAME = SEQUENCE_KEYFRAMES[0];

const ZERO_NODE: Node = {
  id: FIRST_KEYFRAME.id,
  p: 0,
  rows: SEQUENCE_ROW_KEYS.reduce((acc, key) => {
    const row = FIRST_KEYFRAME.rows[key];
    acc[key] = { offset: row.offset, width: 0, state: row.state };
    return acc;
  }, {} as SequenceRows),
  baselineOpacity: 1,
  hudTone: FIRST_KEYFRAME.hud.tone
};

const NODES: readonly Node[] = [ZERO_NODE, ...SEQUENCE_KEYFRAMES.map(toNode)];

export const EMPTY_STAGE_BLEND: Record<StageNumber, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

function clamp01(value: number): number {
  // Not a Number is not a scroll position — fail safe to the start of the
  // sequence (p=0) rather than letting a comparison with NaN fall through to
  // the end of the table.
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function lerp(from: number, to: number, t: number): number {
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
 * Geometry interpolates across the segment; semantics (bar colour, HUD tone) do
 * not — a row is agreed or it is not, and a half-green bar would be a lie about
 * the record. Semantics therefore step at the segment midpoint, which is also
 * where the image cross-fade crosses 50%, so the wall going up and the bar
 * turning green land on the same frame rather than a beat apart.
 */
export function sequenceStateAt(p: number): SequenceState {
  const { prev, next, index, t } = segmentAt(p);
  const committed = t < 0.5 ? prev : next;
  const committedIndex = t < 0.5 ? index - 1 : index;

  const rows = SEQUENCE_ROW_KEYS.reduce((acc, key) => {
    acc[key] = {
      offset: lerp(prev.rows[key].offset, next.rows[key].offset, t),
      width: lerp(prev.rows[key].width, next.rows[key].width, t),
      state: committed.rows[key].state
    };
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

  return {
    rows,
    baselineOpacity: lerp(prev.baselineOpacity, next.baselineOpacity, t),
    hudTone: committed.hudTone,
    // Captions label the *approach* to a keyframe ("p 0.15 → 0.40 · Foundations
    // and structure close"), so the caption on screen is the one being earned.
    captionId: next.id,
    // The chrome fades in over the same span the bars draw themselves in — the
    // table's own first interval, not a number picked to look right.
    chromeOpacity: FIRST_KEYFRAME.p > 0 ? clamp01(clamp01(p) / FIRST_KEYFRAME.p) : 1,
    stageBlend,
    keyframeId: NODES[Math.max(0, committedIndex)].id
  };
}

/**
 * `bar state → stage`. The single expression that picks the visible stage.
 *
 * Read it against the table: KF A has nothing closed and shows stage 1, B has
 * two closed and shows 2, C three and 3, D four and 4. `Math.max(1, …)` is what
 * covers the opening, where no row has closed yet but the drawing is already on
 * screen.
 *
 * `p` is deliberately not a parameter here. If this ever needs `p` to be
 * correct, the table and the animation have diverged and the table wins.
 */
export function stageFor(rows: SequenceRows): StageNumber {
  let closed = 0;
  for (const key of SEQUENCE_ROW_KEYS) {
    if (rows[key].state === 'closed') closed++;
  }
  return Math.max(1, closed) as StageNumber;
}

/** SVG transform for one lane, matching what `PlanTrack` renders on the server. */
export function laneTransform(offset: number, width: number, y = 0): string {
  // A zero scale collapses the rect and some engines drop the node entirely;
  // clamping keeps it paintable while still reading as "not started".
  const safeWidth = width > 0.0001 ? width : 0.0001;
  return `translate(${offset} ${y}) scale(${safeWidth} 1)`;
}
