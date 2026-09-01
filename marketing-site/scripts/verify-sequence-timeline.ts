// Executable proof that the scroll sequence's timeline obeys the rules the
// issue says are expensive to get wrong (LINA-89, restored for LINA-113).
//
// The timeline is a pure function, so it can be checked without a browser, a
// scroll, or an animation library — which is the main reason it was written as
// one. Run with `npm run verify:sequence`.
//
// This is not a substitute for looking at the thing; it is the part of the
// acceptance criteria that a machine can hold: stage derives from bar state (via
// `stageFor`, which takes no `p`), p=0 and p=1 are what acceptance says they
// are, the stage never runs backwards, and reverse scroll reverts exactly.

import {
  SEQUENCE_CLOSED_BASELINE_OPACITY,
  SEQUENCE_KEYFRAMES,
  SEQUENCE_ROW_KEYS,
  type PlanState
} from '../src/lib/landing-numbers';
import {
  sequenceStateAt,
  stageFor,
  type SequenceRows,
  type SequenceState
} from '../src/lib/landing-sequence';

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

function rowsWithStates(rows: SequenceRows, states: Record<string, PlanState>) {
  for (const key of SEQUENCE_ROW_KEYS) rows[key].state = states[key] as PlanState;
  return rows;
}

const baselineRows = (): SequenceRows => {
  const out = {} as SequenceRows;
  for (const key of SEQUENCE_ROW_KEYS) {
    out[key] = { offset: 0, width: 1, state: 'actual' };
  }
  return out;
};

// --- Acceptance: the two endpoints -----------------------------------------

console.log('endpoints');
{
  const a = sequenceStateAt(0);
  // p=0 → the drawing is on screen, nothing is agreed yet.
  eq('p=0 → stage 1 visible', a.stageBlend[1], 1);
  eq('p=0 → stage 2/3/4 hidden', a.stageBlend[2] + a.stageBlend[3] + a.stageBlend[4], 0);
  eq('p=0 → bars/HUD hidden', a.chromeOpacity, 0);
  eq('p=0 → caption A', a.captionId, 'A');
  check('p=0 → no row closed', SEQUENCE_ROW_KEYS.every((k) => a.rows[k].state !== 'closed'));

  const d = sequenceStateAt(1);
  eq('p=1 → stage 4 visible', d.stageBlend[4], 1);
  eq('p=1 → stage 1/2/3 hidden', d.stageBlend[1] + d.stageBlend[2] + d.stageBlend[3], 0);
  eq('p=1 → bars/HUD visible', d.chromeOpacity, 1);
  eq('p=1 → caption D', d.captionId, 'D');
  eq('p=1 → HUD closed tone', d.hudTone, 'closed');
  check('p=1 → all four rows closed', SEQUENCE_ROW_KEYS.every((k) => d.rows[k].state === 'closed'));
  eq('p=1 → baseline drops to 35%', d.baselineOpacity, SEQUENCE_CLOSED_BASELINE_OPACITY);

  // The server renders p=1. If these disagree, the wind-back is a visible jump
  // on first paint — the exact artefact "render the final state, wind back" exists
  // to avoid.
  const final = SEQUENCE_KEYFRAMES[SEQUENCE_KEYFRAMES.length - 1];
  for (const key of SEQUENCE_ROW_KEYS) {
    near(`p=1 ${key} offset matches KF D`, d.rows[key].offset, final.rows[key].offset);
    near(`p=1 ${key} width matches KF D`, d.rows[key].width, final.rows[key].width);
  }
}

// --- The KF A–D table is wired, not eyeballed -------------------------------

console.log('keyframe table');
for (const kf of SEQUENCE_KEYFRAMES) {
  const state = sequenceStateAt(kf.p);
  // geometry lands exactly on the table at its keyframe
  for (const key of SEQUENCE_ROW_KEYS) {
    near(`KF ${kf.id} ${key} offset`, state.rows[key].offset, kf.rows[key].offset);
    near(`KF ${kf.id} ${key} width`, state.rows[key].width, kf.rows[key].width);
    eq(`KF ${kf.id} ${key} state`, state.rows[key].state, kf.rows[key].state);
  }
  // The visible stage at that keyframe is the table's stage, via stageFor.
  const stage = stageFor(state.rows);
  eq(`KF ${kf.id} → stage ${kf.stage}`, stage, kf.stage);
  // And the blend agrees with the stage: the keyframe's own stage is the one on.
  eq(`KF ${kf.id} → blend on the table stage`, state.stageBlend[kf.stage], 1);
}

// --- The chrome fade matches the pen ----------------------------------------

console.log('chrome fade (pen: opacity 0 through KF A, on for KF B)');
{
  // The keyframes are the sequence's own: 0.15 / 0.40 / 0.70 / 1.00. (The inline
  // reel chip uses 0.72 — that is a different component's number, never here.)
  const expected = [0.15, 0.4, 0.7, 1];
  for (let i = 0; i < expected.length; i++) {
    eq(`KF ${SEQUENCE_KEYFRAMES[i].id} p = ${expected[i]}`, SEQUENCE_KEYFRAMES[i].p, expected[i]);
  }

  const a = sequenceStateAt(SEQUENCE_KEYFRAMES[0].p);
  eq('bars/HUD hidden at KF A (pen)', a.chromeOpacity, 0);
  const b = sequenceStateAt(SEQUENCE_KEYFRAMES[1].p);
  eq('bars/HUD on at KF B (pen)', b.chromeOpacity, 1);
  near('bars/HUD half at the A→B midpoint', sequenceStateAt(0.275).chromeOpacity, 0.5);
  const d = sequenceStateAt(1);
  eq('bars/HUD fully on at p=1', d.chromeOpacity, 1);
}

