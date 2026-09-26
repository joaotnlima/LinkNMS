// The comparison matrix, pure: prices keyed by proposal, lower-median in
// integer cents, missing lines per item, durations per packaged row.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { comparisonMatrix, median, missingLineCount } from './comparison.mjs';

const ITEM_A = 'a0000000-0000-7000-8000-000000000001';
const ITEM_B = 'a0000000-0000-7000-8000-000000000002';
const P1 = 'b0000000-0000-7000-8000-000000000001';
const P2 = 'b0000000-0000-7000-8000-000000000002';
const P3 = 'b0000000-0000-7000-8000-000000000003';
const TASK = 'c0000000-0000-7000-8000-000000000001';

const items = [
  { id: ITEM_A, description: 'Tubagem PEX', unit: 'm', quantity: '120.000' },
  { id: ITEM_B, description: 'Loiças WC', unit: 'un', quantity: '3.000' },
];

describe('comparisonMatrix', () => {
  test('prices per proposal, median, missing_in', () => {
    const out = comparisonMatrix({
      items,
      proposals: [{ id: P1 }, { id: P2 }, { id: P3 }],
      lines: [
        { proposal_id: P1, rfp_item_id: ITEM_A, is_variant: false, unit_price_cents: 500 },
        { proposal_id: P2, rfp_item_id: ITEM_A, is_variant: false, unit_price_cents: 700 },
        { proposal_id: P3, rfp_item_id: ITEM_A, is_variant: false, unit_price_cents: 600 },
        { proposal_id: P1, rfp_item_id: ITEM_B, is_variant: false, unit_price_cents: 20000 },
        // a variant never enters the matrix
        { proposal_id: P2, rfp_item_id: ITEM_B, is_variant: true, unit_price_cents: 1 },
      ],
      rows: [
        { proposal_id: P1, packaged_task_id: TASK, duration_wd: 9 },
        { proposal_id: P2, packaged_task_id: TASK, duration_wd: 12 },
        { proposal_id: P3, packaged_task_id: null, duration_wd: 4 },
      ],
    });

    const a = out.items.find((i) => i.rfp_item_id === ITEM_A);
    assert.equal(a.prices[P1].amount_cents, 500);
    assert.equal(a.median.amount_cents, 600);
    assert.deepEqual(a.missing_in, []);

    const b = out.items.find((i) => i.rfp_item_id === ITEM_B);
    assert.equal(b.prices[P1].amount_cents, 20000);
    assert.equal(b.median.amount_cents, 20000);
    // P2 only priced a VARIANT for item B; P3 nothing — both are missing.
    assert.deepEqual(b.missing_in.sort(), [P2, P3].sort());

    assert.deepEqual(out.durations, [
      { packaged_task_id: TASK, by_proposal: { [P1]: 9, [P2]: 12 } },
    ]);
  });

  test('median is the lower middle in integer cents', () => {
    assert.equal(median([]), null);
    assert.equal(median([7]), 7);
    assert.equal(median([9, 5]), 5);
    assert.equal(median([9, 5, 7]), 7);
    assert.equal(median([1, 2, 3, 4]), 2);
  });

  test('missingLineCount ignores variants', () => {
    assert.equal(missingLineCount(items, [
      { rfp_item_id: ITEM_A, is_variant: false },
      { rfp_item_id: ITEM_B, is_variant: true },
    ]), 1);
  });
});
