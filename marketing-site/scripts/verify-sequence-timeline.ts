// Executable proof that the scroll sequence's timeline obeys the rules the
// issue says are expensive to get wrong (LINA-83).
//
// The timeline is a pure function, so it can be checked without a browser, a
// scroll, or an animation library — which is the main reason it was written as
// one. Run with `npm run verify:sequence`.
//
// This is not a substitute for looking at the thing; it is the part of the
// acceptance criteria that a machine can hold: stage derives from bar state,
// p=0 and p=1 are what acceptance says they are, the stage never runs
// backwards, and reverse scroll reverts exactly.

import {
  SEQUENCE_CLOSED_BASELINE_OPACITY,
  SEQUENCE_KEYFRAMES,
  SEQUENCE_ROW_KEYS
} from '../src/lib/landing-numbers';
import {
  allRowsClosed,
  barsAt,
  sequenceStateAt,
  stageForBars,
  type BarState
} from '../src/lib/landing-sequence-timeline';

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  check(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function near(label: string, actual: number, expected: number, eps = 1e-9): void {
  check(label, Math.abs(actual - expected) <= eps, `expected ≈${expected}, got ${actual}`);
}

// --- Acceptance: the two endpoints -----------------------------------------

console.log('endpoints');
{
  const a = sequenceStateAt(0);
  eq('p=0 → stage 1', a.stage, 1);
  eq('p=0 → bars/HUD hidden', a.chromeOpacity, 0);
  eq('p=0 → caption A', a.captionId, 'A');
  check('p=0 → no row closed', SEQUENCE_ROW_KEYS.every((k) => a.bars[k].state !== 'closed'));

  const d = sequenceStateAt(1);
  eq('p=1 → stage 4', d.stage, 4);
  eq('p=1 → bars/HUD visible', d.chromeOpacity, 1);
  eq('p=1 → caption D', d.captionId, 'D');
  eq('p=1 → HUD closed tone', d.hudTone, 'closed');
  check('p=1 → all four rows closed', allRowsClosed(d.bars));
  eq('p=1 → baseline drops to 35%', d.baselineOpacity, SEQUENCE_CLOSED_BASELINE_OPACITY);

  // The server renders p=1. If these disagree, the wind-back is a visible jump
  // on first paint — the exact artefact "render the final state, wind back" exists
  // to avoid.
  const final = SEQUENCE_KEYFRAMES[SEQUENCE_KEYFRAMES.length - 1];
  for (const key of SEQUENCE_ROW_KEYS) {
    near(`p=1 ${key} offset matches KF D`, d.bars[key].offset, final.rows[key].offset);
    near(`p=1 ${key} width matches KF D`, d.bars[key].width, final.rows[key].width);
  }
}

// --- Rule 2: the stage selector reads bar state and nothing else ------------

console.log('stage derives from bar state');
{
  const bars = (states: Record<string, string>): BarState => {
    const out = {} as BarState;
    for (const key of SEQUENCE_ROW_KEYS) {
      out[key] = { offset: 0, width: 1, state: states[key] as BarState[typeof key]['state'] };
    }
    return out;
  };
  const A = 'actual';
  const C = 'closed';

  eq('nothing closed → 1', stageForBars(bars({ foundations: A, structure: A, envelope: A, finishes: A })), 1);
  eq('foundations only → 1', stageForBars(bars({ foundations: C, structure: A, envelope: A, finishes: A })), 1);
  eq('foundations + structure → 2', stageForBars(bars({ foundations: C, structure: C, envelope: A, finishes: A })), 2);
  eq('+ envelope → 3', stageForBars(bars({ foundations: C, structure: C, envelope: C, finishes: A })), 3);
  eq('+ finishes → 4', stageForBars(bars({ foundations: C, structure: C, envelope: C, finishes: C })), 4);

  // Same bar state ⇒ same stage, always. If a p had leaked into the selector
  // this could not hold, because the selector could not be called at all.
  eq('selector is unary', stageForBars.length, 1);
}

// --- The KF A–D table is wired, not eyeballed -------------------------------

console.log('keyframe table');
for (const kf of SEQUENCE_KEYFRAMES) {
  const state = sequenceStateAt(kf.p);
  eq(`KF ${kf.id} → stage ${kf.stage}`, state.stage, kf.stage);
  for (const key of SEQUENCE_ROW_KEYS) {
    near(`KF ${kf.id} ${key} offset`, state.bars[key].offset, kf.rows[key].offset);
    near(`KF ${kf.id} ${key} width`, state.bars[key].width, kf.rows[key].width);
    eq(`KF ${kf.id} ${key} state`, state.bars[key].state, kf.rows[key].state);
  }
}

// --- The house never un-builds ----------------------------------------------

console.log('monotonic advance and continuity');
{
  const STEPS = 2000;
  let prevStage = 1;
  let prev = sequenceStateAt(0);
  let maxJump = 0;

  for (let i = 0; i <= STEPS; i += 1) {
    const p = i / STEPS;
    const s = sequenceStateAt(p);

    check(`stage never decreases at p=${p.toFixed(4)}`, s.stage >= prevStage, `${prevStage} → ${s.stage}`);
    prevStage = s.stage;

    for (const key of SEQUENCE_ROW_KEYS) {
      // A row that has closed must stay closed as p increases: closing is an
      // agreement being signed, and those do not un-sign on the way up.
      const wasClosed = prev.bars[key].state === 'closed';
      check(`${key} stays closed at p=${p.toFixed(4)}`, !wasClosed || s.bars[key].state === 'closed');

      maxJump = Math.max(
        maxJump,
        Math.abs(s.bars[key].offset - prev.bars[key].offset),
        Math.abs(s.bars[key].width - prev.bars[key].width)
      );
      check(`${key} width non-negative at p=${p.toFixed(4)}`, s.bars[key].width >= 0);
    }
    prev = s;
  }

  // Geometry is a lerp, so a 1/2000 step of p can only move a bar by a small
  // fraction of a track unit. A larger jump means a discontinuity crept into the
  // segment lookup and the bars would visibly snap under scrub.
  check('geometry is continuous', maxJump < 0.5, `largest single-step move was ${maxJump.toFixed(4)} units`);
}

// --- Reverse scroll reverts exactly -----------------------------------------

console.log('reversibility');
{
  const STEPS = 500;
  const forward: string[] = [];
  const backward: string[] = [];

  for (let i = 0; i <= STEPS; i += 1) forward.push(JSON.stringify(sequenceStateAt(i / STEPS)));
  for (let i = STEPS; i >= 0; i -= 1) backward.unshift(JSON.stringify(sequenceStateAt(i / STEPS)));

  const firstDiff = forward.findIndex((v, i) => v !== backward[i]);
  check('state at p is identical scrolling up or down', firstDiff === -1, `first divergence at step ${firstDiff}`);

  // Out-of-range p is clamped, not extrapolated — ScrollTrigger can hand us a
  // progress a hair outside [0,1] on rubber-band scroll.
  eq('p < 0 clamps to the p=0 state', JSON.stringify(sequenceStateAt(-0.4)), forward[0]);
  eq('p > 1 clamps to the p=1 state', JSON.stringify(sequenceStateAt(1.7)), forward[STEPS]);
  eq('NaN p is not a crash', sequenceStateAt(Number.NaN).stage, 1);
}

// --- Result ------------------------------------------------------------------

const barsOnly = barsAt(0.5);
check('barsAt is usable standalone', SEQUENCE_ROW_KEYS.every((k) => typeof barsOnly[k].width === 'number'));

console.log('');
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
