// Postgres integration test for magic-link sign-in (LINA-76; ADR-0007).
//
// Runs against a real Postgres (a throwaway Neon branch or the CI container) —
// set DATABASE_URL to the migrator/owner connection. Without it the suite skips,
// so CI on a machine with no DB stays green while the DB job runs the real thing
// (same convention as pg-identity.test.mjs).
//
// What it proves beyond the in-memory tests:
//   * 0003_identity.sql applies on top of the platform + ledger + identity
//     migrations, and identity_app's grants on identity.sign_in_token resolve;
//   * the FULL path works through pg as identity_app: request → consume → party →
//     a minted session cookie that verifies back to that party (the "GET
//     /api/v1/sessions 200" the ADR's done-list asks for);
//   * the DOUBLE-CONSUME RACE is settled by the DB, not just the JS model: two
//     concurrent consumeToken() on one token flip exactly one row;
//   * /request does not distinguish a known email from an unknown one;
//   * an expired token cannot be consumed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, sslFor } from '../ledger/db.mjs';
import { createPgSignInStore } from './sign-in-store.mjs';
import { createPartyStore } from './parties.mjs';
import { createSignInService } from './sign-in.mjs';
import { mintSession, verifySession } from './session.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const DB = process.env.DATABASE_URL;
const ssl = sslFor(DB);
const SECRET = 'test-secret-at-least-32-characters-long!!';

const MIGRATIONS = [
  'db/0001_platform.sql',
  'services/ledger/migrations/0001_ledger.sql',
  'services/ledger/migrations/0002_ledger_roles.sql',
  'services/identity/migrations/0001_identity.sql',
  'services/identity/migrations/0002_identity.sql',
  'services/identity/migrations/0003_identity.sql',
  'services/identity/migrations/0004_identity.sql',
];

// A sender that never touches the network. It is "configured" so /request runs
// the full mint+send path; it records nothing sensitive we assert on beyond the
// fact that a send happened.
function fakeSender() {
  const sent = [];
  return { sent, isConfigured: () => true, async send(msg) { sent.push(msg); return { id: 'x' }; } };
}

// Deterministic, recording token minter so a test can consume the exact raw token
// the service just "emailed" — proving only its sha256 was persisted.
function recordingIds() {
  const tokens = [];
  let n = 0;
  return { tokens, uuid: () => randomUUID(), token: () => { const t = `raw-${randomUUID()}`; tokens.push(t); return t; } };
}

