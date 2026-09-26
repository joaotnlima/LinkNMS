// Money-flow domain: state machines verbatim from doc 09, and the ONE money
// arithmetic (round(quantity × unit_price_cents), half-up — checks.sql §2).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  changeOrderTransition, measurementTransition, paymentTransition,
  lineAmountCents, retentionCents,
  changeOrderBody, changeOrderExistenceBody, measurementBody, cashFlowBody,
} from './money.mjs';

describe('change order machine (doc 09)', () => {
  test('draft → submitted → approved', () => {
    assert.deepEqual(changeOrderTransition('draft', 'submit'), { ok: true, to: 'submitted' });
    assert.deepEqual(changeOrderTransition('submitted', 'approve'), { ok: true, to: 'approved' });
    assert.deepEqual(changeOrderTransition('submitted', 'reject'), { ok: true, to: 'rejected' });
  });

  test('withdraw only before a decision', () => {
    assert.equal(changeOrderTransition('draft', 'withdraw').ok, true);
    assert.equal(changeOrderTransition('submitted', 'withdraw').ok, true);
    assert.equal(changeOrderTransition('approved', 'withdraw').ok, false);
    assert.equal(changeOrderTransition('rejected', 'withdraw').ok, false);
  });

  test('a draft is never decided directly', () => {
    assert.equal(changeOrderTransition('draft', 'approve').ok, false);
    assert.equal(changeOrderTransition('withdrawn', 'submit').ok, false);
  });
});

describe('measurement machine (doc 09)', () => {
  test('submitted → approved | disputed; disputed → submitted (revision)', () => {
    assert.deepEqual(measurementTransition('submitted', 'approve'), { ok: true, to: 'approved' });
    assert.deepEqual(measurementTransition('submitted', 'dispute'), { ok: true, to: 'disputed' });
    assert.deepEqual(measurementTransition('disputed', 'submit'), { ok: true, to: 'submitted' });
    assert.equal(measurementTransition('approved', 'dispute').ok, false);
    assert.equal(measurementTransition('approved', 'approve').ok, false);
  });
});

describe('payment machine (doc 09)', () => {
  test('expected → declared_paid → confirmed; disputed → declared_paid', () => {
    assert.deepEqual(paymentTransition('expected', 'declare'), { ok: true, to: 'declared_paid' });
    assert.deepEqual(paymentTransition('declared_paid', 'confirm'), { ok: true, to: 'confirmed' });
    assert.deepEqual(paymentTransition('declared_paid', 'dispute'), { ok: true, to: 'disputed' });
    assert.deepEqual(paymentTransition('disputed', 'declare'), { ok: true, to: 'declared_paid' });
    assert.equal(paymentTransition('expected', 'confirm').ok, false);
    assert.equal(paymentTransition('confirmed', 'dispute').ok, false);
  });
});

describe('money arithmetic (checks.sql §2, fractional cents)', () => {
  test('round(quantity × unit_price_cents) is half-up like SQL round()', () => {
    assert.equal(lineAmountCents('10.000', 250), 2500);
    assert.equal(lineAmountCents('0.333', 100), 33);    // 33.3 → 33
    assert.equal(lineAmountCents('0.335', 100), 34);    // 33.5 → 34 (half-up)
    assert.equal(lineAmountCents('1.5', 1), 2);         // 1.5 → 2
    assert.equal(lineAmountCents('2.5', 1), 3);         // SQL round: away from zero
    assert.equal(lineAmountCents('12', 100), 1200);
  });

  test('retention = round(gross × bp / 10000), half-up', () => {
    assert.equal(retentionCents(100000, 500), 5000);
    assert.equal(retentionCents(1001, 500), 50);        // 50.05 → 50
    assert.equal(retentionCents(1010, 500), 51);        // 50.5 → 51
    assert.equal(retentionCents(1, 0), 0);
  });
});

describe('projections', () => {
  const co = {
    id: 'co-1', contract_id: 'c-1', number: '1', kind: 'scope', reason: 'more sockets',
    amount_delta_cents: 1500, linked_change_order_id: null, from_variation_ids: [],
    proposed_by_org_id: 'org-a', proposed_by_person_id: 'p-a',
    decided_by_org_id: null, decided_by_person_id: null, decided_at: null,
    status: 'draft', version: 1,
  };

  test('party body carries amounts; existence body carries none (ruling 11)', () => {
    const full = changeOrderBody({ changeOrder: co, lines: [], time: [] });
    assert.deepEqual(full.amount_delta, { amount_cents: 1500, currency: 'EUR' });
    assert.equal('decided_by' in full, false);

    const thin = changeOrderExistenceBody(co);
    assert.deepEqual(Object.keys(thin).sort(), ['_visibility', 'contract_id', 'id', 'status']);
    assert.equal(thin._visibility.commercial, false);
    assert.ok(thin._visibility.reason.length > 0);
  });

  test('measurement lines are priced per line, half-up', () => {
    const body = measurementBody({
      measurement: { id: 'm-1', contract_id: 'c-1', period: '2026-09', status: 'submitted', gross_cents: 134, retention_cents: 7, net_cents: 127 },
      lines: [{ boq_item_id: 'b-1', description: 'Tomadas', quantity_this_period: '0.335', cumulative_quantity: '0.335', unit_price_cents: 100 }],
    });
    assert.deepEqual(body.lines[0].amount, { amount_cents: 34, currency: 'EUR' });
    assert.equal(body.lines[0].cumulative_quantity, '0.335');
    assert.deepEqual(body.net, { amount_cents: 127, currency: 'EUR' });
  });

  test('cash-flow totals its items', () => {
    const body = cashFlowBody({
      from: '2026-09-01', to: '2026-12-31',
      items: [
        { due_date: '2026-10-01', contract_id: 'c-1', supplier: 'Douro', amount_cents: 100, status: 'expected' },
        { due_date: '2026-11-01', contract_id: 'c-1', supplier: 'Douro', amount_cents: 250, status: 'declared_paid' },
      ],
    });
    assert.deepEqual(body.total, { amount_cents: 350, currency: 'EUR' });
    assert.equal(body.items.length, 2);
  });
});
