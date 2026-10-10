// PRD-07 (D-45) record-side model edits, pure: validation, the M-8 scope,
// the M-14 merge of concurrent drafts, M-16 record diff, M-17 restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateModelEdits, editScope, scopeRefusals, mergeDraft, restorePlan, recordDiff,
  linksAt, touchedSince, scopeBody, elementCounts,
} from './project-model.mjs';

const T_ROOF = '00000000-0000-4000-8000-000000000025';
const T_TILES = '00000000-0000-4000-8000-000000000252';
const T_FRAME = '00000000-0000-4000-8000-000000000023';
const PIN = '00000000-0000-4000-8000-0000000000aa';
const gid = (n) => `${String(n).padStart(4, '0')}abcdefghijklmnopq$_`.slice(0, 22);
const ROOF_ORG = 'org-roof';

let seq = 0;
const row = (g, t, added, removed = null, by = 'org-author') => ({
  id: `l${seq += 1}`, global_id: g, task_id: t, added_in_version: added, removed_in_version: removed,
  created_by_org_id: by, removed_by_org_id: removed ? by : null,
});

test('validation: note required, ops typed, GlobalIds checked', () => {
  const { errors } = validateModelEdits({ base_version_no: 3, changes: [{ op: 'link', global_id: 'x', task_id: 'y' }] });
  assert.ok(errors.note && errors['changes[0].global_id'] && errors['changes[0].task_id']);
  const ok = validateModelEdits({
    base_version_no: 3, note: ' tiles to 2.5.2 ',
    changes: [{ op: 'link', global_id: gid(1), task_id: T_TILES.toUpperCase() },
      { op: 'pin', pin: { id: PIN, global_ids: [gid(1), gid(1)], task_ids: [T_ROOF], text: 'Ridge' } }],
    resolutions: { [gid(1)]: 'mine' },
  });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.edit.note, 'tiles to 2.5.2');
  assert.equal(ok.edit.changes[0].taskId, T_TILES, 'task ids normalised');
  assert.deepEqual(ok.edit.changes[1].pin.globalIds, [gid(1)], 'duplicates folded');
  assert.equal(ok.edit.resolutions.get(gid(1)), 'mine');
  assert.ok(validateModelEdits({ base_version_no: 1, note: 'x', changes: [{ op: 'move' }] }).errors['changes[0].op']);
});

test('AC2 / M-8: an awarded company links and pins only elements already on its rows', () => {
  const links = [row(gid(1), T_ROOF, 1), row(gid(2), T_FRAME, 1)];
  const scope = editScope({ whole: false, taskIds: [T_ROOF, T_TILES], links });
  const projectTaskIds = new Set([T_ROOF, T_TILES, T_FRAME]);
  const { edit } = validateModelEdits({
    base_version_no: 1, note: 'n',
    changes: [
      { op: 'link', global_id: gid(1), task_id: T_TILES },             // ok: element on 2.5, row 2.5.2
      { op: 'link', global_id: gid(2), task_id: T_TILES },             // element on the frame
      { op: 'link', global_id: gid(1), task_id: T_FRAME },             // row outside scope
      { op: 'pin', pin: { id: PIN, global_ids: [gid(1), gid(3)], task_ids: [T_FRAME], text: 'x' } }, // gid 3 unlinked
    ],
  });
  const refused = scopeRefusals(edit.changes, scope, { orgId: ROOF_ORG, projectTaskIds });
  assert.deepEqual(refused.map((r) => r.index), [1, 2, 3]);
  // The author / owner: the whole model.
  assert.deepEqual(scopeRefusals(edit.changes, editScope({ whole: true, links }), { projectTaskIds }), []);
  assert.deepEqual(scopeBody(scope, {}), { kind: 'tasks', task_ids: [T_ROOF, T_TILES], element_count: 1 });
  assert.equal(scopeBody(editScope({ whole: false, links }), {}).kind, 'none');
});

