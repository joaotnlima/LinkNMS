// The retained v1 auth bridge on @modules (LINA-401).
//
// These replace services/identity/{seats,parties}.test.mjs at the new home. The
// property under test is the one 0004_identity.sql exists for: an address with
// no active seat must not get in, no matter how convincingly it authenticates —
// because the step immediately after the gate is findOrCreateByEmail, i.e.
// becoming a party on the record.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuthBridgeStore, createMemoryAuthBridge } from './auth-bridge.mjs';
import { normalizeEmail } from '../domain/email.mjs';

test('the seat gate', async (t) => {
  await t.test('admits an address holding an active seat', async () => {
    const bridge = createMemoryAuthBridge({ seats: ['ana@example.com'] });
    assert.equal(await bridge.hasActiveSeat('ana@example.com'), true);
  });

  await t.test('refuses an address with no seat — the open-registration guard', async () => {
    const bridge = createMemoryAuthBridge({ seats: ['ana@example.com'] });
    assert.equal(await bridge.hasActiveSeat('stranger@example.com'), false);
  });

  await t.test('refuses an empty allowlist rather than falling open', async () => {
    const bridge = createMemoryAuthBridge();
    assert.equal(await bridge.hasActiveSeat('anyone@example.com'), false);
  });

  await t.test('is case- and whitespace-insensitive, matching how seats are granted', async () => {
    const bridge = createMemoryAuthBridge({ seats: ['ana@example.com'] });
    assert.equal(await bridge.hasActiveSeat('  Ana@Example.com '), true);
  });

  await t.test('refuses a malformed address instead of querying', async () => {
    const bridge = createMemoryAuthBridge({ seats: ['ana@example.com'] });
    assert.equal(await bridge.hasActiveSeat('not-an-email'), false);
    assert.equal(await bridge.hasActiveSeat(null), false);
  });
});

test('the email → party mapping', async (t) => {
  await t.test('creates a placeholder party on first sight (setup not complete)', async () => {
    const bridge = createMemoryAuthBridge();
    const party = await bridge.findOrCreateByEmail({ email: 'new@example.com' });
    assert.equal(party.email, 'new@example.com');
    assert.equal(party.role, 'contractor');
    assert.equal(party.setupComplete, false);
  });

  await t.test('returns the SAME party for the same address (idempotent)', async () => {
    const bridge = createMemoryAuthBridge();
    const a = await bridge.findOrCreateByEmail({ email: 'Dup@example.com' });
    const b = await bridge.findOrCreateByEmail({ email: 'dup@example.com ' });
    assert.equal(a.id, b.id);
  });

  await t.test('preserves setupComplete for an already set-up party', async () => {
    const bridge = createMemoryAuthBridge({ parties: [{ email: 'done@example.com', setupComplete: true }] });
    const party = await bridge.findOrCreateByEmail({ email: 'done@example.com' });
    assert.equal(party.setupComplete, true);
  });

  await t.test('rejects a non-address', async () => {
    const bridge = createMemoryAuthBridge();
    await assert.rejects(() => bridge.findOrCreateByEmail({ email: 'garbage' }), /valid email/);
  });
});

test('normalizeEmail matches the grant-side rule', () => {
  assert.equal(normalizeEmail('  Ana@Example.com '), 'ana@example.com');
  assert.equal(normalizeEmail('no-at-sign'), null);
  assert.equal(normalizeEmail('x@y'), null); // requires a dotted domain
  assert.equal(normalizeEmail(42), null);
});

test('the pg store issues the exact seat + party SQL', async (t) => {
  await t.test('hasActiveSeat probes identity.seat by normalised email', async () => {
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [{ ['?column?']: 1 }] };
      },
    };
    const store = createAuthBridgeStore(pool);
    assert.equal(await store.hasActiveSeat(' Ana@Example.com '), true);
    assert.match(calls[0].sql, /from identity\.seat where email = \$1 and status = 'active'/);
    assert.deepEqual(calls[0].params, ['ana@example.com']);
  });

  await t.test('findOrCreateByEmail upserts identity.party on conflict(email)', async () => {
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [{ id: 'p1', display_name: 'ana', email: 'ana@example.com', role: 'contractor', setup_complete: false }],
        };
      },
    };
    const store = createAuthBridgeStore(pool);
    const party = await store.findOrCreateByEmail({ email: 'ana@example.com' });
    assert.match(calls[0].sql, /insert into identity\.party/);
    assert.match(calls[0].sql, /on conflict \(email\) do update set email = excluded\.email/);
    assert.deepEqual(calls[0].params, ['ana', 'ana@example.com', 'contractor']);
    assert.equal(party.id, 'p1');
    assert.equal(party.setupComplete, false);
  });
});
