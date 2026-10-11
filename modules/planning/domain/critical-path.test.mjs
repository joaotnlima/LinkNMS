// One critical-path rule for the plan view and the tender alert (audit S4b).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { criticalTaskIds } from './critical-path.mjs';
import { makeCalendar, shiftWorkingDays, spanFinish, durationWd } from './calendar.mjs';
import { propagate, effectiveSpans } from './propagation.mjs';

const cal = makeCalendar({ work_days: [1, 2, 3, 4, 5], holidays: [], closures: [] });
const row = (id, parentId, start, finish, over = {}) => [id, {
  id, parentId, start, finish, kind: 'task', datingMode: 'dated', actualFinish: null, ...over,
}];

test('the chain that sets the finish is critical, its summaries light; a slack branch and a done row do not', () => {
  // 2027-02-01 is a Monday. A (Mon–Fri) → B (next Mon–Fri) sets the finish; C is short and unlinked.
  const tasks = new Map([
    row('S', null, null, null, { kind: 'summary' }),
    row('A', 'S', '2027-02-01', '2027-02-05'),
    row('B', 'S', '2027-02-08', '2027-02-12'),
    row('C', null, '2027-02-01', '2027-02-02'),
  ]);
  const links = [{ id: 'l', predecessorId: 'A', successorId: 'B', fromAnchor: 'end', toAnchor: 'start', lagWd: 0 }];
  const ids = criticalTaskIds({ tasks, links, calendar: cal });
  assert.deepEqual([...ids].sort(), ['A', 'B', 'S']);
  tasks.set('B', { ...tasks.get('B'), actualFinish: '2027-02-12' });
  assert.ok(!criticalTaskIds({ tasks, links, calendar: cal }).has('B'), 'a finished row never moves');
});

// ── the linear pass agrees with a propagate-per-leaf probe ────────────────────
/** The rule as a probe: slip each open dated leaf by one working day, push it with the engine. */
function probeCritical(tasks, links) {
  const kids = new Map();
  for (const t of tasks.values()) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t.id]);
  const finishOf = (m) => {
    const sp = effectiveSpans(m);
    let f = null;
    for (const t of m.values()) if (!kids.has(t.id)) { const x = sp.get(t.id)?.finish; if (x && (!f || x > f)) f = x; }
    return f;
  };
  const finish = finishOf(tasks);
  const spans = effectiveSpans(tasks);
  const out = new Set();
  for (const [id, t] of tasks) {
    const span = spans.get(id);
    if (kids.has(id) || t.actualFinish || !span?.start || !span?.finish) continue;
    const work = new Map(tasks);
    work.set(id, { ...t, finish: spanFinish(cal, span.start, durationWd(cal, span.start, span.finish) + 1) });
    const ancestors = [];
    for (let c = t.parentId; c; c = tasks.get(c).parentId) ancestors.push(c);
    for (const m of propagate({ tasks: work, links, calendar: cal, seedIds: [id, ...ancestors] }).moves) {
      work.set(m.id, { ...work.get(m.id), start: m.start, finish: m.finish });
    }
    if (finishOf(work) > finish) for (let c = id; c && !out.has(c); c = tasks.get(c).parentId) out.add(c);
  }
  return out;
}

test('generated plans (links between leaves, done and started rows): the linear pass = the probe', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const anchors = [['end', 'start'], ['end', 'start'], ['start', 'start'], ['end', 'end']];
  let compared = 0;
  for (let trial = 0; trial < 200; trial += 1) {
    const tasks = new Map();
    const ids = [];
    const n = 4 + Math.floor(rnd() * 14);
    for (let i = 0; i < n; i += 1) {
      const id = `r${i}`;
      const parentId = i > 0 && rnd() < 0.35 ? ids[Math.floor(rnd() * ids.length)] : null;
      const start = shiftWorkingDays(cal, '2027-02-01', Math.floor(rnd() * 20));
      const finish = spanFinish(cal, start, 1 + Math.floor(rnd() * 5));
      const done = rnd() < 0.08;
      const started = !done && rnd() < 0.1;
      tasks.set(id, { id, parentId, start, finish, kind: 'task', actualFinish: done ? finish : null, actualStart: done || started ? start : null });
      ids.push(id);
    }
    const parents = new Set([...tasks.values()].map((t) => t.parentId).filter(Boolean));
    for (const id of parents) tasks.set(id, { ...tasks.get(id), actualStart: null, actualFinish: null });
    const links = [];
    for (let k = 0; k < n; k += 1) {
      const a = Math.floor(rnd() * n);
      const b = Math.floor(rnd() * n);
      if (a >= b || parents.has(ids[a]) || parents.has(ids[b])) continue;
      const [fromAnchor, toAnchor] = anchors[Math.floor(rnd() * anchors.length)];
      links.push({ id: `l${k}`, predecessorId: ids[a], successorId: ids[b], fromAnchor, toAnchor, lagWd: Math.floor(rnd() * 3) });
    }
    let settled = false;
    for (let it = 0; it < 8 && !settled; it += 1) {
      const { moves } = propagate({ tasks, links, calendar: cal, seedIds: ids });
      settled = moves.length === 0;
      for (const m of moves) tasks.set(m.id, { ...tasks.get(m.id), start: m.start, finish: m.finish });
    }
    if (!settled) continue;
    compared += 1;
    assert.deepEqual([...criticalTaskIds({ tasks, links, calendar: cal })].sort(), [...probeCritical(tasks, links)].sort(), `trial ${trial}`);
  }
  assert.ok(compared > 150);
});
