import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeCalendar } from './calendar.mjs';
import { cyclePath, effectiveSpans, propagate, lagFor, descendantIds } from './propagation.mjs';

const cal = makeCalendar({ work_days: [1, 2, 3, 4, 5] }); // plain Mon–Fri

const t = (id, over = {}) => [id, {
  id, parentId: null, kind: 'task', datingMode: 'dated',
  start: null, finish: null, durationWd: null,
  actualStart: null, actualFinish: null, deletedAt: null, ...over,
}];

const link = (predecessorId, successorId, fromAnchor, toAnchor, lagWd = 0, id = `${predecessorId}->${successorId}`) =>
  ({ id, predecessorId, successorId, fromAnchor, toAnchor, lagWd });

describe('cycles', () => {
  test('a link that closes a loop is caught, with its path', () => {
    const links = [link('a', 'b', 'end', 'start'), link('b', 'c', 'end', 'start')];
    const path = cyclePath(links, { predecessorId: 'c', successorId: 'a' });
    assert.deepEqual(path, ['c', 'a', 'b', 'c']);
    assert.equal(cyclePath(links, { predecessorId: 'a', successorId: 'c' }), null);
  });
});

describe('spans', () => {
  test('summary envelope derives from children; actuals override plans', () => {
    const tasks = new Map([
      t('sum', { kind: 'summary' }),
      t('a', { parentId: 'sum', start: '2026-09-21', finish: '2026-09-22', actualStart: '2026-09-23' }),
      t('b', { parentId: 'sum', start: '2026-09-24', finish: '2026-09-25' }),
    ]);
    const spans = effectiveSpans(tasks);
    assert.deepEqual(spans.get('sum'), { start: '2026-09-23', finish: '2026-09-25' });
    assert.deepEqual(spans.get('a'), { start: '2026-09-23', finish: '2026-09-22' });
  });
});

