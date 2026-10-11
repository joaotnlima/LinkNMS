// Coordination domain (PRD-12 N-3, N-5..N-7) — pure rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  questionAddressee, answerDecision, questionActions, minuteActions, questionTargets, nonConformityTargets,
} from './coordination.mjs';

test('a scope gap is always the owner’s; other topics need an addressee', () => {
  assert.deepEqual(questionAddressee({ topic: 'scope_gap', addresseeOrgId: null, ownerOrgId: 'O', askerOrgId: 'G' }), { ok: true, addresseeOrgId: 'O' });
  assert.equal(questionAddressee({ topic: 'scope_gap', addresseeOrgId: 'A', ownerOrgId: 'O', askerOrgId: 'G' }).ok, false);
  assert.equal(questionAddressee({ topic: 'scope_gap', addresseeOrgId: null, ownerOrgId: 'O', askerOrgId: 'O' }).ok, false);
  assert.equal(questionAddressee({ topic: 'scope_gap', addresseeOrgId: null, ownerOrgId: null, askerOrgId: 'G' }).ok, false);
  assert.equal(questionAddressee({ topic: 'design_change', addresseeOrgId: null, ownerOrgId: 'O', askerOrgId: 'G' }).ok, false);
  assert.deepEqual(questionAddressee({ topic: 'clarification', addresseeOrgId: 'A', ownerOrgId: 'O', askerOrgId: 'G' }), { ok: true, addresseeOrgId: 'A' });
});

test('a design change is answered with a decision; nothing else carries one', () => {
  assert.deepEqual(answerDecision('design_change', 'approved'), { ok: true, decision: 'approved' });
  assert.equal(answerDecision('design_change', undefined).ok, false);
  assert.equal(answerDecision('clarification', 'approved').ok, false);
  assert.deepEqual(answerDecision('scope_gap', undefined), { ok: true, decision: null });
});

test('actions: addressee answers, asker resolves; writer circulates, attendee acknowledges once', () => {
  const q = { kind: 'question', question_status: 'open', addressee_org_id: 'A', author_org_id: 'B' };
  assert.deepEqual(questionActions(q, 'A'), ['answer']);
  assert.deepEqual(questionActions(q, 'B'), []);
  assert.deepEqual(questionActions({ ...q, question_status: 'answered' }, 'B'), ['resolve']);
  const m = { status: 'draft', created_by_org_id: 'W', attendees: ['W', 'X'] };
  assert.deepEqual(minuteActions(m, [], 'W'), ['circulate']);
  assert.deepEqual(minuteActions(m, [], 'X'), []);
  assert.deepEqual(minuteActions({ ...m, status: 'circulated' }, [{ org_id: 'W' }], 'X'), ['acknowledge']);
  assert.deepEqual(minuteActions({ ...m, status: 'circulated' }, [{ org_id: 'W' }], 'W'), []);
});

test('question notifications deep-link to the questions page; never to the actor', () => {
  const opened = questionTargets({
    type: 'collaboration.question.opened', project_id: 'p', actor: { org_id: 'G' },
    data: { comment_id: 'c', addressee_org_id: 'O', topic: 'scope_gap' },
  });
  assert.equal(opened[0].orgId, 'O');
  assert.match(opened[0].title, /scope gap/);
  assert.equal(opened[0].objectRef.url, '/projects/p/questions?q=c');
  const answered = questionTargets({
    type: 'collaboration.question.answered', project_id: 'p', actor: { org_id: 'A' },
    data: { comment_id: 'c', asker_org_id: 'G', decision: 'rejected' },
  });
  assert.equal(answered[0].title, 'Your design change was rejected');
  assert.deepEqual(questionTargets({ type: 'collaboration.question.opened', project_id: 'p', actor: { org_id: 'O' }, data: { addressee_org_id: 'O' } }), []);
});

test('NC notifications: whose move it is — fixed goes to the raiser, the rest to the assignee', () => {
  const base = { project_id: 'p', actor: { org_id: 'X' }, data: { nonconformity_id: 'n', assigned_to_org_id: 'S', raised_by_org_id: 'R', kind: 'safety', severity: 'major' } };
  assert.equal(nonConformityTargets({ ...base, type: 'quality.nonconformity.fixed' })[0].orgId, 'R');
  for (const step of ['raised', 'assigned', 'fix_rejected', 'closed']) {
    const [t] = nonConformityTargets({ ...base, type: `quality.nonconformity.${step}` });
    assert.equal(t.orgId, 'S', step);
    assert.equal(t.category, 'quality');
    assert.equal(t.objectRef.url, '/projects/p/quality?nc=n');
  }
  assert.deepEqual(nonConformityTargets({ ...base, actor: { org_id: 'S' }, type: 'quality.nonconformity.assigned' }), []);
  assert.deepEqual(nonConformityTargets({ ...base, data: { ...base.data, assigned_to_org_id: null }, type: 'quality.nonconformity.raised' }), []);
});
