// Executable proof that the scroll sequence's timeline obeys the rules the
// issue says are expensive to get wrong (LINA-89, restored for LINA-113,
// re-tabled against the refreshed pen for LINA-117).
//
// The timeline is a pure function, so it can be checked without a browser, a
// scroll, or an animation library — which is the main reason it was written as
// one. Run with `npm run verify:sequence`.
//
// This is not a substitute for looking at the thing; it is the part of the
// acceptance criteria that a machine can hold: stage derives from bar state (via
// `stageFor`, which takes no `p`), p=0 and p=1 are what acceptance says they
// are, the stage never runs backwards, a row never re-opens, and reverse scroll
// reverts exactly.

import {
  SEQUENCE_CHECK_GAP,
  SEQUENCE_CLOSED_LANE_OPACITY,
  SEQUENCE_KEYFRAMES,
  SEQUENCE_ROW_GEOMETRY,
  SEQUENCE_ROW_KEYS,
  SEQUENCE_TRACK_UNITS,
  type SequenceRowPhase
} from '../src/lib/landing-numbers';
import {
  PARKED_LANE_Y,
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

/** A row set built by hand, for exercising `stageFor` away from the table. */
function rowsWithPhases(phases: Record<string, SequenceRowPhase>): SequenceRows {
  const out = {} as SequenceRows;
  for (const key of SEQUENCE_ROW_KEYS) {
    out[key] = {
      plannedOffset: 0,
      plannedWidth: 1,
      actualOffset: 1,
      actualWidth: 1,
      actualY: 0,
      actualOpacity: 1,
      laneOpacity: 1,
      checkX: 2,
      checkOpacity: 0,
      phase: phases[key]
    };
  }
  return out;
}

// --- The table is the pen's, and it has six rows ----------------------------

console.log('the refreshed pen table');
{
  eq('six rows', SEQUENCE_ROW_KEYS.length, 6);
  for (const key of ['foundations', 'structure', 'envelope', 'windows', 'mep', 'finishes']) {
    check(`row ${key} is in the table`, SEQUENCE_ROW_KEYS.includes(key as never));
  }
  // The four keyframes' own p values, off the frame titles.
  const expected = [0.15, 0.4, 0.7, 1];
  for (let i = 0; i < expected.length; i++) {
    eq(`KF ${SEQUENCE_KEYFRAMES[i].id} p = ${expected[i]}`, SEQUENCE_KEYFRAMES[i].p, expected[i]);
  }
  // Nothing may be drawn outside the viewBox, or the pen's own geometry clips.
  for (const key of SEQUENCE_ROW_KEYS) {
    const g = SEQUENCE_ROW_GEOMETRY[key];
    const closedOffset = SEQUENCE_KEYFRAMES[3].plannedOffsets?.[key] ?? g.plannedOffset;
    const extent = closedOffset + g.plannedWidth + g.actualWidth + SEQUENCE_CHECK_GAP;
    check(
      `${key} closed row fits the viewBox`,
      extent <= SEQUENCE_TRACK_UNITS,
      `extent ${extent} > ${SEQUENCE_TRACK_UNITS}`
    );
  }
}

// --- Acceptance: the two endpoints -----------------------------------------

console.log('endpoints');
{
  const a = sequenceStateAt(0);
  // p=0 → the drawing is on screen, nothing is agreed yet.
  eq('p=0 → stage 1 visible', a.stageBlend[1], 1);
  eq('p=0 → stage 2/3/4 hidden', a.stageBlend[2] + a.stageBlend[3] + a.stageBlend[4], 0);
  eq('p=0 → bars/HUD hidden', a.chromeOpacity, 0);
  eq('p=0 → caption A', a.captionId, 'A');
  check('p=0 → no row closed', SEQUENCE_ROW_KEYS.every((k) => a.rows[k].phase !== 'closed'));
  check('p=0 → no check showing', SEQUENCE_ROW_KEYS.every((k) => a.rows[k].checkOpacity === 0));
  check(
    'p=0 → every actual bar is parked and invisible',
    SEQUENCE_ROW_KEYS.every((k) => a.rows[k].actualY === PARKED_LANE_Y && a.rows[k].actualOpacity === 0)
  );
  check('p=0 → nothing is drawn yet', SEQUENCE_ROW_KEYS.every((k) => a.rows[k].plannedWidth === 0));

  const d = sequenceStateAt(1);
  eq('p=1 → stage 4 visible', d.stageBlend[4], 1);
  eq('p=1 → stage 1/2/3 hidden', d.stageBlend[1] + d.stageBlend[2] + d.stageBlend[3], 0);
  eq('p=1 → bars/HUD visible', d.chromeOpacity, 1);
  eq('p=1 → caption D', d.captionId, 'D');
  eq('p=1 → HUD closed tone', d.hudTone, 'closed');
  check('p=1 → all six rows closed', SEQUENCE_ROW_KEYS.every((k) => d.rows[k].phase === 'closed'));
  check(
    'p=1 → every lane at 45% with its check on',
    SEQUENCE_ROW_KEYS.every(
      (k) => d.rows[k].laneOpacity === SEQUENCE_CLOSED_LANE_OPACITY && d.rows[k].checkOpacity === 1
    )
  );
}

// --- The KF A–D table is wired, not eyeballed -------------------------------

console.log('keyframe table');
for (const kf of SEQUENCE_KEYFRAMES) {
  const state = sequenceStateAt(kf.p);
  for (const key of SEQUENCE_ROW_KEYS) {
    const g = SEQUENCE_ROW_GEOMETRY[key];
    const phase = kf.phases[key];
    const plannedOffset = kf.plannedOffsets?.[key] ?? g.plannedOffset;
    const row = state.rows[key];

    eq(`KF ${kf.id} ${key} phase`, row.phase, phase);
    near(`KF ${kf.id} ${key} planned offset`, row.plannedOffset, plannedOffset);
    near(`KF ${kf.id} ${key} planned width`, row.plannedWidth, g.plannedWidth);
    near(`KF ${kf.id} ${key} actual width`, row.actualWidth, g.actualWidth);

    if (phase === 'planned') {
      // Parked below, invisible, at its own offset — the pen's `AL` lane.
      near(`KF ${kf.id} ${key} parked offset`, row.actualOffset, g.parkedOffset);
      near(`KF ${kf.id} ${key} parked lane`, row.actualY, PARKED_LANE_Y);
      near(`KF ${kf.id} ${key} parked invisible`, row.actualOpacity, 0);
    } else {
      // Revealed or closed: the actual bar sits immediately after the planned
      // bar, in the planned bar's own lane. This is the shape of the refresh.
      near(`KF ${kf.id} ${key} actual follows planned`, row.actualOffset, plannedOffset + g.plannedWidth);
      near(`KF ${kf.id} ${key} actual in the planned lane`, row.actualY, 0);
      near(`KF ${kf.id} ${key} actual visible`, row.actualOpacity, 1);
    }

    const closed = phase === 'closed';
    near(`KF ${kf.id} ${key} lane opacity`, row.laneOpacity, closed ? SEQUENCE_CLOSED_LANE_OPACITY : 1);
    near(`KF ${kf.id} ${key} check`, row.checkOpacity, closed ? 1 : 0);
    near(
      `KF ${kf.id} ${key} check x`,
      row.checkX,
      plannedOffset + g.plannedWidth + g.actualWidth + SEQUENCE_CHECK_GAP
    );
  }

  // The visible stage at that keyframe is the table's stage, via stageFor.
  eq(`KF ${kf.id} → stage ${kf.stage}`, stageFor(state.rows), kf.stage);
  // And the blend agrees with the stage: the keyframe's own stage is the one on.
  eq(`KF ${kf.id} → blend on the table stage`, state.stageBlend[kf.stage], 1);
  // The HUD reading is the keyframe's own.
  eq(`KF ${kf.id} → HUD tone`, state.hudTone, kf.hud.tone);
}

// --- A closed bar is NOT recoloured -----------------------------------------

console.log('the record survives closing');
{
  // The whole point of the refreshed idiom: closing dims the row and adds a
  // check. It does not repaint the agreed bar, because what was agreed and what
  // it took are both still the record. Nothing in the state names a colour, so
  // the strongest available assertion is that the two bars keep their widths and
  // their relative order at every p.
  const STEPS = 400;
  for (let i = 0; i <= STEPS; i += 1) {
    const p = i / STEPS;
    const s = sequenceStateAt(p);
    for (const key of SEQUENCE_ROW_KEYS) {
      const g = SEQUENCE_ROW_GEOMETRY[key];
      const row = s.rows[key];
      if (p > 0.15) {
        near(`${key} keeps its agreed width at p=${p.toFixed(3)}`, row.plannedWidth, g.plannedWidth);
        near(`${key} keeps its actual width at p=${p.toFixed(3)}`, row.actualWidth, g.actualWidth);
      }
      check(
        `${key} lane opacity in range at p=${p.toFixed(3)}`,
        row.laneOpacity >= SEQUENCE_CLOSED_LANE_OPACITY - 1e-9 && row.laneOpacity <= 1 + 1e-9
      );
    }
  }
}

// --- The chrome fade matches the pen ----------------------------------------

console.log('chrome fade (pen: opacity 0 through KF A, on for KF B)');
{
  const a = sequenceStateAt(SEQUENCE_KEYFRAMES[0].p);
  eq('bars/HUD hidden at KF A (pen)', a.chromeOpacity, 0);
  const b = sequenceStateAt(SEQUENCE_KEYFRAMES[1].p);
  eq('bars/HUD on at KF B (pen)', b.chromeOpacity, 1);
  near('bars/HUD half at the A→B midpoint', sequenceStateAt(0.275).chromeOpacity, 0.5);
  eq('bars/HUD fully on at p=1', sequenceStateAt(1).chromeOpacity, 1);
}

// --- Rule 2: the stage selector reads bar state and nothing else ------------

console.log('stage derives from bar state');
{
  const P = 'planned' as const;
  const R = 'revealed' as const;
  const C = 'closed' as const;
  const at = (...phases: SequenceRowPhase[]) =>
    stageFor(
      rowsWithPhases(
        Object.fromEntries(SEQUENCE_ROW_KEYS.map((k, i) => [k, phases[i]]))
      )
    );

  // The four rows of the table: 0 / 2 / 3 / 6 closed → stage 1 / 2 / 3 / 4.
  eq('nothing closed → 1', at(P, P, P, P, P, P), 1);
  eq('KF B shape (2 closed) → 2', at(C, C, R, P, P, P), 2);
  eq('KF C shape (3 closed) → 3', at(C, C, C, R, R, P), 3);
  eq('KF D shape (6 closed) → 4', at(C, C, C, C, C, C), 4);

  // Between the table's boundaries the stage holds rather than jumping.
  eq('one closed → still 1', at(C, P, P, P, P, P), 1);
  eq('four closed → still 3', at(C, C, C, C, P, P), 3);
  eq('five closed → still 3', at(C, C, C, C, C, P), 3);

  // Revealing a row is not closing it: the house does not advance on a reading.
  eq('revealing does not advance the stage', at(R, R, R, R, R, R), 1);

  // Same bar state ⇒ same stage, always. `stageFor` takes no `p`, so a leaked p
  // could not be called at all.
  eq('selector is unary', stageFor.length, 1);
}

// --- Monotonic: the house never un-builds -----------------------------------

console.log('monotonic advance and continuity');
{
  const STEPS = 2000;
  const RANK: Record<SequenceRowPhase, number> = { planned: 0, revealed: 1, closed: 2 };
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
      // A row only ever moves forward: planned → revealed → closed.
      check(
        `${key} phase never regresses at p=${p.toFixed(4)}`,
        RANK[s.rows[key].phase] >= RANK[prev.rows[key].phase],
        `${prev.rows[key].phase} → ${s.rows[key].phase}`
      );

      maxJump = Math.max(
        maxJump,
        Math.abs(s.rows[key].plannedOffset - prev.rows[key].plannedOffset),
        Math.abs(s.rows[key].actualOffset - prev.rows[key].actualOffset),
        Math.abs(s.rows[key].plannedWidth - prev.rows[key].plannedWidth),
        Math.abs(s.rows[key].actualWidth - prev.rows[key].actualWidth)
      );
      check(`${key} widths non-negative at p=${p.toFixed(4)}`, s.rows[key].plannedWidth >= 0 && s.rows[key].actualWidth >= 0);
    }
    prev = s;
  }

  check('geometry is continuous', maxJump < 1, `largest single-step move was ${maxJump.toFixed(4)} units`);
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
