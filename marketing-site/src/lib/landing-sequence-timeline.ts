// The pinned scroll sequence's timeline, as a pure function of p (LINA-83).
//
// This module is the whole of rules 1 and 2 from the issue:
//
//   1. ONE timeline, ONE normalized p ∈ [0,1]. Everything on screen derives
//      from it as a pure function. There are no per-layer ScrollTriggers to
//      desynchronise under scrub or drift on reverse scroll, because there is
//      nothing here to desynchronise: `sequenceStateAt(p)` returns the complete
//      state of the section, and the controller's only job is to write it out.
//
//   2. The house advances off BAR STATE, not off p:
//
//        p → barsAt(p)          → bars    (the only place p is read)
//        bars → stageForBars()  → stage   (the only place stage is decided)
//
//      `p` does not appear in `stageForBars`, and cannot: it is not a parameter
//      of it. That is the point — a stage selector that reads p is a slideshow
//      with extra steps, and the product argument ("every agreement raises a
//      wall") stops being true of the thing on screen.
//
// Nothing here imports gsap, Lenis, React or the DOM. It is deterministic and
// side-effect free, which is what makes reverse scroll revert exactly: the
// state at p is the state at p, whichever direction you arrived from.
//
// Geometry and keyframe boundaries come from the KF A–D table in
// `landing-numbers.ts`, which is the spec's table wired literally. Timings are
// not eyeballed anywhere in this file.

import {
  SEQUENCE_CLOSED_BASELINE_OPACITY,
  SEQUENCE_KEYFRAMES,
  SEQUENCE_ROW_KEYS,
  type PlanState,
  type SequenceKeyframe,
  type SequenceRowKey
} from './landing-numbers';

export type Stage = 1 | 2 | 3 | 4;

export type BarGeometry = { offset: number; width: number; state: PlanState };
export type BarState = Record<SequenceRowKey, BarGeometry>;

export type SequenceState = {
  /** The p this state was derived from, clamped to [0,1]. */
  p: number;
  bars: BarState;
  /** Derived from `bars` alone — see `stageForBars`. */
  stage: Stage;
  hudTone: PlanState;
  /** Planned-lane opacity. Drops once the plan is no longer the thing being read. */
  baselineOpacity: number;
  /** Opacity of the bars + HUD as a group. 0 at p=0, 1 from KF A onward. */
  chromeOpacity: number;
  /** Which caption block is showing. Matches the `captions.{id}` message keys. */
  captionId: SequenceKeyframe['id'];
};

/**
 * How far into a keyframe segment a row's discrete `state` flips to the
 * incoming keyframe's state.
 *
 * The geometry lerps continuously across the whole segment; the state is a
 * step. Stepping at 1.0 would mean stage-4 existed only at exactly p === 1,
 * and stepping at 0 would turn a bar green before it had visibly grown. 0.7
 * puts the flip after the bar has substantially arrived, so the read is "the
 * bar finishes, THEN the house advances" — which is the causal order the
 * section is arguing for.
 *
 * Being a threshold on a pure function, it costs nothing on reverse: the flip
 * happens at the same p going back up.
 */
const STATE_SNAP_AT = 0.7;

const FIRST = SEQUENCE_KEYFRAMES[0];
const LAST = SEQUENCE_KEYFRAMES[SEQUENCE_KEYFRAMES.length - 1];

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * THE stage selector.
 *
 * Note the signature: it takes bar state and nothing else. There is no `p` in
 * scope here, so there is no way to accidentally reintroduce one. The cascade
 * is the issue's rule, in its order:
 *
 *   foundations + structure close → stage-2
 *   envelope closes               → stage-3
 *   finishes closes               → stage-4
 *
 * Checked highest-first so the latest milestone reached wins.
 */
export function stageForBars(bars: BarState): Stage {
  const closed = (key: SequenceRowKey) => bars[key].state === 'closed';

  if (closed('finishes')) return 4;
  if (closed('envelope')) return 3;
  if (closed('foundations') && closed('structure')) return 2;
  return 1;
}

