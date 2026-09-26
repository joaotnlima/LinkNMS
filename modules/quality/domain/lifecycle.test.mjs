// The two quality state machines, exhaustively, plus the wire projections'
// field-absence rule (invariant §6.5: withheld/unknown is ABSENT, never null).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  verificationTransition, nonConformityTransition,
  verificationBody, nonConformityBody, inspectionBody,
} from './lifecycle.mjs';

describe('verification_request state machine', () => {
  test('pending accepts and rejects', () => {
    assert.deepEqual(verificationTransition('pending', 'accept'), { ok: true, to: 'accepted' });
    assert.deepEqual(verificationTransition('pending', 'reject'), { ok: true, to: 'rejected' });
  });

  test('a decided request is terminal', () => {
    for (const status of ['accepted', 'rejected']) {
      for (const action of ['accept', 'reject']) {
        const out = verificationTransition(status, action);
        assert.equal(out.ok, false, `${action} on ${status}`);
        assert.match(out.reason, new RegExp(status));
      }
    }
  });

  test('an unknown action never passes', () => {
    assert.equal(verificationTransition('pending', 'withdraw').ok, false);
  });
});

describe('nonconformity state machine (open → assigned → fixed → closed)', () => {
  test('the happy path', () => {
    assert.deepEqual(nonConformityTransition('open', 'assign'), { ok: true, to: 'assigned' });
    assert.deepEqual(nonConformityTransition('assigned', 'fix'), { ok: true, to: 'fixed' });
    assert.deepEqual(nonConformityTransition('fixed', 'close'), { ok: true, to: 'closed' });
  });

  test('a rejected fix re-opens the loop: fix again or re-assign', () => {
    assert.deepEqual(nonConformityTransition('fixed', 'reject_fix'), { ok: true, to: 'rejected_fix' });
    assert.deepEqual(nonConformityTransition('rejected_fix', 'fix'), { ok: true, to: 'fixed' });
    assert.deepEqual(nonConformityTransition('rejected_fix', 'assign'), { ok: true, to: 'assigned' });
  });

  test('close only from fixed — open work is never closed around the fixer', () => {
    for (const status of ['open', 'assigned', 'rejected_fix', 'closed']) {
      assert.equal(nonConformityTransition(status, 'close').ok, false, `close on ${status}`);
    }
  });

  test('fix only from assigned or rejected_fix; closed is terminal', () => {
    assert.equal(nonConformityTransition('open', 'fix').ok, false);
    for (const action of ['assign', 'fix', 'reject_fix', 'close']) {
      assert.equal(nonConformityTransition('closed', action).ok, false, `${action} on closed`);
    }
  });
});

describe('wire projections (§6.5: absent, never null)', () => {
  test('an undecided verification carries no decided_by / reason / decided_at', () => {
    const body = verificationBody({
      id: 'v1', task_id: 't1', task_name: 'Reboco', requested_by_org_id: 'o1',
      criteria_snapshot: null, status: 'pending',
      decided_by_org_id: null, decided_by_person_id: null, reason: null, decided_at: null,
    });
    assert.equal(body.status, 'pending');
    assert.deepEqual(body.requested_by, { org_id: 'o1' });
    for (const k of ['decided_by', 'reason', 'decided_at', 'criteria']) {
      assert.equal(k in body && body[k] !== undefined, false, `${k} must be absent`);
    }
  });

  test('a rejected verification carries decided_by, reason and decided_at', () => {
    const body = verificationBody({
      id: 'v1', task_id: 't1', task_name: 'Reboco', requested_by_org_id: 'o1',
      criteria_snapshot: 'sem fissuras', status: 'rejected',
      decided_by_org_id: 'o2', decided_by_person_id: 'p2', reason: 'fissura no canto',
      decided_at: new Date('2026-09-25T10:00:00Z'),
    });
    assert.deepEqual(body.decided_by, { org_id: 'o2', person_id: 'p2' });
    assert.equal(body.reason, 'fissura no canto');
    assert.equal(body.decided_at, '2026-09-25T10:00:00.000Z');
    assert.equal(body.criteria, 'sem fissuras');
  });

  test('a task-less nonconformity omits task_id and assigned_to_org_id', () => {
    const body = nonConformityBody({
      id: 'n1', project_id: 'pr1', task_id: null, kind: 'safety', severity: 'critical',
      description: 'Andaime sem guarda-corpos', photo_document_ids: [],
      raised_by_org_id: 'o1', raised_by_person_id: 'p1', assigned_to_org_id: null, status: 'open',
    });
    assert.equal('task_id' in body && body.task_id !== undefined, false);
    assert.equal('assigned_to_org_id' in body && body.assigned_to_org_id !== undefined, false);
    assert.deepEqual(body.raised_by, { person_id: 'p1', org_id: 'o1' });
  });

  test('inspection date is YYYY-MM-DD on the wire; findings absent when null', () => {
    const body = inspectionBody({
      id: 'i1', kind: 'quality', date: new Date('2026-09-25T00:00:00Z'),
      checklist: [{ item: 'EPIs', ok: true }], findings: null, task_ids: ['t1'],
    });
    assert.equal(body.date, '2026-09-25');
    assert.equal('findings' in body && body.findings !== undefined, false);
    assert.deepEqual(body.task_ids, ['t1']);
  });
});
