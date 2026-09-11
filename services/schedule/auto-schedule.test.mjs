// Contract tests for the auto-schedule engine (LINA-237).
//
// Pure module: no store, no ledger, no DB — just input → output.
// Run: node --test services/schedule/auto-schedule.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoSchedule } from './auto-schedule.mjs';

// ── basic: no stages / empty ───────────────────────────────────────────────

test('empty input returns empty computed map', () => {
  const { computed } = autoSchedule([]);
  assert.equal(computed.size, 0);
});

test('undefined input returns empty computed map', () => {
  const { computed } = autoSchedule(undefined);
  assert.equal(computed.size, 0);
});

// ── anchor: stages with both dates are never moved ─────────────────────────

test('a stage with both dates is an anchor — not in computed output', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-03-01', plannedEndDate: '2026-03-05', dependsOn: [] },
  ]);
  assert.equal(computed.size, 0, 'anchors are not computed');
});

// ── half-dated normalisation ───────────────────────────────────────────────

test('a stage with only start date gets end = start (1-day default)', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-03-10', dependsOn: [] },
  ]);
  assert.equal(computed.size, 1);
  const dates = computed.get('a');
  assert.equal(dates.plannedStartDate, '2026-03-10');
  assert.equal(dates.plannedEndDate, '2026-03-10');
});

test('a stage with only end date gets start = end (1-day default)', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedEndDate: '2026-03-15', dependsOn: [] },
  ]);
  assert.equal(computed.size, 1);
  const dates = computed.get('a');
  assert.equal(dates.plannedStartDate, '2026-03-15');
  assert.equal(dates.plannedEndDate, '2026-03-15');
});

// ── forward scheduling: dependency chain ───────────────────────────────────

test('A → B → C: each computed stage starts the day after its predecessor ends', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-01-05', plannedEndDate: '2026-01-10', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['b'] },
  ]);

  // a is an anchor (both dates set) — not in output.
  assert.equal(computed.has('a'), false);

  const b = computed.get('b');
  assert.ok(b, 'b is computed');
  assert.equal(b.plannedStartDate, '2026-01-11', 'b starts day after a ends');
  assert.equal(b.plannedEndDate, '2026-01-11', 'b is 1 day (default)');

  const c = computed.get('c');
  assert.ok(c, 'c is computed');
  assert.equal(c.plannedStartDate, '2026-01-12', 'c starts day after b ends');
  assert.equal(c.plannedEndDate, '2026-01-12');
});

// ── fan-in: multiple predecessors ──────────────────────────────────────────

test('C depends on A and B — C starts after the LATER of the two predecessors', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-05', dependsOn: [] },
    { id: 'b', plannedStartDate: '2026-02-03', plannedEndDate: '2026-02-10', dependsOn: [] },
    { id: 'c', dependsOn: ['a', 'b'] },
  ]);

  const c = computed.get('c');
  assert.ok(c);
  assert.equal(c.plannedStartDate, '2026-02-11', 'c starts day after b (the later predecessor)');
  assert.equal(c.plannedEndDate, '2026-02-11');
});

// ── fan-out: one predecessor, multiple dependents ──────────────────────────

test('A → B and A → C: both B and C start the day after A ends', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-03-01', plannedEndDate: '2026-03-03', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
  ]);

  const b = computed.get('b');
  const c = computed.get('c');
  assert.equal(b.plannedStartDate, '2026-03-04');
  assert.equal(c.plannedStartDate, '2026-03-04');
});

// ── diamond: A → B, A → C, B+C → D ───────────────────────────────────────

test('diamond: D starts after both B and C finish', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-04-01', plannedEndDate: '2026-04-01', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },
  ]);

  // a = Apr 1 (1 day) → b = Apr 2, c = Apr 2 → d = Apr 3
  const b = computed.get('b');
  const c = computed.get('c');
  const d = computed.get('d');
  assert.equal(b.plannedStartDate, '2026-04-02');
  assert.equal(c.plannedStartDate, '2026-04-02');
  assert.equal(d.plannedStartDate, '2026-04-03');
  assert.equal(d.plannedEndDate, '2026-04-03');
});

// ── mixed: some dated, some not ────────────────────────────────────────────

test('only undated stages are computed; dated stages are anchors', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-05-01', plannedEndDate: '2026-05-03', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', plannedStartDate: '2026-05-10', plannedEndDate: '2026-05-12', dependsOn: ['b'] },
    { id: 'd', dependsOn: ['c'] },
  ]);

  // a anchor, b computed from a, c anchor (override), d computed from c.
  assert.equal(computed.has('a'), false);
  assert.equal(computed.has('c'), false);

  const b = computed.get('b');
  assert.equal(b.plannedStartDate, '2026-05-04', 'b starts after a ends');
  assert.equal(b.plannedEndDate, '2026-05-04');

  const d = computed.get('d');
  assert.equal(d.plannedStartDate, '2026-05-13', 'd starts after c ends (the anchor)');
  assert.equal(d.plannedEndDate, '2026-05-13');
});

// ── no dependencies, no dates → stays undated ──────────────────────────────

test('stages with no dependencies and no dates remain undated', () => {
  const { computed } = autoSchedule([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: [] },
  ]);
  assert.equal(computed.size, 0);
});

