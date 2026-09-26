import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  questionTransition, minuteTransition, commentBody, minuteBody, activityItem,
} from './lifecycle.mjs';

describe('question lifecycle (doc 09: open → answered → resolved)', () => {
  test('legal path', () => {
    assert.deepEqual(questionTransition('open', 'answer'), { ok: true, to: 'answered' });
    assert.deepEqual(questionTransition('answered', 'resolve'), { ok: true, to: 'resolved' });
  });

  test('resolving an unanswered question explains itself', () => {
    const out = questionTransition('open', 'resolve');
    assert.equal(out.ok, false);
    assert.match(out.reason, /answer it first/);
  });

  test('terminal states move nowhere', () => {
    assert.equal(questionTransition('resolved', 'answer').ok, false);
    assert.equal(questionTransition('resolved', 'resolve').ok, false);
    assert.equal(questionTransition('answered', 'answer').ok, false);
  });
});

describe('minute lifecycle (doc 09: draft → circulated → acknowledged)', () => {
  test('circulate only from draft; acks only while circulated', () => {
    assert.deepEqual(minuteTransition('draft', 'circulate'), { ok: true, to: 'circulated' });
    assert.equal(minuteTransition('circulated', 'circulate').ok, false);
    assert.equal(minuteTransition('draft', 'acknowledge').ok, false);
    assert.equal(minuteTransition('circulated', 'acknowledge').ok, true);
    assert.equal(minuteTransition('acknowledged', 'acknowledge').ok, false);
  });
});

describe('wire bodies', () => {
  test('a tombstoned comment keeps the slot, never the words', () => {
    const body = commentBody({
      id: 'c', object_type: 'task', object_id: 't', kind: 'note', body: 'segredo',
      author_person_id: 'p', author_org_id: 'o', mentions: [],
      created_at: 'now', deleted_at: 'earlier',
    });
    assert.equal(body.deleted, true);
    assert.equal(body.body, '');
  });

  test('question fields appear only when present', () => {
    const note = commentBody({
      id: 'c', object_type: 'task', object_id: 't', kind: 'note', body: 'ok',
      author_person_id: 'p', author_org_id: 'o', created_at: 'now', deleted_at: null,
    });
    assert.ok(!('question_status' in note));
    assert.ok(!('addressee_org_id' in note));
  });

  test('minute body carries acks and ISO dates', () => {
    const body = minuteBody(
      { id: 'm', date: new Date('2026-09-26T00:00:00Z'), attendees: ['a', 'b'], status: 'circulated' },
      [{ text: 'patio decision', owner_org_id: 'a', due_date: '2026-10-01' }],
      [{ org_id: 'a', person_id: 'p', at: 'now' }],
    );
    assert.equal(body.date, '2026-09-26');
    assert.equal(body.items[0].due_date, '2026-10-01');
    assert.equal(body.acks.length, 1);
  });

  test('activity item projects the envelope, never raw payload dumps', () => {
    const item = activityItem({
      event_id: 'e', type: 'documents.version.uploaded', occurred_at: 'now',
      actor: { person_id: 'p', org_id: 'o' },
      scope: { type: 'project', id: 'pr' },
      data: { title: 'Planta piso 0', sha256: 'x' },
    });
    assert.equal(item.summary, 'version uploaded: Planta piso 0');
    assert.equal(item.object_type, 'project');
    assert.ok(!('data' in item));
  });
});