// --- Rule 2: the stage selector reads bar state and nothing else ------------

console.log('stage derives from bar state');
{
  const A = 'actual' as const;
  const C = 'closed' as const;
  const rows = (states: Record<string, PlanState>) => rowsWithStates(baselineRows(), states);

  eq('nothing closed → 1', stageFor(rows({ foundations: A, structure: A, envelope: A, finishes: A })), 1);
  eq('foundations only → 1', stageFor(rows({ foundations: C, structure: A, envelope: A, finishes: A })), 1);
  eq('foundations + structure → 2', stageFor(rows({ foundations: C, structure: C, envelope: A, finishes: A })), 2);
  eq('+ envelope → 3', stageFor(rows({ foundations: C, structure: C, envelope: C, finishes: A })), 3);
  eq('+ finishes → 4', stageFor(rows({ foundations: C, structure: C, envelope: C, finishes: C })), 4);

  // Same bar state ⇒ same stage, always. `stageFor` takes no `p`, so a leaked p
  // could not be called at all.
  eq('selector is unary', stageFor.length, 1);
}

// --- Monotonic: the house never un-builds -----------------------------------

console.log('monotonic advance and continuity');
{
  const STEPS = 2000;
  let prevStage = 1;
  let prev = sequenceStateAt(0);
  let maxJump = 0;

  for (let i = 0; i <= STEPS; i += 1) {
    const p = i / STEPS;
    const s = sequenceStateAt(p);
    const stage = stageFor(s.rows);

    check(`stage never decreases at p=${p.toFixed(4)}`, stage >= prevStage, `${prevStage} → ${stage}`);
    prevStage = stage;

    // The stage the RENDERER paints is the stage the bars imply — at every p,
    // not just at the four keyframes. `SequenceMotion.render()` marks a stage
    // visible at blend >= 0.5, so that is what we assert against `stageFor`.
    // Without this, `stageFor` could be correct and still be dead code while
    // the blend was driven off a second, drift-prone stage table.
    // The dominant stage in the blend — ties break to the later stage, the same
    // way row semantics commit at the segment midpoint.
    const painted = ([1, 2, 3, 4] as const).reduce((best, n) =>
      s.stageBlend[n] >= s.stageBlend[best] ? n : best
    );
    eq(`painted stage is stageFor(rows) at p=${p.toFixed(4)}`, painted, stage);
    check(
      `painted stage is at least half opaque at p=${p.toFixed(4)}`,
      s.stageBlend[painted] >= 0.5,
      `blend was ${s.stageBlend[painted]}`
    );

    for (const key of SEQUENCE_ROW_KEYS) {
      const wasClosed = prev.rows[key].state === 'closed';
      check(`${key} stays closed at p=${p.toFixed(4)}`, !wasClosed || s.rows[key].state === 'closed');

      maxJump = Math.max(
        maxJump,
        Math.abs(s.rows[key].offset - prev.rows[key].offset),
        Math.abs(s.rows[key].width - prev.rows[key].width)
      );
      check(`${key} width non-negative at p=${p.toFixed(4)}`, s.rows[key].width >= 0);
    }
    prev = s;
  }

  check('geometry is continuous', maxJump < 0.5, `largest single-step move was ${maxJump.toFixed(4)} units`);
}

// --- Reverse scroll reverts exactly -----------------------------------------

console.log('reversibility');
{
  const STEPS = 500;
  const state = (p: number) => JSON.stringify(sequenceStateAt(p));
  const forward: string[] = [];
  const backward: string[] = [];

  for (let i = 0; i <= STEPS; i += 1) forward.push(state(i / STEPS));
  for (let i = STEPS; i >= 0; i -= 1) backward.unshift(state(i / STEPS));

  const firstDiff = forward.findIndex((v, i) => v !== backward[i]);
  check('state at p is identical scrolling up or down', firstDiff === -1, `first divergence at step ${firstDiff}`);

  eq('p < 0 clamps to the p=0 state', state(-0.4), forward[0]);
  eq('p > 1 clamps to the p=1 state', state(1.7), forward[STEPS]);
  eq('NaN p is not a crash', sequenceStateAt(Number.NaN).stageBlend[1], 1);
}

// --- The blend is a partition (stage images always sum to 1) -----------------

console.log('blend is a valid cross-fade');
{
  const STEPS = 400;
  for (let i = 0; i <= STEPS; i += 1) {
    const s = sequenceStateAt(i / STEPS) as SequenceState;
    const sum = s.stageBlend[1] + s.stageBlend[2] + s.stageBlend[3] + s.stageBlend[4];
    near(`blend sums to 1 at p=${(i / STEPS).toFixed(3)}`, sum, 1, 1e-9);
    for (const stage of [1, 2, 3, 4] as const) {
      check(`blend[${stage}] in range at p=${(i / STEPS).toFixed(3)}`, s.stageBlend[stage] >= 0 && s.stageBlend[stage] <= 1);
    }
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`${checks} checks passed`);