import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentSubmission, deliverableStatus, pendingRequired, sideOf, canDecide, reviewerOrgIds,
  validateDeliverableFields, validateText, deliverableBody, taskDeliverablesBody,
} from './deliverables.mjs';

const OWNER = 'org-owner';
const GC = 'org-gc';
const SUB = 'org-sub';
const STRANGER = 'org-x';

// owner —prime→ GC —sub→ SUB; the design row is SUB's branch.
const world = {
  ownerOrgId: OWNER,
  contracts: new Map([
    ['prime', { supplierOrgId: GC, clientOrgId: OWNER, parentContractId: null }],
    ['sub', { supplierOrgId: SUB, clientOrgId: GC, parentContractId: 'prime' }],
  ]),
};
const tasks = new Map([
  ['t', { id: 't', parentId: null, branchContractId: 'sub', assigneeOrgId: SUB }],
  ['gc-row', { id: 'gc-row', parentId: null, branchContractId: 'prime', assigneeOrgId: null }],
  ['gc-child', { id: 'gc-child', parentId: 'gc-row', branchContractId: 'prime', assigneeOrgId: SUB }],
]);

const sub = (seq, status, org = SUB, over = {}) => ({
  id: `s${seq}`, seq, status, submitted_by_org_id: org, submitted_by_person_id: 'p',
  document_id: 'd', version_no: seq, sha256: 'a'.repeat(64), file_title: 'S-110', mime: 'application/pdf',
  submitted_at: '2027-01-08T10:00:00Z', ...over,
});

describe('state and the done gate (D-48)', () => {
  test('state is the latest submission; superseded never is', () => {
    assert.equal(deliverableStatus([]), 'not_yet');
    assert.equal(deliverableStatus([sub(1, 'changes_requested'), sub(2, 'submitted')]), 'submitted');
    assert.equal(currentSubmission([sub(1, 'superseded')]), null);
  });

  test('pending = required, live, not approved', () => {
    const ds = [
      { id: 'a', required: true, submissions: [sub(1, 'approved')] },
      { id: 'b', required: true, submissions: [sub(1, 'submitted')] },
      { id: 'c', required: false, submissions: [] },
      { id: 'd', required: true, deleted_at: 'x', submissions: [] },
      { id: 'e', required: true, submissions: [] },
    ];
    assert.deepEqual(pendingRequired(ds), ['b', 'e']);
  });
});

describe('who is which side (D-06, D-33)', () => {
  test('the assignee submits; the client chain and the owner review', () => {
    const t = tasks.get('t');
    assert.deepEqual(sideOf({ world, tasks, task: t, orgId: SUB }), { assigneeOrgId: SUB, clientSide: false, canSubmit: true });
    assert.equal(sideOf({ world, tasks, task: t, orgId: GC }).clientSide, true, 'the GC reviews on the owner\'s behalf');
    assert.equal(sideOf({ world, tasks, task: t, orgId: OWNER }).clientSide, true);
    assert.deepEqual(sideOf({ world, tasks, task: t, orgId: STRANGER }), { assigneeOrgId: SUB, clientSide: false, canSubmit: false });
  });

  test('a branch supplier reviews a row it assigned to someone else (inherited assignee too)', () => {
    assert.equal(sideOf({ world, tasks, task: tasks.get('gc-child'), orgId: GC }).clientSide, true);
    assert.equal(sideOf({ world, tasks, task: tasks.get('gc-child'), orgId: SUB }).canSubmit, true);
  });

  test('two-sided: nobody decides what its own org submitted', () => {
    const side = sideOf({ world, tasks, task: tasks.get('t'), orgId: GC });
    assert.equal(canDecide(side, sub(1, 'submitted', SUB), GC), true);
    assert.equal(canDecide(side, sub(1, 'submitted', GC), GC), false);
    assert.equal(canDecide(side, sub(1, 'approved', SUB), GC), false);
  });

  test('reviewers for notifications: client side minus the submitter', () => {
    assert.deepEqual(reviewerOrgIds({ world, tasks, task: tasks.get('t') }).sort(), [GC, OWNER].sort());
    assert.deepEqual(reviewerOrgIds({ world, tasks, task: tasks.get('t'), submitterOrgId: GC }), [OWNER]);
  });
});

describe('validation', () => {
  test('create needs a title; required defaults true, due null', () => {
    assert.deepEqual(validateDeliverableFields({ title: ' Calc report ' }), { errors: {}, value: { title: 'Calc report', required: true, due: null } });
    assert.ok(validateDeliverableFields({ title: '' }).errors.title);
    assert.ok(validateDeliverableFields({ title: 'x', due: '12/01' }).errors.due);
  });

  test('a patch changes only what it names, and names something', () => {
    assert.deepEqual(validateDeliverableFields({ required: false }, { partial: true }).value, { required: false });
    assert.ok(validateDeliverableFields({}, { partial: true }).errors.body);
  });

  test('comments: optional unless required, bounded', () => {
    assert.deepEqual(validateText(undefined, 'comment'), { error: null, value: null });
    assert.ok(validateText('  ', 'comment', { required: true }).error.comment);
    assert.ok(validateText('x'.repeat(2001), 'note').error.note);
  });
});

describe('wire', () => {
  test('history newest first, current present, decision with who/when/comment', () => {
    const body = deliverableBody({
      id: 'del', project_id: 'p', task_id: 't', title: 'S-110', required: true, due: null, created_at: 'now',
      submissions: [
        sub(1, 'changes_requested', SUB, { decided_by_org_id: GC, decided_by_person_id: 'm', decided_at: 'then', decision_comment: 'spacing' }),
        sub(2, 'approved', SUB, { decided_by_org_id: OWNER, decided_by_person_id: 'm', decided_at: 'later' }),
      ],
    });
    assert.equal(body.status, 'approved');
    assert.deepEqual(body.history.map((h) => h.seq), [2, 1]);
    assert.equal(body.current.decision.by.org_id, OWNER);
    assert.equal(body.history[1].decision.comment, 'spacing');
    assert.equal(body.current.sha256, 'a'.repeat(64));
  });

  test('task summary: x of n, blocked, to review for the viewer', () => {
    const side = sideOf({ world, tasks, task: tasks.get('t'), orgId: GC });
    const body = taskDeliverablesBody({
      taskId: 't', side, orgId: GC,
      deliverables: [
        { id: 'a', required: true, submissions: [sub(1, 'approved')] },
        { id: 'b', required: true, submissions: [sub(1, 'submitted')] },
        { id: 'c', required: false, submissions: [sub(1, 'submitted')] },
      ],
    });
    assert.deepEqual(
      [body.required_count, body.approved_count, body.done_blocked, body.to_review_count, body.can_edit, body.can_submit],
      [2, 1, true, 2, true, false],
    );
    assert.deepEqual(body.items.map((d) => d.can_decide), [false, true, true]);
  });
});
