// Contract tests for the specialty catalog (LINA-306 item 6). Proven against the
// in-memory store (which seeds the identical system set the migration seeds):
//   - list returns the seeded system set, sorted, for a fresh party;
//   - create adds a party-owned specialty that then appears in THAT party's list
//     and no one else's (the "cross projects, but mine" scope);
//   - create is idempotent (same label twice → one row) and case-insensitive;
//   - creating a label that already exists as a system row hands the system row
//     back rather than storing a duplicate;
//   - the acting party is the session, never the body (a forged owner is inert);
//   - the label validator rejects empty / non-string / over-long input.
// Run: node --test services/schedule/specialty.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryStore } from './ports.mjs';
import { createSpecialtyService, validateLabel } from './specialty.mjs';
import { createScheduleService } from './schedule.mjs';
import { createScheduleHttp } from './http.mjs';
import { SYSTEM_SPECIALTIES } from './specialty-seed.mjs';

const ALICE = 'party-alice';
const BOB = 'party-bob';

function build() {
  const store = createInMemoryStore();
  const specialty = createSpecialtyService({ store });
  const service = createScheduleService({
    store,
    ledger: { append() {}, currentBudget: () => ({ currentCents: 0 }), getAudit: () => ({ events: [] }) },
    identity: { authorize: () => ({ role: 'counterparty' }), requireMember: () => ({}) },
  });
  const http = createScheduleHttp({ service, specialty });
  return { store, specialty, http };
}

test('list returns the seeded system set, sorted, for a fresh party', async () => {
  const { specialty } = build();
  const { specialties } = await specialty.list(ALICE);
  assert.equal(specialties.length, SYSTEM_SPECIALTIES.length);
  assert.ok(specialties.every((s) => s.ownerScope === 'system' && s.mine === false));
  const labels = specialties.map((s) => s.label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
  assert.ok(labels.includes('Electrical'));
});

test('create adds a party-owned specialty visible only to that party', async () => {
  const { specialty } = build();
  const { specialty: made } = await specialty.create(ALICE, { label: 'Solar & Battery' });
  assert.equal(made.label, 'Solar & Battery');
  assert.equal(made.mine, true);

  const alice = (await specialty.list(ALICE)).specialties.map((s) => s.label);
  assert.ok(alice.includes('Solar & Battery'));

  const bob = (await specialty.list(BOB)).specialties.map((s) => s.label);
  assert.ok(!bob.includes('Solar & Battery'), 'a custom specialty is not visible to another party');
});

test('create is idempotent and case-insensitive for the same owner', async () => {
  const { specialty } = build();
  await specialty.create(ALICE, { label: 'Pool & Spa' });
  await specialty.create(ALICE, { label: 'pool & spa' });
  const mine = (await specialty.list(ALICE)).specialties.filter((s) => s.mine);
  assert.equal(mine.length, 1, 'same label (any case) twice stores one row');
});

test('re-creating a system label returns the system row, not a copy', async () => {
  const { specialty } = build();
  const { specialty: made } = await specialty.create(ALICE, { label: 'electrical' });
  assert.equal(made.ownerScope, 'system');
  assert.equal(made.mine, false);
  const mine = (await specialty.list(ALICE)).specialties.filter((s) => s.mine);
  assert.equal(mine.length, 0, 'no user row is stored for a system-provided label');
});

test('the acting party is the session, never the body', async () => {
  const { http } = build();
  // A forged owner in the body is inert — the created row is owned by ALICE.
  const res = await http.createSpecialty({ session: { partyId: ALICE }, body: { label: 'Custom Trade', ownerId: BOB } });
  assert.equal(res.status, 201);
  const bob = (await http.listSpecialties({ session: { partyId: BOB } })).body.specialties.map((s) => s.label);
  assert.ok(!bob.includes('Custom Trade'), 'the body owner is ignored — Bob does not see Alice’s creation');
});

test('unauthenticated list and create are rejected', async () => {
  const { http } = build();
  assert.equal((await http.listSpecialties({ session: null })).status, 401);
  assert.equal((await http.createSpecialty({ session: null, body: { label: 'x' } })).status, 401);
});

test('label validation rejects empty / non-string / over-long', () => {
  assert.throws(() => validateLabel(''), /non-empty/);
  assert.throws(() => validateLabel('   '), /non-empty/);
  assert.throws(() => validateLabel(42), /must be a string/);
  assert.throws(() => validateLabel('x'.repeat(121)), /≤ 120/);
  assert.equal(validateLabel('  Electrical  '), 'Electrical');
});
