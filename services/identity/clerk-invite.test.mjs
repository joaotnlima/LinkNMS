// Identity — tests for the D-1 waitlist-activation batch (LINA-130).
//
// These tests lock the data-integrity behaviour the go-date batch must hold:
//   - "the first 10 waitlisted, ordered by signup_order" — only waitlisted rows,
//     in deterministic order, limited to N;
//   - a row is flipped to active AND granted a seat ONLY after its Clerk invite
//     succeeded — an invite that throws must not half-activate the row;
//   - one failed invite must not abort the batch (the other nine still go out);
//   - a re-run skips already-activated rows (never double-invites);
//   - dry-run previews who would go out without inviting, seating, or flipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createClerkOrgInviter,
  sendWaitlistInvitations,
} from './clerk-invite.mjs';
import { createInMemoryStore } from '../waitlist/ports.mjs';

// Seed an in-memory waitlist store with N waitlisted rows (ordered 1..n), plus a
// couple already-active rows that must never be reconsidered.
function seedStore({ n, extraActive = 2 } = {}) {
  const store = createInMemoryStore();
  for (let i = 1; i <= n; i++) {
    const emailNorm = `user${i}@example.com`;
    store.insert({}, {
      id: `id-${i}`,
      email: `user${i}@example.com`,
      email_norm: emailNorm,
      status: 'waitlisted',
      created_at: new Date().toISOString(),
    });
  }
  // Already-active rows — out of scope, must stay out.
  for (let i = 0; i < extraActive; i++) {
    const emailNorm = `active${i}@example.com`;
    store.insert({}, {
      id: `active-id-${i}`,
      email: `active${i}@example.com`,
      email_norm: emailNorm,
      status: 'active',
      created_at: new Date().toISOString(),
    });
  }
  return store;
}

function fakeSeats({ failFor = new Set() } = {}) {
  const granted = [];
  return {
    async grant(email) {
      if (failFor.has(email)) throw new Error(`seat grant failed for ${email}`);
      granted.push(email);
    },
    _granted: granted,
  };
}

// An inviter that records calls and can be primed to throw for specific emails so
// partial-failure behaviour is testable. The port is a BARE function (like
// createClerkOrgInviter's return); call log rides on an attached property.
function fakeInviter({ failFor = new Set() } = {}) {
  const called = [];
  const invite = async (email) => {
    called.push(email);
    if (failFor.has(email)) throw new Error(`clerk rejected ${email}`);
    return `inv_${email}`;
  };
  invite._called = called;
  return invite;
}

test('activates the first N waitlisted ordered by signup_order, seats each', async () => {
  const store = seedStore({ n: 12 });
  const seats = fakeSeats();
  const inviter = fakeInviter();

  const { invited, summary } = await sendWaitlistInvitations({
    store, seats, inviter, limit: 10,
  });

  assert.equal(summary.total, 10);
  assert.equal(summary.invited, 10);
  assert.equal(summary.failed, 0);

  // Exactly the first 10 waitlisted signups, in signup_order, NOT the active rows.
  assert.deepEqual(
    invited.map((e) => e.email),
    Array.from({ length: 10 }, (_, i) => `user${i + 1}@example.com`),
  );
  assert.deepEqual(
    inviter._called,
    Array.from({ length: 10 }, (_, i) => `user${i + 1}@example.com`),
  );

  // Every invited row was seated (ADR-0008) and flipped to active.
  for (let i = 1; i <= 10; i++) {
    const e = invited[i - 1];
    assert.equal(e.outcome, 'invited');
    assert.equal(e.clerkInvitationId, `inv_user${i}@example.com`);
    assert.equal(store.getByEmail(`user${i}@example.com`).status, 'active');
  }
  assert.equal(seats._granted.length, 10);
});

test('active rows are never reconsidered even if within the first N', async () => {
  const store = createInMemoryStore();
  store.insert({}, { id: 'a', email: 'a@example.com', email_norm: 'a@example.com', status: 'active', created_at: 'x' });
  store.insert({}, { id: 'b', email: 'b@example.com', email_norm: 'b@example.com', status: 'waitlisted', created_at: 'x' });
  const seats = fakeSeats();
  const inviter = fakeInviter();

  const { invited, summary } = await sendWaitlistInvitations({ store, seats, inviter, limit: 10 });

  assert.equal(summary.total, 1);
  assert.deepEqual(invited.map((e) => e.email), ['b@example.com']);
  assert.equal(seats._granted.length, 1);
});

test('a failed invite does not seat or activate that row, and does not abort the batch', async () => {
  const store = seedStore({ n: 3 });
  const seats = fakeSeats();
  const inviter = fakeInviter({ failFor: new Set(['user2@example.com']) });

  const { invited, summary } = await sendWaitlistInvitations({ store, seats, inviter, limit: 3 });

  assert.equal(summary.invited, 2);
  assert.equal(summary.failed, 1);

  const byEmail = Object.fromEntries(invited.map((e) => [e.email, e]));
  // The failed row was NOT seated and NOT flipped.
  assert.equal(byEmail['user2@example.com'].outcome, 'failed');
  assert.equal(store.getByEmail('user2@example.com').status, 'waitlisted');
  assert.equal(seats._granted.includes('user2@example.com'), false);
  // The other two still went out.
  assert.equal(byEmail['user1@example.com'].outcome, 'invited');
  assert.equal(byEmail['user3@example.com'].outcome, 'invited');
  assert.equal(seats._granted.length, 2);
});

