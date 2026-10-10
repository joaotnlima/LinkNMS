import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeCalendar } from './calendar.mjs';
import { tenderWindow, tenderCoverage, criticalLeaves } from './tender-window.mjs';

const cal = makeCalendar({ work_days: [1, 2, 3, 4, 5] }); // plain Mon–Fri

const t = (id, over = {}) => [id, {
  id, parentId: null, kind: 'task', position: id, name: id.toUpperCase(),
  start: null, finish: null, actualStart: null, actualFinish: null,
  assigneeOrgId: null, deletedAt: null, ...over,
}];
const link = (predecessorId, successorId, lagWd = 0) =>
  ({ id: `${predecessorId}->${successorId}`, predecessorId, successorId, fromAnchor: 'end', toAnchor: 'start', lagWd });

// Frame (Mon 1 Feb–Fri 5 Feb 2027) → Roofing (summary: structure + covering +
// gutters) → Finishes, the project's last row. A side task with slack.
const NUNO = 'org-nuno';
function plan() {
  return new Map([
    t('frame', { start: '2027-02-01', finish: '2027-02-05' }),
    t('roof', { kind: 'summary' }),
    t('struct', { parentId: 'roof', start: '2027-02-08', finish: '2027-02-12', position: 'a' }),
    t('cover', { parentId: 'roof', start: '2027-02-15', finish: '2027-02-19', position: 'b' }),
    t('gutter', { parentId: 'roof', start: '2027-02-15', finish: '2027-02-16', position: 'c', assigneeOrgId: NUNO }),
    t('sky', { parentId: 'gutter', start: '2027-02-15', finish: '2027-02-16' }),
    t('finish', { start: '2027-02-22', finish: '2027-03-05' }),
    t('garden', { start: '2027-02-01', finish: '2027-02-03' }),
  ]);
}
const links = [link('frame', 'roof'), link('struct', 'cover'), link('roof', 'finish')];
const names = new Map([[NUNO, 'Nuno Ferreira']]);

describe('coverage (T-3)', () => {
  test('a descendant already owned by another party is left out with its sub-tree', () => {
    const { covered, leftOut } = tenderCoverage({ tasks: plan(), rootIds: ['roof'], orgNames: names });
    assert.deepEqual(covered, ['roof', 'struct', 'cover']);
    assert.deepEqual(leftOut, [{
      task_id: 'gutter', name: 'GUTTER', reason: 'assigned', assignee: { org_id: NUNO, name: 'Nuno Ferreira' },
    }]);
  });

  test('"Include it" puts the row (and its sub-tree) back', () => {
    const { covered, leftOut } = tenderCoverage({ tasks: plan(), rootIds: ['roof'], includeIds: ['gutter'] });
    assert.deepEqual(covered, ['roof', 'struct', 'cover', 'gutter', 'sky']);
    assert.deepEqual(leftOut, []);
  });

  test('a row owned by the same party as the root is not "another party"', () => {
    const tasks = plan();
    tasks.set('roof', { ...tasks.get('roof'), assigneeOrgId: NUNO });
    assert.deepEqual(tenderCoverage({ tasks, rootIds: ['roof'] }).leftOut, []);
  });
});

describe('critical path (D-22 rigid links)', () => {
  test('a leaf on the chain that sets the finish is critical; one with slack is not', () => {
    const crit = criticalLeaves({ tasks: plan(), links, calendar: cal, candidateIds: ['struct', 'cover', 'garden'] });
    assert.deepEqual(crit, ['struct', 'cover']);
  });

  test('a done leaf never moves, so it is never critical', () => {
    const tasks = plan();
    tasks.set('cover', { ...tasks.get('cover'), actualFinish: '2027-02-19' });
    assert.deepEqual(criticalLeaves({ tasks, links, calendar: cal, candidateIds: ['cover'] }), []);
  });
});

describe('tenderWindow (T-4, T-5, T-13, §5)', () => {
  test('work window, critical flag and award-by from the plan calendar', () => {
    const w = tenderWindow({
      tasks: plan(), links, calendar: cal, rootIds: ['roof'], bidsDue: '2027-01-27', orgNames: names,
    });
    assert.deepEqual(w.work_window, { start: '2027-02-08', finish: '2027-02-19', duration_wd: 10 });
    assert.equal(w.on_critical_path, true);
    assert.deepEqual(w.critical_task_ids, ['struct', 'cover']);
    assert.equal(w.project_finish, '2027-03-05');
    assert.equal(w.mobilisation_lead_wd, 5);
    // 5 working days before Mon 8 Feb is Mon 1 Feb.
    assert.equal(w.award_by, '2027-02-01');
    assert.equal(w.wd_bids_due_to_start, 8);
    assert.equal(w.wd_bids_due_to_award_by, 3);
  });

  test('bids due after the award-by date reads negative; the lead is a setting', () => {
    const w = tenderWindow({
      tasks: plan(), links, calendar: cal, rootIds: ['roof'], bidsDue: '2027-02-04', leadWd: 2,
    });
    assert.equal(w.award_by, '2027-02-04');
    assert.equal(w.wd_bids_due_to_award_by, 0);
    const late = tenderWindow({ tasks: plan(), links, calendar: cal, rootIds: ['roof'], bidsDue: '2027-02-05' });
    assert.equal(late.wd_bids_due_to_award_by, -4);
  });

  test('an undated tender has no window, no award-by and no counts', () => {
    const tasks = new Map([t('x'), t('y', { parentId: 'x' })]);
    const w = tenderWindow({ tasks, links: [], calendar: cal, rootIds: ['x'], bidsDue: '2027-01-27' });
    assert.equal(w.work_window, null);
    assert.equal(w.award_by, null);
    assert.equal(w.on_critical_path, false);
    assert.equal(w.wd_bids_due_to_start, null);
  });
});
