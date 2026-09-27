// Unit tests for the v2 portfolio-home wire→view transforms (LINA-311, S1).
//
// The rules worth pinning: the account label comes from the ORG KIND (v2 has no
// per-party role column), a project's budget is never given an invented delta
// (current == baseline until a contracting read says otherwise), the six-state v2
// lifecycle collapses to draft/live for the card badge, and nothing is guessed
// when a field is absent.
//
// Run: node --experimental-strip-types --test src/lib/v2/profile-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toPortalUser, toProjectSummary, toBuildStatus, cardRole, displayNameOf,
} from './profile-view.ts';

const person = (over = {}) => ({
  id: 'p1', email: 'nuno@example.com', name: 'Nuno Ferreira', locale: 'pt', ...over,
});
const org = (kind) => ({ id: 'o1', kind, legal_name: 'Acme', approval_policy: 'any' });
const me = (over = {}) => ({
  person: person(), active_org: null, org_role: null, permissions: [],
  organizations: [], pending_project_invitations: [], ...over,
});

test('displayNameOf: name wins, then email local-part, then a neutral fallback', () => {
  assert.equal(displayNameOf(person()), 'Nuno Ferreira');
  assert.equal(displayNameOf(person({ name: '   ' })), 'nuno'); // blank name → local-part
  assert.equal(displayNameOf(person({ name: null })), 'nuno');
  assert.equal(displayNameOf(person({ name: null, email: '' })), 'Your account');
});

test('toPortalUser: role label is derived from the active org kind', () => {
  assert.deepEqual(toPortalUser(me({ active_org: org('household') })),
    { displayName: 'Nuno Ferreira', roleLabel: 'Owner' });
  assert.deepEqual(toPortalUser(me({ active_org: org('contractor') })),
    { displayName: 'Nuno Ferreira', roleLabel: 'GC' });
  assert.deepEqual(toPortalUser(me({ active_org: org('consultant') })),
    { displayName: 'Nuno Ferreira', roleLabel: 'Consultant' });
  assert.deepEqual(toPortalUser(me({ active_org: org('supplier') })),
    { displayName: 'Nuno Ferreira', roleLabel: 'Supplier' });
});

test('toPortalUser: no active org → empty label, never a crash', () => {
  assert.deepEqual(toPortalUser(me()), { displayName: 'Nuno Ferreira', roleLabel: '' });
});

test('cardRole: household is the owner side, everything else counterparty', () => {
  assert.equal(cardRole('household'), 'owner');
  assert.equal(cardRole('contractor'), 'counterparty');
  assert.equal(cardRole('supplier'), 'counterparty');
  assert.equal(cardRole(null), 'counterparty');
});

test('toBuildStatus: only draft stays draft; every later state reads as live', () => {
  assert.equal(toBuildStatus('draft'), 'draft');
  for (const s of ['tendering', 'contracted', 'in_execution', 'closed', 'cancelled']) {
    assert.equal(toBuildStatus(s), 'active', s);
  }
});

test('toProjectSummary: budget maps with no invented delta; undetermined model → null', () => {
  const overview = {
    project: {
      id: 'b1', name: 'Maple Street', status: 'in_execution',
      operating_model: 'undetermined',
      indicative_budget: { amount_cents: 25_000_00, currency: 'EUR' },
    },
    open_variations: 0, open_questions: 0, pending_verifications: 0,
  };
  const s = toProjectSummary(overview, 'household');
  assert.equal(s.id, 'b1');
  assert.equal(s.name, 'Maple Street');
  assert.equal(s.status, 'active');
  assert.equal(s.role, 'owner');
  assert.equal(s.operatingModel, null);
  assert.equal(s.baselineBudgetCents, 25_000_00);
  assert.equal(s.currentBudgetCents, 25_000_00); // NEVER a fabricated movement
  assert.deepEqual(s.members, []);
  assert.deepEqual(s.counts, { changeOrders: 0, decisions: 0 });
});

test('toProjectSummary: a build with no indicative budget is zero, not NaN', () => {
  const overview = {
    project: { id: 'b2', name: 'No budget yet', status: 'draft', operating_model: 'turnkey' },
    open_variations: 0, open_questions: 0, pending_verifications: 0,
  };
  const s = toProjectSummary(overview, 'contractor');
  assert.equal(s.baselineBudgetCents, 0);
  assert.equal(s.currentBudgetCents, 0);
  assert.equal(s.status, 'draft');
  assert.equal(s.operatingModel, 'turnkey');
  assert.equal(s.role, 'counterparty');
});
