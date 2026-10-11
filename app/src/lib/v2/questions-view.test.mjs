// PRD-12 N-5..N-7: question cards, the ask form (a scope gap goes to the owner)
// and minute cards. Run: node --test src/lib/v2/questions-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { questionCard, askBody, minuteBody, minuteCard } from './questions-view.ts';

const orgs = new Map([['O', 'Família Silva'], ['G', 'Douro'], ['A', 'Atelier']]);

test('a design change card carries its decision and the deep link to its build', () => {
  const c = questionCard({
    id: 'q', object_type: 'task', object_id: 't', kind: 'question', body: 'Alumínio?', author: { org_id: 'G' },
    addressee_org_id: 'A', question_status: 'answered', created_at: '2026-10-09T10:00:00Z', deleted: false,
    project_id: 'p', topic: 'design_change', decision: 'approved', actions: ['resolve'],
  }, orgs, { tasks: new Map([['t', 'Caixilharia']]) });
  assert.deepEqual([c.topicLabel, c.from, c.to, c.on, c.decision, c.askedOn, c.needsDecision], ['Design change', 'Douro', 'Atelier', 'Task: Caixilharia', 'approved', '2026-10-09', true]);
  assert.equal(c.href, '/projects/p/questions?q=q');
  assert.deepEqual(c.actions, ['resolve']);
});

test('ask: a scope gap needs no addressee (the server routes it to the owner); others do', () => {
  const gap = askBody({ topic: 'scope_gap', body: 'Ninguém tem a cobertura', addresseeOrgId: '', taskId: '' }, 'i');
  assert.equal(gap.ok, true);
  assert.equal(gap.body.addressee_org_id, undefined);
  assert.equal(gap.objectType, 'project');
  assert.equal(askBody({ topic: 'clarification', body: 'Cota?', addresseeOrgId: '', taskId: '' }, 'i').ok, false);
  const onTask = askBody({ topic: 'design_change', body: 'x', addresseeOrgId: 'A', taskId: 't' }, 'i');
  assert.deepEqual([onTask.objectType, onTask.objectId, onTask.body.topic], ['task', 't', 'design_change']);
});

test('minutes: one item per line; who acknowledged and who is still waiting', () => {
  assert.equal(minuteBody({ date: '', attendees: ['G'], items: '' }, 'm').ok, false);
  assert.equal(minuteBody({ date: '2026-10-09', attendees: [], items: '' }, 'm').ok, false);
  assert.deepEqual(minuteBody({ date: '2026-10-09', attendees: ['G', 'O'], items: 'Betonagem sexta\n\n Andaimes ' }, 'm').body.items,
    [{ text: 'Betonagem sexta' }, { text: 'Andaimes' }]);
  const card = minuteCard({ id: 'm', date: '2026-10-09', attendees: ['G', 'O'], items: [{ text: 'a' }], status: 'circulated', acks: [{ org_id: 'G', at: 'x' }], actions: ['acknowledge'] }, orgs);
  assert.deepEqual([card.acked, card.waiting, card.actions], [['Douro'], ['Família Silva'], ['acknowledge']]);
});
