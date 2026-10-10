import { test } from 'node:test';
import assert from 'node:assert/strict';

import { awardedPlanFacts } from './award.mjs';

const rfp = { root_task_ids: ['t1', 't2'] };

test('carries roots, winner, start and duration (D-43)', () => {
  const facts = awardedPlanFacts(rfp, {
    bidder_org_id: 'org-w', summary_start: '2027-01-04', summary_duration_wd: 19,
  });
  assert.deepEqual(facts, {
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
