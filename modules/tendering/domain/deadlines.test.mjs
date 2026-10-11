import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultSubmissionDeadline } from './deadlines.mjs';

test('the default bids-due: 14 days out, 18:00 Lisbon (WET in winter, WEST in summer)', () => {
  assert.equal(defaultSubmissionDeadline(new Date('2026-12-01T09:00:00Z')), '2026-12-15T18:00:00.000Z');
  assert.equal(defaultSubmissionDeadline(new Date('2026-07-01T09:00:00Z')), '2026-07-15T17:00:00.000Z');
});
