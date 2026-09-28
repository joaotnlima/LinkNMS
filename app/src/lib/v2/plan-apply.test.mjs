// Unit tests for the v2 plan-grid draft→operations transforms (LINA-320, S3).
//
// The rules worth pinning: the editor's validated `AuthoredNode[]` tree flattens
// into ONE `create_rows` batch; row ids are client-minted and a child's
// `parent_id` is its parent's minted id; the traversal is PRE-ORDER so a parent
// is always emitted before its children (the server inserts in list order);
// typed dependencies map to anchor pairs (the exact inverse of the read seam) and
// an edge pointing outside the batch is DROPPED, not sent; and the returned
// key→id map is complete so the editor can target follow-up ops.
//
// Run: node --experimental-strip-types --test src/lib/v2/plan-apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toLinkAnchors, authoredToCreateBatch } from './plan-apply.ts';

// A deterministic id minter — the whole reason `mintId` is injected. Tests read
// far better with predictable ids than with real UUIDs.
const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};

// A minimal AuthoredNode (the shape `plan-authoring.ts#toWire` emits). Only the
// fields the transform reads matter; the rest default the way toWire would send.
const node = (over = {}) => ({
  name: 'Node', key: 'k', dependsOn: [],
  description: null, assigneePartyId: null, trade: null,
  plannedStartDate: null, plannedEndDate: null,
  ...over,
});

test('toLinkAnchors: the exact inverse of the read seam', () => {
  assert.deepEqual(toLinkAnchors('starts_after'), { from_anchor: 'end', to_anchor: 'start' });
  assert.deepEqual(toLinkAnchors('starts_with'), { from_anchor: 'start', to_anchor: 'start' });
  assert.deepEqual(toLinkAnchors('ends_with'), { from_anchor: 'end', to_anchor: 'end' });
});

test('one create_rows batch carries every node, parents before children', () => {
  const nodes = [
    node({
      key: 'phase', name: 'Phase',
      children: [
        node({ key: 'task', name: 'Task', children: [node({ key: 'sub', name: 'Sub' })] }),
      ],
    }),
  ];
  const { request } = authoredToCreateBatch(nodes, counter(), 'cc-1');
  assert.equal(request.operations.length, 1);
  const op = request.operations[0];
  assert.equal(op.op, 'create_rows');
  assert.equal(request.client_change_id, 'cc-1');

  // Pre-order: phase, then task, then sub — a parent always before its children.
  assert.deepEqual(op.rows.map((r) => r.name), ['Phase', 'Task', 'Sub']);
  // parent_id chains by minted id.
  const [phase, taskRow, sub] = op.rows;
  assert.equal(phase.parent_id, null);
  assert.equal(taskRow.parent_id, phase.id);
  assert.equal(sub.parent_id, taskRow.id);
});

test('dates set dating_mode and pass through; an undated row is undated', () => {
  const nodes = [
    node({ key: 'dated', name: 'Dated', plannedStartDate: '2026-03-01', plannedEndDate: '2026-03-05' }),
    node({ key: 'blank', name: 'Blank' }),
  ];
  const { request } = authoredToCreateBatch(nodes, counter(), 'cc');
  const [dated, blank] = request.operations[0].rows;
  assert.equal(dated.dating_mode, 'dated');
  assert.equal(dated.start, '2026-03-01');
  assert.equal(dated.finish, '2026-03-05');
  assert.equal(blank.dating_mode, 'undated');
  // No start/finish keys on an undated row rather than explicit nulls the server
  // would have to interpret.
  assert.equal('start' in blank, false);
  assert.equal('finish' in blank, false);
});

test('specialty + description ride the spec; empty ones are omitted', () => {
  const nodes = [
    node({ key: 'a', name: 'A', trade: 'Electrical', description: 'wire it' }),
    node({ key: 'b', name: 'B' }),
  ];
  const { request } = authoredToCreateBatch(nodes, counter(), 'cc');
  const [a, b] = request.operations[0].rows;
  assert.equal(a.specialty, 'Electrical');
  assert.equal(a.description, 'wire it');
  assert.equal('specialty' in b, false);
  assert.equal('description' in b, false);
});

test('typed deps become link specs keyed by minted id', () => {
  const nodes = [
    node({ key: 'first', name: 'First' }),
    node({ key: 'second', name: 'Second', dependsOn: [{ key: 'first', type: 'starts_after' }] }),
  ];
  const { request, idByKey } = authoredToCreateBatch(nodes, counter(), 'cc');
  const { rows, links } = request.operations[0];
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], {
    predecessor_id: idByKey.first,
    successor_id: idByKey.second,
    from_anchor: 'end',
    to_anchor: 'start',
  });
  // Sanity: the ids the link names are the rows' ids.
  assert.equal(rows[0].id, idByKey.first);
  assert.equal(rows[1].id, idByKey.second);
});

test('an edge pointing outside the batch is dropped, not sent', () => {
  const nodes = [
    node({ key: 'only', name: 'Only', dependsOn: [{ key: 'ghost', type: 'starts_with' }] }),
  ];
  const { request } = authoredToCreateBatch(nodes, counter(), 'cc');
  assert.deepEqual(request.operations[0].links, []);
});

test('idByKey is complete — every node keyed to its minted row id', () => {
  const nodes = [
    node({ key: 'p', name: 'P', children: [node({ key: 't', name: 'T' })] }),
  ];
  const { request, idByKey } = authoredToCreateBatch(nodes, counter(), 'cc');
  assert.deepEqual(Object.keys(idByKey).sort(), ['p', 't']);
  assert.equal(idByKey.p, request.operations[0].rows[0].id);
  assert.equal(idByKey.t, request.operations[0].rows[1].id);
});
