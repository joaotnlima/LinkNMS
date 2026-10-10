// Unit tests for the shared project model's wire → view arithmetic (PRD-07).
//
// Pinned: M-3 colours and legend with "not linked"; M-4 `?task=` isolates a
// task with its sub-tasks (id or outline code); M-8 the UI's scope mirror;
// M-11 the private draft folds opposites and renders as Record lines; M-15
// "edited by" + "author review pending"; M-16 file diff by GlobalId; M-18
// unmatched elements and the "GlobalIds regenerated" warning.
//
// Run: node --test src/lib/v2/model-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  colourContext, colourOf, legendRows, isolatedElements, resolveTaskParam, editableElements, canEditElement,
  addChange, applyDraft, draftBody, draftLines, historyRows, compareIndexes, uploadCheck, editorOfTask,
  NEUTRAL, STATUS_COLOURS,
} from './model-view.ts';

const tasks = [
  { id: 'roof', code: '2.5', name: 'Roofing', parent_id: null, status: 'in_progress', assignee_org_id: 'tn', assignee_org_name: 'Telhados', element_count: 2 },
  { id: 'tiles', code: '2.5.2', name: 'Tiles', parent_id: 'roof', status: 'not_started', assignee_org_id: 'tn', assignee_org_name: 'Telhados', element_count: 1 },
  { id: 'frame', code: '2.3', name: 'Frame', parent_id: null, status: 'done', assignee_org_id: null, assignee_org_name: null, element_count: 1 },
];
const editors = [
  { org_id: 'arch', role: 'author', task_ids: [], element_count: null },
  { org_id: 'owner', role: 'owner', task_ids: [], element_count: null },
  { org_id: 'gc', role: 'branch', task_ids: ['roof', 'tiles', 'frame'], element_count: 3 },
  { org_id: 'tn', role: 'branch', task_ids: ['roof', 'tiles'], element_count: 2 },
];
const model = { tasks, access: { readers: 'participants', editors, unassigned_tasks: [] } };
const links = [
  { global_id: 'A', task_id: 'roof' }, { global_id: 'B', task_id: 'roof' }, { global_id: 'B', task_id: 'tiles' },
  { global_id: 'C', task_id: 'frame' },
];

test('M-3: colour by task (deepest row wins), status and who edits; unlinked is neutral', () => {
  const ctx = colourContext(model, links);
  assert.equal(colourOf('task', 'B', ctx), ctx.taskColour.get('tiles'));
  assert.equal(colourOf('status', 'C', ctx), STATUS_COLOURS.done);
  assert.equal(editorOfTask('tiles', editors), 'tn', 'the narrowest branch editor');
  assert.equal(colourOf('editor', 'A', ctx), ctx.orgColour.get('tn'));
  assert.equal(colourOf('task', 'Z', ctx), null);
  const rows = legendRows('task', model, links, 10, (id) => id);
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [['2.5 Roofing', 2], ['2.5.2 Tiles', 1], ['2.3 Frame', 1], ['Not linked to any task', 7]]);
  assert.equal(rows.at(-1).colour, NEUTRAL);
  assert.deepEqual(legendRows('status', model, links, 3, (id) => id).map((r) => r.key), ['not_started', 'in_progress', 'done', 'unlinked']);
});

test('M-4: ?task= isolates the task and its sub-tasks, by id or outline code', () => {
  assert.equal(resolveTaskParam('2.5', tasks), 'roof');
  assert.equal(resolveTaskParam('tiles', tasks), 'tiles');
  assert.equal(resolveTaskParam('9.9', tasks), null);
  assert.deepEqual([...isolatedElements('roof', tasks, links)].sort(), ['A', 'B']);
  assert.deepEqual([...isolatedElements('tiles', tasks, links)], ['B']);
});

test('M-8 mirror: whole model for author/owner, linked elements of scoped rows otherwise', () => {
  assert.equal(editableElements({ viewer: { scope: { kind: 'owner', task_ids: [] } } }, links), 'all');
  const tn = editableElements({ viewer: { scope: { kind: 'tasks', task_ids: ['tiles'] } } }, links);
  assert.ok(canEditElement(tn, 'B'));
  assert.ok(!canEditElement(tn, 'A'));
});