// ── partial graph: some predecessors dated, some not ───────────────────────

test('C depends on A (dated) and B (undated) — C stays undated until B is resolved', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-06-01', plannedEndDate: '2026-06-05', dependsOn: [] },
    { id: 'b', dependsOn: [] },
    { id: 'c', dependsOn: ['a', 'b'] },
  ]);

  // b has no dates and no deps → stays undated; c can't be computed.
  assert.equal(computed.has('b'), false);
  assert.equal(computed.has('c'), false);
});

// ── long chain stress test ─────────────────────────────────────────────────

test('chain of 10: each stage starts the day after the previous', () => {
  const stages = [];
  for (let i = 0; i < 10; i++) {
    stages.push({
      id: `s${i}`,
      dependsOn: i === 0 ? [] : [`s${i - 1}`],
      ...(i === 0 ? { plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-01' } : {}),
    });
  }

  const { computed } = autoSchedule(stages);

  for (let i = 1; i < 10; i++) {
    const d = computed.get(`s${i}`);
    assert.ok(d, `s${i} is computed`);
    // s0 = Jan 1, s1 = Jan 2, s2 = Jan 3, …
    const expected = `2026-01-${String(i + 1).padStart(2, '0')}`;
    assert.equal(d.plannedStartDate, expected, `s${i} starts on ${expected}`);
    assert.equal(d.plannedEndDate, expected, `s${i} ends on ${expected}`);
  }
});

// ── cross-level dependencies ───────────────────────────────────────────────

test('cross-level: a sub-action depends on a root from another phase', () => {
  const { computed } = autoSchedule([
    { id: 'phase1', plannedStartDate: '2026-07-01', plannedEndDate: '2026-07-10', dependsOn: [] },
    { id: 'task1.1', dependsOn: ['phase1'] },
    { id: 'phase2', dependsOn: ['task1.1'] },
    { id: 'task2.1', dependsOn: ['phase2'] },
  ]);

  const task11 = computed.get('task1.1');
  assert.equal(task11.plannedStartDate, '2026-07-11');

  const phase2 = computed.get('phase2');
  assert.equal(phase2.plannedStartDate, '2026-07-12');

  const task21 = computed.get('task2.1');
  assert.equal(task21.plannedStartDate, '2026-07-13');
});

// ── edge case: half-dated predecessor ──────────────────────────────────────

test('half-dated predecessor is normalised before forward pass', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-08-01', dependsOn: [] }, // only start → end = start
    { id: 'b', dependsOn: ['a'] },
  ]);

  const a = computed.get('a');
  assert.equal(a.plannedStartDate, '2026-08-01');
  assert.equal(a.plannedEndDate, '2026-08-01', 'half-dated a normalised to 1 day');

  const b = computed.get('b');
  assert.equal(b.plannedStartDate, '2026-08-02', 'b starts after normalised a');
});

// ── edge case: user-override after computation (anchor wins) ───────────────

test('user-set date on a later stage overrides the computed date', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-09-01', plannedEndDate: '2026-09-01', dependsOn: [] },
    { id: 'b', dependsOn: ['a'], plannedStartDate: '2026-09-10', plannedEndDate: '2026-09-15' },
    { id: 'c', dependsOn: ['b'] },
  ]);

  // b is an anchor (both dates set by user) — not computed.
  assert.equal(computed.has('b'), false);

  const c = computed.get('c');
  assert.equal(c.plannedStartDate, '2026-09-16', 'c starts after user-set b, not after a');
});

// ── error: unknown dependency ──────────────────────────────────────────────

test('throws on unknown dependency target', () => {
  assert.throws(
    () => autoSchedule([
      { id: 'a', dependsOn: ['nonexistent'] },
    ]),
    (e) => e.message.includes('nonexistent'),
  );
});

// ── no-cycle assumption (the graph is a DAG by contract) ───────────────────

test('works with a complex DAG (multiple paths, varying lengths)', () => {
  //   A(3d) ──→ B(1d) ──→ D
  //   A(3d) ──→ C(1d) ──→ D
  //   E(1d) ──→ D
  // D depends on B, C, E — starts after the latest (E ends latest)
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-10-01', plannedEndDate: '2026-10-03', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'e', plannedStartDate: '2026-10-05', plannedEndDate: '2026-10-05', dependsOn: [] },
    { id: 'd', dependsOn: ['b', 'c', 'e'] },
  ]);

  // a ends Oct 3 → b = Oct 4, c = Oct 4
  // e ends Oct 5 → d starts Oct 6 (day after e, the latest predecessor)
  const b = computed.get('b');
  const c = computed.get('c');
  const d = computed.get('d');
  assert.equal(b.plannedStartDate, '2026-10-04');
  assert.equal(c.plannedStartDate, '2026-10-04');
  assert.equal(d.plannedStartDate, '2026-10-06', 'd starts after e (the latest predecessor)');
  assert.equal(d.plannedEndDate, '2026-10-06');
});

// ── export shape ───────────────────────────────────────────────────────────

test('computed is a real Map, not a plain object', () => {
  const { computed } = autoSchedule([
    { id: 'a', plannedStartDate: '2026-01-01', dependsOn: [] },
  ]);
  assert.ok(computed instanceof Map);
});