describe('Postgres magic-link sign-in', { skip: DB ? false : 'set DATABASE_URL to run' }, () => {
  let ownerPool; // migrator/owner: applies DDL
  let appPool; // identity_app: the real runtime grants
  let store;
  let parties;

  before(async () => {
    ownerPool = new Pool({ connectionString: DB, ssl, max: 4 });
    for (const rel of MIGRATIONS) {
      const sql = await readFile(join(ROOT, rel), 'utf8');
      await ownerPool.query(sql);
    }
    // Connect as the login role and SET ROLE into identity_app — the deployed
    // mechanism (services/gateway/container.mjs). The token table and the party
    // table are both identity_app's, so one role serves both.
    appPool = createPool(DB, { role: 'identity_app', max: 4 });
    store = createPgSignInStore({ pool: appPool });
    parties = createPartyStore({ pool: appPool });
  });

  after(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  // Grant a seat as the OWNER, because identity_app deliberately cannot
  // (0004_identity.sql grants it SELECT only). Every address these tests sign in
  // with must be seated first — that is the ADR-0008 gate doing its job.
  async function seat(email) {
    await ownerPool.query(
      "insert into identity.seat (email, source, note) values ($1,'beta','pg test') on conflict (email) do nothing",
      [email],
    );
    return email;
  }

  function service(overrides = {}) {
    return createSignInService({
      store,
      parties,
      sender: overrides.sender ?? fakeSender(),
      ids: overrides.ids ?? recordingIds(),
      env: {},
      ...overrides.opts,
    });
  }

  test('FULL PATH: request → consume → party → a session cookie that verifies', async () => {
    const ids = recordingIds();
    const sender = fakeSender();
    const svc = service({ ids, sender });
    const email = await seat(`dana-${randomUUID()}@example.com`);

    await svc.request({ email, baseUrl: 'https://app.linknms.com' });
    assert.equal(sender.sent.length, 1, 'a link was emailed');
    const raw = ids.tokens.at(-1);

    const { party } = await svc.consume({ token: raw });
    assert.equal(party.email, email);
    assert.ok(party.id);

    // The route would mint the cookie here — prove it verifies back to the party
    // (this is the "GET /api/v1/sessions 200" the done-list requires).
    const { token: cookie } = mintSession({ partyId: party.id }, { secret: SECRET });
    const verified = verifySession(cookie, { secret: SECRET });
    assert.equal(verified.partyId, party.id);
    const whoami = await parties.getById(verified.partyId);
    assert.equal(whoami.email, email);
  });

  test('DOUBLE-CONSUME RACE settled by the DB: two concurrent consumes → one row', async () => {
    const ids = recordingIds();
    const svc = service({ ids });
    await svc.request({ email: await seat(`race-${randomUUID()}@example.com`), baseUrl: 'https://app.linknms.com' });
    const raw = ids.tokens.at(-1);
    const hash = (await import('node:crypto')).createHash('sha256').update(raw).digest('hex');
    const now = new Date().toISOString();

    const [a, b] = await Promise.all([store.consumeToken(hash, now), store.consumeToken(hash, now)]);
    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one concurrent consume flips the row');
    // And a third, later consume also finds nothing.
    assert.equal(await store.consumeToken(hash, new Date().toISOString()), null);
  });

  test('/request does not distinguish a known email from an unknown one (ADR §4)', async () => {
    // Both are SEATED, so the only difference under test is party-existence —
    // which is the thing ADR-0007 §4 says must not be observable.
    const known = await seat(`known-${randomUUID()}@example.com`);
    await parties.findOrCreateByEmail({ email: known, role: 'contractor' }); // pre-existing party
    const unknown = await seat(`unknown-${randomUUID()}@example.com`);

    const sender = fakeSender();
    const svc = service({ sender });
    await svc.request({ email: known, baseUrl: 'https://app.linknms.com' });
    await svc.request({ email: unknown, baseUrl: 'https://app.linknms.com' });

    assert.equal(sender.sent.length, 2, 'both mint + send — same observable behaviour');
    // Both rows landed in the token table regardless of membership.
    const since = new Date(Date.now() - 60_000).toISOString();
    assert.equal(await store.countRecentByEmail(known, since), 1);
    assert.equal(await store.countRecentByEmail(unknown, since), 1);
  });

  test('an expired token cannot be consumed', async () => {
    // Mint directly with an already-past expiry to avoid waiting out the TTL.
    const raw = `raw-${randomUUID()}`;
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await store.insertToken({
      id: randomUUID(),
      email: `exp-${randomUUID()}@example.com`,
      displayName: null,
      tokenHash: hash,
      requestIp: null,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(await store.consumeToken(hash, new Date().toISOString()), null);
  });

  test('write-scope: identity_app can read/insert/update sign_in_token but not DELETE', async () => {
    await assert.rejects(
      appPool.query('delete from identity.sign_in_token'),
      /permission denied/i,
      'no DELETE grant — spent rows are pruned out-of-band, not on the request path',
    );
  });

  // ── The seat gate at the database level (LINA-75; ADR-0008) ────────────────
  test('an unseated address mints NO row against real Postgres', async () => {
    const sender = fakeSender();
    const svc = service({ sender });
    const email = `unseated-${randomUUID()}@example.com`;

    await svc.request({ email, baseUrl: 'https://app.linknms.com' });

    assert.equal(sender.sent.length, 0, 'no email for an address with no seat');
    const { rows } = await ownerPool.query(
      'select count(*)::int as n from identity.sign_in_token where email = $1',
      [email],
    );
    assert.equal(rows[0].n, 0, 'no sign_in_token row exists for an unseated address');
  });

  test('GRANT REGRESSION: identity_app can read seats but cannot create one', async () => {
    // The runtime role must not be able to widen who may sign in — that is the
    // whole reason seats are issued out of band (0004_identity.sql). If someone
    // ever adds INSERT to that grant, this test is what catches it.
    const email = `selfseat-${randomUUID()}@example.com`;
    await assert.rejects(
      () => appPool.query("insert into identity.seat (email) values ($1)", [email]),
      (e) => /permission denied/i.test(e.message),
      'identity_app must not hold INSERT on identity.seat',
    );
    // ...while the SELECT the gate depends on does work.
    await ownerPool.query("insert into identity.seat (email) values ($1)", [email]);
    assert.equal(await store.hasActiveSeat(email), true);
    // A revoked seat closes the door again.
    await ownerPool.query(
      "update identity.seat set status='revoked', revoked_at=now() where email=$1", [email],
    );
    assert.equal(await store.hasActiveSeat(email), false);
  });
});