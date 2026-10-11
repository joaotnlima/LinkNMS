import { test } from 'node:test';
import assert from 'node:assert/strict';

import { awardedPlanFacts, deliverablesFromScope } from './award.mjs';

const rfp = { root_task_ids: ['t1', 't2'] };

test('carries roots, winner, start and duration (D-43)', () => {
  const facts = awardedPlanFacts(rfp, {
    bidder_org_id: 'org-w', summary_start: '2027-01-04', summary_duration_wd: 19,
  });
  assert.deepEqual(facts, {
    purpose: 'execution', deliverables: [],
    root_task_ids: ['t1', 't2'], supplier_org_id: 'org-w', start: '2027-01-04', duration_wd: 19,
  });
});

test('a pg DATE (local midnight) reads back as the same calendar day', () => {
  const facts = awardedPlanFacts(rfp, { bidder_org_id: 'o', summary_start: new Date(2027, 0, 4) });
  assert.equal(facts.start, '2027-01-04');
});

test('a summary bid with no start or duration says so with nulls', () => {
  const facts = awardedPlanFacts(rfp, { bidder_org_id: 'o', summary_start: null, summary_duration_wd: 0 });
  assert.equal(facts.start, null);
  assert.equal(facts.duration_wd, null);
});

test('a design award carries the brief\'s listed deliverables (PRD-05 F-12)', () => {
  const design = {
    ...rfp, purpose: 'design',
    scope_text: 'Structural design for the house.\nDeliverables:\n- S-110 Truss details\n* Calculation report\n1) Term of responsibility (signed)\n- calculation report\n',
  };
  const facts = awardedPlanFacts(design, { bidder_org_id: 'o' });
  assert.equal(facts.purpose, 'design');
  assert.deepEqual(facts.deliverables, ['S-110 Truss details', 'Calculation report', 'Term of responsibility (signed)']);
});

test('prose seeds nothing; titles are capped and the list is bounded', () => {
  assert.deepEqual(deliverablesFromScope('Produce the architecture project.'), []);
  assert.equal(deliverablesFromScope(`- ${'x'.repeat(400)}`)[0].length, 300);
  const many = Array.from({ length: 80 }, (_, i) => `- item ${i}`).join('\n');
  assert.equal(deliverablesFromScope(many).length, 50);
  assert.deepEqual(awardedPlanFacts({ ...rfp, purpose: 'execution', scope_text: '- a' }, {}).deliverables, []);
});