test('AC3 / M-14: two drafts on v3 with disjoint elements both apply; an overlap asks element by element', () => {
  const rows = [row(gid(1), T_ROOF, 1), row(gid(2), T_FRAME, 1)];
  // Draft A (roofer) saved first as v4: links gid 1 → tiles.
  rows.push(row(gid(1), T_TILES, 4, null, ROOF_ORG));
  // Draft B made on v3 touches gid 2 only → applies on top of v4.
  const b = mergeDraft({ base: 3, rows, pins: [], changes: [{ op: 'unlink', globalId: gid(2), taskId: T_FRAME }] });
  assert.deepEqual(b.conflicts, []);
  assert.equal(b.apply.unlinks.length, 1);
  // Draft C made on v3 touches gid 1 → conflict, never last-write-wins.
  const c = mergeDraft({ base: 3, rows, pins: [], changes: [{ op: 'unlink', globalId: gid(1), taskId: T_ROOF }] });
  assert.deepEqual(c.conflicts, [{ global_id: gid(1), version: 4, by_org_id: ROOF_ORG }]);
  assert.equal(c.apply.unlinks.length, 0);
  // Resolved: theirs drops the change, mine applies it.
  const theirs = mergeDraft({ base: 3, rows, pins: [], changes: [{ op: 'unlink', globalId: gid(1), taskId: T_ROOF }], resolutions: new Map([[gid(1), 'theirs']]) });
  assert.equal(theirs.dropped, 1);
  assert.equal(theirs.apply.unlinks.length, 0);
  const mine = mergeDraft({ base: 3, rows, pins: [], changes: [{ op: 'unlink', globalId: gid(1), taskId: T_ROOF }], resolutions: new Map([[gid(1), 'mine']]) });
  assert.equal(mine.apply.unlinks.length, 1);
  // A draft on the latest version never conflicts with itself; no-ops fold.
  const noop = mergeDraft({ base: 4, rows, pins: [], changes: [{ op: 'link', globalId: gid(1), taskId: T_TILES }, { op: 'link', globalId: gid(9), taskId: T_TILES }, { op: 'link', globalId: gid(9), taskId: T_TILES }] });
  assert.deepEqual(noop.apply.links, [{ globalId: gid(9), taskId: T_TILES }]);
});

test('pins: touched by a later pin; closing only an open pin', () => {
  const pins = [{ id: PIN, global_ids: [gid(5)], version_no: 6, state: 'open', author_org_id: ROOF_ORG }];
  assert.ok(touchedSince([], pins, 5).has(gid(5)));
  const m = mergeDraft({ base: 6, rows: [], pins, changes: [{ op: 'close_pin', pinId: PIN }, { op: 'close_pin', pinId: PIN }] });
  assert.deepEqual(m.apply.closes, [PIN]);
  const refused = scopeRefusals([{ op: 'close_pin', pinId: PIN }], editScope({ whole: false, links: [] }),
    { pinsById: new Map(pins.map((p) => [p.id, p])), orgId: 'org-other' });
  assert.equal(refused.length, 1);
});

test('M-17 restore and M-16 record diff read the versioned link history', () => {
  const rows = [
    row(gid(1), T_ROOF, 1),
    row(gid(2), T_ROOF, 2, 4),
    row(gid(3), T_FRAME, 3),
  ];
  assert.deepEqual(linksAt(rows, 2).map((r) => r.global_id), [gid(1), gid(2)]);
  const plan = restorePlan(rows, 2);
  assert.deepEqual(plan.remove.map((r) => r.id), [rows[2].id]);
  assert.deepEqual(plan.add, [{ globalId: gid(2), taskId: T_ROOF }]);
  const diff = recordDiff(rows, [{ id: PIN, global_ids: [gid(1)], task_ids: [], text: 't', state: 'open', version_no: 4, author_org_id: 'o', author_person_id: 'p' }], 4, 2);
  assert.deepEqual(diff.links_added, [{ global_id: gid(3), task_id: T_FRAME }]);
  assert.deepEqual(diff.links_removed, [{ global_id: gid(2), task_id: T_ROOF }]);
  assert.equal(diff.pins_added.length, 1);
  assert.equal(elementCounts(rows).get(T_ROOF), 1);
});

test('scope enforcement over 20 000 links stays in memory-set time (PRD-07 §5 benchmark)', () => {
  const rows = [];
  for (let i = 0; i < 20000; i += 1) rows.push(row(gid(i), i % 2 ? T_ROOF : T_FRAME, 1));
  const changes = [];
  for (let i = 0; i < 500; i += 1) changes.push({ op: 'link', globalId: gid(i), taskId: T_TILES });
  const started = performance.now();
  const scope = editScope({ whole: false, taskIds: [T_ROOF, T_TILES], links: rows });
  const refused = scopeRefusals(changes, scope, { projectTaskIds: new Set([T_ROOF, T_TILES, T_FRAME]) });
  const merged = mergeDraft({ base: 1, rows, pins: [], changes });
  const ms = performance.now() - started;
  assert.equal(refused.length, 250, 'the frame half is refused');
  assert.equal(merged.apply.links.length, 500);
  assert.ok(ms < 1000, `took ${ms.toFixed(1)} ms`);
});