describe('propagation', () => {
  test('end→start pushes and pulls, keeping duration (rigid link)', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-21', finish: '2026-09-23' }),
      t('b', { start: '2026-09-24', finish: '2026-09-25' }),
    ]);
    const links = [link('a', 'b', 'end', 'start')];
    // push: a ends two working days later
    let r = propagate({ tasks: withDates(tasks, 'a', '2026-09-21', '2026-09-25'), links, calendar: cal, seedIds: ['a'] });
    assert.deepEqual(r.moves, [{ id: 'b', start: '2026-09-28', finish: '2026-09-29', causeTaskId: 'a' }]);
    // pull: a ends earlier
    r = propagate({ tasks: withDates(tasks, 'a', '2026-09-21', '2026-09-22'), links, calendar: cal, seedIds: ['a'] });
    assert.deepEqual(r.moves, [{ id: 'b', start: '2026-09-23', finish: '2026-09-24', causeTaskId: 'a' }]);
  });

  test('start→start and end→end hold their anchors; end→end moves the start too', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-21', finish: '2026-09-25' }),
      t('ss', { start: '2026-09-21', finish: '2026-09-22' }),
      t('ff', { start: '2026-09-24', finish: '2026-09-25' }),
    ]);
    const links = [link('a', 'ss', 'start', 'start', 1), link('a', 'ff', 'end', 'end')];
    // a slides one week later
    const r = propagate({ tasks: withDates(tasks, 'a', '2026-09-28', '2026-10-02'), links, calendar: cal, seedIds: ['a'] });
    const byId = Object.fromEntries(r.moves.map((m) => [m.id, m]));
    assert.deepEqual(byId.ss, { id: 'ss', start: '2026-09-29', finish: '2026-09-30', causeTaskId: 'a' });
    // doc 05 §4: extend the predecessor's end ⇒ FF successor ends later AND starts later
    assert.deepEqual(byId.ff, { id: 'ff', start: '2026-10-01', finish: '2026-10-02', causeTaskId: 'a' });
  });

  test('several incoming links: the successor sits at the latest position', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-21', finish: '2026-09-22' }),
      t('b', { start: '2026-09-21', finish: '2026-09-24' }),
      t('c', { start: '2026-09-23', finish: '2026-09-23' }),
    ]);
    const links = [link('a', 'c', 'end', 'start'), link('b', 'c', 'end', 'start')];
    const r = propagate({ tasks, links, calendar: cal, seedIds: ['a', 'b'] });
    assert.deepEqual(r.moves.map((m) => [m.id, m.start]), [['c', '2026-09-25']]);
  });

  test('lag counts working days and may be negative (overlap)', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-21', finish: '2026-09-25' }), // ends Friday
      t('b', { start: '2026-09-21', finish: '2026-09-21' }),
    ]);
    const r = propagate({
      tasks, links: [link('a', 'b', 'end', 'start', -2)], calendar: cal, seedIds: ['a'],
    });
    // zero-lag position is Monday 28th; -2 working days → Thursday 24th
    assert.deepEqual(r.moves, [{ id: 'b', start: '2026-09-24', finish: '2026-09-24', causeTaskId: 'a' }]);
  });

  test('undated rows and open external anchors are inert', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-21', finish: '2026-09-22' }),
      t('b', { datingMode: 'undated' }),
      t('ext', { datingMode: 'external', start: '2026-09-21', finish: null }),
      t('c', { start: '2026-09-23', finish: '2026-09-23' }),
    ]);
    const links = [
      link('a', 'b', 'end', 'start'),   // undated successor: nothing happens
      link('ext', 'c', 'end', 'start'), // open finish: no anchor yet
    ];
    const r = propagate({ tasks, links, calendar: cal, seedIds: ['a', 'ext'] });
    assert.deepEqual(r.moves, []);
  });

  test('a done row never moves; a started row keeps its actual start and warns', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-23', finish: '2026-09-25' }),
      t('done', { start: '2026-09-28', finish: '2026-09-28', actualStart: '2026-09-28', actualFinish: '2026-09-28' }),
      t('started', { start: '2026-09-28', finish: '2026-09-30', actualStart: '2026-09-28' }),
    ]);
    const links = [link('a', 'done', 'end', 'start'), link('a', 'started', 'end', 'start', 3)];
    const r = propagate({ tasks, links, calendar: cal, seedIds: ['a'] });
    assert.deepEqual(r.moves, []);
    assert.deepEqual(r.warnings, [{ id: 'started', code: 'held_at_actual_start' }]);
  });

  test('a chain propagates through, in order', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-21', finish: '2026-09-21' }),
      t('b', { start: '2026-09-22', finish: '2026-09-22' }),
      t('c', { start: '2026-09-23', finish: '2026-09-23' }),
    ]);
    const links = [link('a', 'b', 'end', 'start'), link('b', 'c', 'end', 'start')];
    const r = propagate({ tasks: withDates(tasks, 'a', '2026-09-23', '2026-09-23'), links, calendar: cal, seedIds: ['a'] });
    const byId = Object.fromEntries(r.moves.map((m) => [m.id, m.start]));
    assert.deepEqual(byId, { b: '2026-09-24', c: '2026-09-25' });
  });

  test('a linked summary shifts its whole subtree by the same working days', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-21', finish: '2026-09-21' }),
      t('sum', { kind: 'summary' }),
      t('s1', { parentId: 'sum', start: '2026-09-22', finish: '2026-09-23' }),
      t('s2', { parentId: 'sum', start: '2026-09-24', finish: '2026-09-25' }),
    ]);
    const links = [link('a', 'sum', 'end', 'start')];
    const r = propagate({ tasks: withDates(tasks, 'a', '2026-09-23', '2026-09-23'), links, calendar: cal, seedIds: ['a'] });
    const byId = Object.fromEntries(r.moves.map((m) => [m.id, [m.start, m.finish]]));
    assert.deepEqual(byId.s1, ['2026-09-24', '2026-09-25']);
    assert.deepEqual(byId.s2, ['2026-09-28', '2026-09-29']);
  });

  test('milestones keep start = finish', () => {
    const tasks = new Map([
      t('a', { start: '2026-09-21', finish: '2026-09-22' }),
      t('m', { kind: 'milestone', start: '2026-09-23', finish: '2026-09-23' }),
    ]);
    const r = propagate({
      tasks: withDates(tasks, 'a', '2026-09-21', '2026-09-24'),
      links: [link('a', 'm', 'end', 'start')], calendar: cal, seedIds: ['a'],
    });
    assert.deepEqual(r.moves, [{ id: 'm', start: '2026-09-25', finish: '2026-09-25', causeTaskId: 'a' }]);
  });
});

describe('lagFor', () => {
  test('dragging a linked successor stores the new offset', () => {
    const l = link('a', 'b', 'end', 'start');
    const predSpan = { start: '2026-09-21', finish: '2026-09-25' }; // zero-lag start = Mon 28th
    assert.equal(lagFor({ link: l, predSpan, succStart: '2026-10-01', calendar: cal }), 3);
    assert.equal(lagFor({ link: l, predSpan, succStart: '2026-09-24', calendar: cal }), -2);
  });
  test('end→end lag measures the finish offset', () => {
    const l = link('a', 'b', 'end', 'end');
    const predSpan = { start: '2026-09-21', finish: '2026-09-25' };
    assert.equal(lagFor({ link: l, predSpan, succFinish: '2026-09-29', calendar: cal }), 2);
  });
});

describe('descendants', () => {
  test('walks the whole subtree', () => {
    const tasks = new Map([t('r'), t('c1', { parentId: 'r' }), t('c2', { parentId: 'c1' })]);
    assert.deepEqual(descendantIds(tasks, 'r').sort(), ['c1', 'c2']);
  });
});

function withDates(tasks, id, start, finish) {
  const copy = new Map(tasks);
  copy.set(id, { ...copy.get(id), start, finish });
  return copy;
}