test('a failed SEAT grant leaves the row waitlisted so a rerun can recover it', async () => {
  // The seat is the access gate (ADR-0008): an `active` row with no seat is a
  // user who authenticates straight into /no-access. If the seat write fails,
  // the row must NOT be promoted — otherwise listByStatusOrder('waitlisted')
  // would skip it forever and the batch could never seat it.
  const store = seedStore({ n: 3 });
  const seats = fakeSeats({ failFor: new Set(['user2@example.com']) });
  const inviter = fakeInviter();

  const { invited, summary } = await sendWaitlistInvitations({ store, seats, inviter, limit: 3 });

  assert.equal(summary.invited, 2);
  assert.equal(summary.failed, 1);

  const byEmail = Object.fromEntries(invited.map((e) => [e.email, e]));
  // The seat-failed row is reported failed and — critically — NOT active.
  assert.equal(byEmail['user2@example.com'].outcome, 'failed');
  assert.equal(store.getByEmail('user2@example.com').status, 'waitlisted');
  // Its activation was never recorded either.
  assert.equal(store.getByEmail('user2@example.com').clerkInvitationId ?? null, null);
  // A rerun (seat now succeeds) picks the row back up and completes it.
  const seats2 = fakeSeats();
  const rerun = await sendWaitlistInvitations({ store, seats: seats2, inviter, limit: 3 });
  assert.equal(rerun.summary.total, 1);
  assert.deepEqual(rerun.invited.map((e) => e.email), ['user2@example.com']);
  assert.equal(store.getByEmail('user2@example.com').status, 'active');
  assert.equal(seats2._granted.includes('user2@example.com'), true);
});

test('a rerun skips already-activated rows (no double invite)', async () => {
  const store = seedStore({ n: 12 });
  const seats = fakeSeats();
  const inviter = fakeInviter();

  // First run activates the first 10.
  await sendWaitlistInvitations({ store, seats, inviter, limit: 10 });
  const firstCalls = [...inviter._called];

  // Second run: those 10 are now active and listByStatusOrder('waitlisted')
  // returns only the remaining 2 — so nothing is re-invited.
  const { invited, summary } = await sendWaitlistInvitations({ store, seats, inviter, limit: 10 });
  assert.equal(summary.total, 2);
  assert.equal(summary.invited, 2);
  assert.deepEqual(invited.map((e) => e.email), ['user11@example.com', 'user12@example.com']);
  assert.deepEqual(inviter._called, [...firstCalls, 'user11@example.com', 'user12@example.com']);
  assert.equal(seats._granted.length, 12);
});

test('dry-run previews who would go out without inviting, seating, or flipping', async () => {
  const store = seedStore({ n: 10 });
  const seats = fakeSeats();
  const inviter = fakeInviter();

  const { invited, summary } = await sendWaitlistInvitations({
    store, seats, inviter, limit: 5, dryRun: true,
  });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.invited, 0);
  assert.equal(summary.total, 5);
  assert.deepEqual(invited.map((e) => e.email), Array.from({ length: 5 }, (_, i) => `user${i + 1}@example.com`));
  // Nothing was actually invoked or mutated.
  assert.deepEqual(inviter._called, []);
  assert.equal(seats._granted.length, 0);
  for (let i = 1; i <= 10; i++) {
    assert.equal(store.getByEmail(`user${i}@example.com`).status, 'waitlisted');
  }
});

test('createClerkOrgInviter validates config and passes the correct org invite params', async () => {
  assert.throws(() => createClerkOrgInviter({ orgId: 'o_1' }), /CLERK_SECRET_KEY/);
  assert.throws(() => createClerkOrgInviter({ secretKey: 'sk' }), /CLERK_ORG_ID/);
  assert.throws(() => createClerkOrgInviter({ secretKey: 'sk', orgId: 'o_1' }), /@clerk\/backend/);

  // With a stub clerkBackend, the params reach the org invitation endpoint.
  const calls = [];
  const invite = createClerkOrgInviter(
    { secretKey: 'sk_live_x', orgId: 'org_1', role: 'basic_member' },
    {
      createClerkClient: () => ({
        organizations: {
          async createOrganizationInvitation(p) { calls.push(p); return { id: 'inv_1' }; },
        },
      }),
    },
  );
  const id = await invite('ana@example.com');
  assert.equal(id, 'inv_1');
  assert.deepEqual(calls[0], {
    organizationId: 'org_1',
    emailAddress: 'ana@example.com',
    role: 'basic_member',
  });
});