test('M-11: the draft folds opposites, applies on the record and becomes the save body', () => {
  let d = { baseVersion: 4, changes: [] };
  d = addChange(d, { op: 'link', globalId: 'C', taskId: 'tiles' });
  d = addChange(d, { op: 'link', globalId: 'C', taskId: 'tiles' });
  d = addChange(d, { op: 'unlink', globalId: 'A', taskId: 'roof' });
  d = addChange(d, { op: 'link', globalId: 'A', taskId: 'roof' });
  d = addChange(d, { op: 'pin', pin: { id: 'p1', globalIds: ['B'], taskIds: ['roof', 'frame'], text: 'Ridge clash' } });
  assert.equal(d.changes.length, 2, 'duplicate folded, link/unlink cancelled');
  const view = applyDraft([{ global_id: 'A', task_id: 'roof', added_in_version: 1 }], [], d);
  assert.deepEqual(view.links.map((l) => `${l.global_id}|${l.task_id}`), ['A|roof', 'C|tiles']);
  assert.equal(view.pins.length, 1);
  const body = draftBody(d, '  tiles to 2.5.2 ', { C: 'mine' });
  assert.deepEqual(body.changes[0], { op: 'link', global_id: 'C', task_id: 'tiles' });
  assert.equal(body.note, 'tiles to 2.5.2');
  assert.deepEqual(body.resolutions, { C: 'mine' });
  const lines = draftLines(d, (id) => id, (g) => `el ${g}`);
  assert.deepEqual(lines, ['Linked el C to tiles', 'Issue pinned on el B: “Ridge clash”']);
});

test('M-15: history newest first, "edited by", author review pending until the author saves again', () => {
  const v = (n, org, kind = 'upload', base) => ({ version_no: n, mime: 'x', size_bytes: 10, sha256: 's', uploaded_by: { org_id: org, person_id: 'p' }, uploaded_at: `2026-10-0${n}`, change_kind: kind, ...(base ? { base_version_no: base } : {}) });
  const doc = { id: 'd', current_version: 4, versions: [v(1, 'arch'), v(2, 'arch'), v(3, 'owner', 'edit', 2), v(4, 'arch', 'restore', 2)] };
  const rows = historyRows(doc, 'arch', (id) => ({ arch: 'Atelier', owner: 'Silva' }[id]));
  assert.deepEqual(rows.map((r) => r.versionNo), [4, 3, 2, 1]);
  assert.equal(rows[1].label, 'Edited by Silva');
  assert.equal(rows[1].authorReviewPending, false, 'the author saved v4 after it');
  assert.equal(rows[0].label, 'Restored v2 — Atelier');
  assert.ok(rows[0].current);
  const pending = historyRows({ ...doc, current_version: 3, versions: doc.versions.slice(0, 3) }, 'arch', (id) => id);
  assert.equal(pending[0].authorReviewPending, true);
});

test('M-16 / M-18: compare by GlobalId; unmatched records; regenerated GlobalIds warn', () => {
  const a = new Map([['A', { name: 'Skylight', cls: 'IFCWINDOW', props: { Width: '1.14' } }], ['B', { name: 'Tile', cls: 'IFCCOVERING', props: {} }]]);
  const b = new Map([['A', { name: 'Skylight', cls: 'IFCWINDOW', props: { Width: '0.94' } }], ['D', { name: 'Gutter', cls: 'IFCPIPESEGMENT', props: {} }]]);
  const diff = compareIndexes(a, b);
  assert.deepEqual(diff.added.map((x) => x.globalId), ['D']);
  assert.deepEqual(diff.removed.map((x) => x.globalId), ['B']);
  assert.deepEqual(diff.changed[0].changes, [{ key: 'Width', from: '1.14', to: '0.94' }]);
  const check = uploadCheck(a, b, [{ global_id: 'B' }], [{ global_ids: ['A', 'Q'] }]);
  assert.deepEqual(check.unmatched, ['B', 'Q']);
  assert.equal(check.regenerated, false);
  const many = (p) => new Map(Array.from({ length: 20 }, (_, i) => [`${p}${i}`, { name: '', cls: '', props: {} }]));
  assert.equal(uploadCheck(many('x'), many('y'), [], []).regenerated, true, '"all removed, all added"');
});
