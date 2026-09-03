// The seat gate survives the Clerk cutover (LINA-124; ADR-0008).
//
// The gate's old tests died with the magic-link service that hosted it. These
// replace them at the new home. The property under test is the one 0004
// _identity.sql exists for: an address with no active seat must not get in, no
// matter how convincingly it authenticates — because the step immediately after
// the gate is `findOrCreateByEmail`, i.e. becoming a party on the record.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemorySeatStore, createSeatStore } from './seats.mjs';
import { normalizeEmail } from './email-normalize.mjs';

test('the seat gate', async (t) => {
  await t.test('admits an address holding an active seat', async () => {
    const seats = createMemorySeatStore({ seats: ['ana@example.com'] });
    assert.equal(await seats.hasActiveSeat('ana@example.com'), true);
  });

  await t.test('refuses an address with no seat — the open-registration guard', async () => {
    const seats = createMemorySeatStore({ seats: ['ana@example.com'] });
    assert.equal(await seats.hasActiveSeat('stranger@example.com'), false);
  });

  await t.test('refuses an empty allowlist rather than falling open', async () => {
    const seats = createMemorySeatStore();
    assert.equal(await seats.hasActiveSeat('anyone@example.com'), false);
  });

  await t.test('is case- and whitespace-insensitive, matching how seats are granted', async () => {
    const seats = createMemorySeatStore({ seats: ['Ana@Example.com'] });
    assert.equal(await seats.hasActiveSeat('  ana@example.com '), true);
  });

  await t.test('refuses a malformed or absent address without touching the store', async () => {
    const seats = createMemorySeatStore({ seats: ['ana@example.com'] });
    for (const bad of [undefined, null, '', 'not-an-email', 'a@b', 42, {}]) {
      assert.equal(await seats.hasActiveSeat(bad), false, `expected ${String(bad)} to be refused`);
    }
  });
});

test('the Postgres seat store asks only whether an ACTIVE seat exists', async (t) => {
  await t.test('one indexed point lookup, normalised, status-filtered', async () => {
    const queries = [];
    const pool = {
      async query(text, params) {
        queries.push({ text, params });
        return { rowCount: 1, rows: [{ '?column?': 1 }] };
      },
    };
    const seats = createSeatStore({ pool });

    assert.equal(await seats.hasActiveSeat(' Ana@Example.com '), true);
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /from identity\.seat/);
    assert.match(queries[0].text, /status = 'active'/);
    // The normalised form is what reaches the database — a seat granted to the
    // lower-cased address must match however the user typed it.
    assert.deepEqual(queries[0].params, ['ana@example.com']);
  });

  await t.test('a malformed address never reaches the database', async () => {
    let called = false;
    const pool = { async query() { called = true; return { rowCount: 0, rows: [] }; } };
    assert.equal(await createSeatStore({ pool }).hasActiveSeat('nope'), false);
    assert.equal(called, false);
  });

  await t.test('no matching row is a refusal, not an error', async () => {
    const pool = { async query() { return { rowCount: 0, rows: [] }; } };
    assert.equal(await createSeatStore({ pool }).hasActiveSeat('ghost@example.com'), false);
  });
});

test('normalizeEmail is the one key every identity path shares', async (t) => {
  await t.test('lower-cases and trims', () => {
    assert.equal(normalizeEmail('  Ana@Example.COM '), 'ana@example.com');
  });

  await t.test('rejects what is not an address', () => {
    for (const bad of ['', 'ana', 'ana@', '@example.com', 'ana@example', undefined, null, 7]) {
      assert.equal(normalizeEmail(bad), null, `expected ${String(bad)} to be rejected`);
    }
  });
});