/** Is every row closed? Drives the KF D baseline drop, derived rather than keyed off p. */
export function allRowsClosed(bars: BarState): boolean {
  return SEQUENCE_ROW_KEYS.every((key) => bars[key].state === 'closed');
}

/**
 * Locate p within the keyframe table.
 *
 * Below KF A the sequence is holding A's geometry while the bars fade in, so
 * the segment is degenerate (from === to). Above KF D is unreachable after
 * clamping, but is handled for the same reason.
 */
function segmentAt(p: number): { from: SequenceKeyframe; to: SequenceKeyframe; t: number } {
  if (p <= FIRST.p) return { from: FIRST, to: FIRST, t: 0 };

  for (let i = 0; i < SEQUENCE_KEYFRAMES.length - 1; i += 1) {
    const from = SEQUENCE_KEYFRAMES[i];
    const to = SEQUENCE_KEYFRAMES[i + 1];
    if (p <= to.p) {
      const span = to.p - from.p;
      return { from, to, t: span === 0 ? 1 : (p - from.p) / span };
    }
  }

  return { from: LAST, to: LAST, t: 1 };
}

/** The bar geometry and per-row plan state at p. The only function that reads p. */
export function barsAt(p: number): BarState {
  const { from, to, t } = segmentAt(clamp01(p));
  const bars = {} as BarState;

  for (const key of SEQUENCE_ROW_KEYS) {
    const a = from.rows[key];
    const b = to.rows[key];
    bars[key] = {
      offset: lerp(a.offset, b.offset, t),
      width: lerp(a.width, b.width, t),
      state: t >= STATE_SNAP_AT ? b.state : a.state
    };
  }

  return bars;
}

/** The caption block at p — the segment you are travelling *into*. */
function captionAt(p: number): SequenceKeyframe['id'] {
  const { from, to, t } = segmentAt(clamp01(p));
  return t >= STATE_SNAP_AT ? to.id : from.id;
}

/** HUD tone, snapped on the same threshold as the bars so the two never disagree. */
function hudToneAt(p: number): PlanState {
  const { from, to, t } = segmentAt(clamp01(p));
  return t >= STATE_SNAP_AT ? to.hud.tone : from.hud.tone;
}

/**
 * The complete state of the section at p.
 *
 * The controller writes exactly this to the DOM and does no arithmetic of its
 * own, so "what should be on screen" is answerable without a browser.
 */
export function sequenceStateAt(p: number): SequenceState {
  const clamped = clamp01(p);
  const bars = barsAt(clamped);

  return {
    p: clamped,
    bars,
    stage: stageForBars(bars),
    hudTone: hudToneAt(clamped),
    // KF D: once every row has closed the blue baseline drops back to 35%. The
    // agreed plan is still on the record, it is just no longer what you read.
    baselineOpacity: allRowsClosed(bars) ? SEQUENCE_CLOSED_BASELINE_OPACITY : 1,
    // Acceptance: at p=0 the bars and HUD are at opacity 0 and only the stage
    // still is on screen. They fade in over the run-up to KF A.
    chromeOpacity: FIRST.p === 0 ? 1 : clamp01(clamped / FIRST.p),
    captionId: captionAt(clamped)
  };
}

/**
 * The SVG transform for one lane. Bars grow via `transform: scaleX()` about a
 * left origin — never `width`, which forces layout on every scrub frame and
 * will not hold 60 fps on a 2020 MacBook Air (issue rule 4).
 *
 * Mirrors the transform `PlanTrack` renders on the server, so the animation
 * writes the same attribute the static state already uses and the two can
 * never drift into different coordinate conventions.
 */
export function laneTransform(offset: number, width: number, y = 0): string {
  return `translate(${round(offset)} ${round(y)}) scale(${round(width)} 1)`;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
