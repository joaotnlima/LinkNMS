// Unit tests for the v2 created-row rekey (LINA-369, S3b).
//
// The rules worth pinning: after a save, a created row's author-local key becomes
// the v2 id the server minted, IN the live draft tree and the last-saved wire
// tree alike — and any edge pointing AT that row follows it. A key the map does
// not name (a row added since the save, an existing v2-id row) is left exactly as
// it was. `rekeyDraft` walks `{on}` edges; `rekeyWire` walks `{key}` edges. Both
// return fresh trees. `draftKeys` lists every node key in document order.
//
// Run: node --experimental-strip-types --test src/lib/v2/plan-rekey.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rekeyDraft, rekeyWire, draftKeys } from './plan-rekey.ts';

// A minimal PhaseDraft node factory — only the fields the rekey touches matter.
const t = (key, dependsOn = [], children = []) => ({
  key, name: key, start: '', end: '', description: '',
  dependsOn, assigneePartyId: null, trade: '', children,
});
const p = (key, tasks = [], dependsOn = []) => ({
  key, name: key, tasks, dependsOn, assigneePartyId: null, trade: '',
});

test('rekeyDraft: created keys adopt their v2 ids, unmapped keys are left alone', () => {
  const phases = [p('p-1', [t('t-1'), t('t-2')])];
  const out = rekeyDraft(phases, { 'p-1': 'PID', 't-1': 'T1ID' });
  assert.equal(out[0].key, 'PID');
  assert.equal(out[0].tasks[0].key, 'T1ID');
  assert.equal(out[0].tasks[1].key, 't-2', 'a key the map does not name stays local');
});

test('rekeyDraft: an edge pointing at a rekeyed row follows it to the new id', () => {
  const phases = [p('p-1', [
    t('t-1'),
    t('t-2', [{ on: 't-1', type: 'starts_after' }]),
  ])];
  const out = rekeyDraft(phases, { 't-1': 'T1ID' });
  assert.deepEqual(out[0].tasks[1].dependsOn, [{ on: 'T1ID', type: 'starts_after' }]);
});

test('rekeyDraft: an edge onto an unmapped row keeps its reference', () => {
  const phases = [p('p-1', [t('t-9', [{ on: 't-8', type: 'ends_with' }])])];
  const out = rekeyDraft(phases, { 't-1': 'T1ID' });
  assert.deepEqual(out[0].tasks[0].dependsOn, [{ on: 't-8', type: 'ends_with' }]);
});

test('rekeyDraft: recurses into sub-tasks (the third level)', () => {
  const phases = [p('p-1', [t('t-1', [], [t('s-1', [{ on: 't-1', type: 'starts_with' }])])])];
  const out = rekeyDraft(phases, { 't-1': 'T1ID', 's-1': 'S1ID' });
  assert.equal(out[0].tasks[0].children[0].key, 'S1ID');
  assert.deepEqual(out[0].tasks[0].children[0].dependsOn, [{ on: 'T1ID', type: 'starts_with' }]);
});

test('rekeyDraft: preserves the fields it does not touch, and returns a fresh tree', () => {
  const src = [p('p-1', [{ ...t('t-1'), name: 'Framing', trade: 'Carpentry', assigneePartyId: 'party-x', start: '2026-03-01' }])];
  const out = rekeyDraft(src, { 't-1': 'T1ID' });
  const row = out[0].tasks[0];
  assert.equal(row.name, 'Framing');
  assert.equal(row.trade, 'Carpentry');
  assert.equal(row.assigneePartyId, 'party-x');
  assert.equal(row.start, '2026-03-01');
  assert.notEqual(out, src, 'a new array');
  assert.notEqual(out[0].tasks[0], src[0].tasks[0], 'a new node');
});

test('rekeyDraft: tolerates a task with no children field', () => {
  const bare = { key: 't-1', name: 'x', start: '', end: '', description: '', dependsOn: [], assigneePartyId: null, trade: '' };
  const out = rekeyDraft([p('p-1', [bare])], { 't-1': 'T1ID' });
  assert.equal(out[0].tasks[0].key, 'T1ID');
  assert.deepEqual(out[0].tasks[0].children, []);
});

test('rekeyWire: node keys and {key} edges remap; children recurse', () => {
  const wire = [{
    key: 'p-1', name: 'P', dependsOn: [], children: [
      { key: 't-1', name: 'A', dependsOn: [] },
      { key: 't-2', name: 'B', dependsOn: [{ key: 't-1', type: 'starts_after' }] },
    ],
  }];
  const out = rekeyWire(wire, { 'p-1': 'PID', 't-1': 'T1ID' });
  assert.equal(out[0].key, 'PID');
  assert.equal(out[0].children[0].key, 'T1ID');
  assert.equal(out[0].children[1].key, 't-2');
  assert.deepEqual(out[0].children[1].dependsOn, [{ key: 'T1ID', type: 'starts_after' }]);
});

test('rekeyWire: a node with no children field stays flat', () => {
  const out = rekeyWire([{ key: 't-1', name: 'A', dependsOn: [] }], { 't-1': 'T1ID' });
  assert.equal(out[0].key, 'T1ID');
  assert.equal('children' in out[0], false);
});

test('empty idByKey: draft and wire pass through unchanged (value-equal, fresh copy)', () => {
  const phases = [p('p-1', [t('t-1', [{ on: 't-2', type: 'ends_with' }]), t('t-2')])];
  const out = rekeyDraft(phases, {});
  assert.deepEqual(out, phases);
  assert.notEqual(out, phases);
});

test('draftKeys: every node key, in document order, after a rekey reads the v2 ids', () => {
  const phases = rekeyDraft(
    [p('p-1', [t('t-1', [], [t('s-1')]), t('t-2')]), p('p-2')],
    { 'p-1': 'PID', 't-1': 'T1ID', 's-1': 'S1ID', 't-2': 'T2ID', 'p-2': 'P2ID' },
  );
  assert.deepEqual(draftKeys(phases), ['PID', 'T1ID', 'S1ID', 'T2ID', 'P2ID']);
});
