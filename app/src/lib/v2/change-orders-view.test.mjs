// Unit tests for the v2 change-order wire→view transforms and — the point of
// the slice — the decide-eligibility gate (LINA-321, S4).
//
// The rules worth pinning: money is read straight off the ledger-authoritative
// `amount_delta` and never recomputed here; fields v2 does not carry (budget
// before/after, party names) are simply absent, never guessed; and no proposing
// org is ever offered a decide button — that is the two_sided_rule, mirrored so
// the UI does not present an action the handler will 403.
//
// Run: node --experimental-strip-types --test src/lib/v2/change-orders-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toChangeOrderView,
  toLegacyChipStatus,
  centsOf,
  isProposer,
  decideBlock,
  canDecide,
  canWithdraw,
  canSubmit,
  TWO_SIDED_MESSAGE,
} from './change-orders-view.ts';

const money = (cents, currency = 'EUR') => ({ amount_cents: cents, currency });

const co = (over = {}) => ({
  id: 'co1',
  contract_id: 'k1',
  number: 'CO-001',
  kind: 'scope',
  reason: 'Engineered oak flooring (kitchen & hall)',
  amount_delta: money(420000),
  lines: [{ op: 'add' }, { op: 'replace' }],
  time: [],
  proposed_by: { org_id: 'orgA', person_id: 'pA' },
  status: 'submitted',
  version: 2,
  ...over,
});

const me = (orgId) => ({
  person: { id: 'p', email: 'x@y.z', name: 'X', locale: 'pt' },
  active_org: orgId ? { id: orgId, kind: 'contractor', legal_name: 'Acme', approval_policy: 'any' } : null,
  org_role: orgId ? 'admin' : null,
  permissions: [],
  organizations: [],
  pending_project_invitations: [],
});

test('centsOf: reads amount_cents, defaults to 0 when absent', () => {
  assert.equal(centsOf(money(420000)), 420000);
  assert.equal(centsOf(null), 0);
  assert.equal(centsOf(undefined), 0);
});

test('toChangeOrderView: maps only what v2 states; title is the reason', () => {
  const v = toChangeOrderView(co());
  assert.equal(v.id, 'co1');
  assert.equal(v.contractId, 'k1');
  assert.equal(v.number, 'CO-001');
  assert.equal(v.kind, 'scope');
  assert.equal(v.title, 'Engineered oak flooring (kitchen & hall)'); // reason ⇒ title
  assert.equal(v.amountDeltaCents, 420000); // ledger-authoritative, not recomputed
  assert.equal(v.currency, 'EUR');
  assert.equal(v.status, 'submitted');
  assert.equal(v.proposedByOrgId, 'orgA');
  assert.equal(v.lineCount, 2);
  assert.equal(v.timeCount, 0);
  // No invented fields: budget before/after and a party name have no source.
  assert.ok(!('budgetBeforeCents' in v));
  assert.ok(!('proposedByName' in v));
});

test('toChangeOrderView: decided CO surfaces the deciding org and timestamp', () => {
  const v = toChangeOrderView(co({
    status: 'approved',
    decided_by: { org_id: 'orgB', person_id: 'pB' },
    decided_at: '2026-09-27T10:00:00Z',
  }));
  assert.equal(v.status, 'approved');
  assert.equal(v.decidedByOrgId, 'orgB');
  assert.equal(v.decidedAt, '2026-09-27T10:00:00Z');
});

test('toLegacyChipStatus: five v2 states fold onto the three legacy cells (lossy, documented)', () => {
  assert.equal(toLegacyChipStatus('draft'), 'proposed');
  assert.equal(toLegacyChipStatus('submitted'), 'proposed');
  assert.equal(toLegacyChipStatus('approved'), 'approved');
  assert.equal(toLegacyChipStatus('rejected'), 'rejected');
  assert.equal(toLegacyChipStatus('withdrawn'), 'rejected');
});

test('isProposer: true only when the viewer active org proposed the CO', () => {
  assert.equal(isProposer(co(), me('orgA')), true);
  assert.equal(isProposer(co(), me('orgB')), false);
  assert.equal(isProposer(co(), me(null)), false); // no active org
  assert.equal(isProposer(co(), null), false); // not signed in
});

test('decideBlock: the OTHER party on a submitted CO may decide', () => {
  const b = decideBlock(co(), me('orgB'));
  assert.deepEqual(b, { canDecide: true });
  assert.equal(canDecide(co(), me('orgB')), true);
});

test('decideBlock: the PROPOSER is never offered a decide button (two_sided_rule)', () => {
  const b = decideBlock(co(), me('orgA'));
  assert.equal(b.canDecide, false);
  assert.equal(b.reason, 'proposer');
  assert.equal(b.message, TWO_SIDED_MESSAGE);
  assert.equal(canDecide(co(), me('orgA')), false);
});

test('decideBlock: no active org is a first-class state, not a crash', () => {
  const b = decideBlock(co(), me(null));
  assert.equal(b.canDecide, false);
  assert.equal(b.reason, 'no_active_org');
  assert.equal(canDecide(co(), null), false);
});

test('decideBlock: only a submitted CO is decidable (draft/terminal are not)', () => {
  for (const status of ['draft', 'approved', 'rejected', 'withdrawn']) {
    const b = decideBlock(co({ status }), me('orgB'));
    assert.equal(b.canDecide, false, `${status} must not be decidable`);
    assert.equal(b.reason, 'not_open');
  }
});

test('canWithdraw: proposer only, while still open', () => {
  assert.equal(canWithdraw(co({ status: 'draft' }), me('orgA')), true);
  assert.equal(canWithdraw(co({ status: 'submitted' }), me('orgA')), true);
  assert.equal(canWithdraw(co({ status: 'approved' }), me('orgA')), false); // terminal
  assert.equal(canWithdraw(co({ status: 'submitted' }), me('orgB')), false); // not the proposer
});

test('canSubmit: proposer only, only a draft', () => {
  assert.equal(canSubmit(co({ status: 'draft' }), me('orgA')), true);
  assert.equal(canSubmit(co({ status: 'submitted' }), me('orgA')), false);
  assert.equal(canSubmit(co({ status: 'draft' }), me('orgB')), false);
});
