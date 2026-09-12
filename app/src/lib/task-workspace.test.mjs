// Unit tests for the task-workspace client helpers (LINA-250).
//
// The screen is copy + layout; these are the seams that can be wrong silently:
//   1. `stageKeysOf` decides whether a task shows a thread or "save the plan
//      first" — a false positive there posts a comment to a key that 404s;
//   2. `findStageByKey` is what the permalink route resolves a URL against, and
//      what turns an unknown key into notFound();
//   3. relative time and byte sizes are printed beside a person's words, so they
//      have to be boringly right (and time must never read into the future).
//
// Run: node --test --experimental-strip-types src/lib/task-workspace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findStageByKey, formatBytes, relativeTime, stageKeysOf, taskPath,
} from './task-workspace.ts';

const node = (name, key, children = []) => ({
  id: `id-${name}`, name, position: 0, trade: null, key,
  plannedStartDate: null, plannedEndDate: null, plannedCostCents: null, children,
});

const TREE = [
  node('Pre-Construction', 'p-1', [
    node('Design', 't-1', [node('Drawings', 's-1')]),
    node('Permits', 't-2'),
  ]),
  // Import-seeded stages carry no key at all (contract §1) — they are absent
  // from the set rather than keyed on null.
  node('Construction', null, [node('Foundations', null)]),
];

test('stageKeysOf: every persisted key, at every level, and nothing keyless', () => {
  const keys = stageKeysOf(TREE);
  assert.deepEqual([...keys].sort(), ['p-1', 's-1', 't-1', 't-2']);
  assert.equal(stageKeysOf(null).size, 0);
  assert.equal(stageKeysOf(undefined).size, 0);
});

test('findStageByKey: finds a phase, a task and a sub-task, with the trail above it', () => {
  assert.equal(findStageByKey(TREE, 'p-1').depth, 0);
  assert.deepEqual(findStageByKey(TREE, 'p-1').trail, []);

  const task = findStageByKey(TREE, 't-2');
  assert.equal(task.node.name, 'Permits');
  assert.deepEqual(task.trail, ['Pre-Construction']);
  assert.equal(task.depth, 1);

  const sub = findStageByKey(TREE, 's-1');
  assert.equal(sub.node.name, 'Drawings');
  assert.deepEqual(sub.trail, ['Pre-Construction', 'Design']);
  assert.equal(sub.depth, 2);
});

test('findStageByKey: an unknown or empty key is null — the route 404s on it', () => {
  assert.equal(findStageByKey(TREE, 't-99'), null);
  assert.equal(findStageByKey(TREE, ''), null);
  assert.equal(findStageByKey(null, 't-1'), null);
});

test('findStageByKey: a keyless stage is never matched by a null-ish key', () => {
  assert.equal(findStageByKey(TREE, 'null'), null);
  assert.equal(findStageByKey(TREE, 'undefined'), null);
});

test('taskPath: the shareable address, URL-safe in both segments', () => {
  assert.equal(taskPath('abc', 't-1'), '/projects/abc/plan/tasks/t-1');
  assert.equal(taskPath('a b', 'k/1'), '/projects/a%20b/plan/tasks/k%2F1');
});

test('formatBytes: orientation, not accounting', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(920), '920 B');
  assert.equal(formatBytes(8_200), '8.2 KB');
  assert.equal(formatBytes(120_000), '120 KB');
  assert.equal(formatBytes(1_433_600), '1.4 MB');
  assert.equal(formatBytes(-1), '—');
});

test('relativeTime: the ladder, and no clock that reads into the future', () => {
  const now = Date.parse('2026-09-12T12:00:00.000Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(ago(5_000), now), 'just now');
  assert.equal(relativeTime(ago(4 * 60_000), now), '4 min ago');
  assert.equal(relativeTime(ago(3 * 3_600_000), now), '3 h ago');
  assert.equal(relativeTime(ago(26 * 3_600_000), now), 'yesterday');
  assert.equal(relativeTime(ago(3 * 86_400_000), now), '3 days ago');
  // Past a week it is a date, because "11 days ago" stops being orientation.
  assert.match(relativeTime(ago(30 * 86_400_000), now), /2026/);
  // Skew: a timestamp from the future is the present, never a prediction.
  assert.equal(relativeTime(new Date(now + 60_000).toISOString(), now), 'just now');
  assert.equal(relativeTime('not a date', now), '');
});
