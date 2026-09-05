// The founding-seat cap, proven against a real Postgres (LINA-189).
//
// The fifty founding seats are a promise made in public on the landing page, and
// 0010_identity.sql enforces it in the database rather than in application code
// so that no refactor, no bug and no compromise of the landing site can issue
// seat 51. A promise enforced by a trigger is only as good as the test that the
// trigger actually fires, which is this file.
//
// It also pins the privilege boundary that made the self-serve claim acceptable
// in the first place: the landing role may INSERT a seat and do nothing else to
// one, and identity_app — the portal's request path — still cannot write a seat
// at all. That second assertion is the one that keeps ADR-0008 true.
//
// Skips without DATABASE_URL, same convention as the other pg suites.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { createPool, sslFor } from '../ledger/db.mjs';
import { createSeatStore } from './seats.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const DB = process.env.DATABASE_URL;
const ssl = sslFor(DB);

const MIGRATIONS = [
  'db/0001_platform.sql',
  'services/ledger/migrations/0001_ledger.sql',
  'services/ledger/migrations/0002_ledger_roles.sql',
  'services/ledger/migrations/0003_ledger_identity_grant.sql',
  'services/identity/migrations/0001_identity.sql',
  'services/identity/migrations/0002_identity.sql',
  'services/identity/migrations/0003_identity.sql',
  'services/identity/migrations/0004_identity.sql',
  'services/identity/migrations/0005_identity.sql',
  'services/identity/migrations/0006_identity.sql',
  'services/identity/migrations/0007_identity.sql',
  'services/identity/migrations/0008_identity.sql',
  'services/identity/migrations/0009_identity.sql',
  'services/identity/migrations/0010_identity.sql',
];

const CAP = 50;
const EXHAUSTED = '23001'; // restrict_violation — "all fifty are gone"

describe('Postgres founding seats (cap + writer boundary)', {
  skip: DB ? false : 'set DATABASE_URL to run',
}, () => {
  let ownerPool;
  let identityPool;

  before(async () => {
    ownerPool = new Pool({ connectionString: DB, ssl, max: 4 });
    for (const rel of MIGRATIONS) {
      await ownerPool.query(await readFile(join(ROOT, rel), 'utf8'));
    }
    identityPool = createPool(DB, { role: 'identity_app', max: 2 });
    // Start from a known floor: other suites in the same database may have left
    // hand-granted seats behind, but nothing else creates 'founding' rows.
    await ownerPool.query("DELETE FROM identity.seat WHERE source = 'founding'");
  });

  after(async () => {
    await ownerPool?.query("DELETE FROM identity.seat WHERE source = 'founding'");
    await identityPool?.end();
    await ownerPool?.end();
  });

  const claim = (n) =>
    ownerPool.query(
      "INSERT INTO identity.seat (email, source, note) VALUES ($1, 'founding', $2)",
      [`founder${n}@example.com`, `claim ${n}`],
    );

  test('the 51st founding seat is refused by the database', async () => {
    for (let i = 0; i < CAP; i += 1) await claim(i);

    const { rows } = await ownerPool.query(
      "SELECT count(*)::int AS cnt FROM identity.seat WHERE source = 'founding'",
    );
    assert.equal(rows[0].cnt, CAP, 'all fifty should have been granted');

    await assert.rejects(
      () => claim(CAP),
      (err) => {
        // The distinct SQLSTATE is load-bearing: the landing site reports "seats
        // are gone" on this code and "something broke" on anything else, so a
        // generic error here would tell a visitor the wrong story.
        assert.equal(err.code, EXHAUSTED);
        return true;
      },
      'seat 51 must be rejected',
    );
  });

  test('a revoked founding seat does not free up a slot', async () => {
    // Fifty people were admitted. Revoking one removes their access; it does not
    // hand the founding-50 promise to the next comer.
    await ownerPool.query(
      "UPDATE identity.seat SET status='revoked', revoked_at=now() " +
        "WHERE source='founding' AND email='founder0@example.com'",
    );
    await assert.rejects(() => claim(CAP + 1), (err) => err.code === EXHAUSTED);
  });

  test('a founding seat cannot be born revoked', async () => {
    await ownerPool.query("DELETE FROM identity.seat WHERE source = 'founding'");
    await assert.rejects(
      () =>
        ownerPool.query(
          "INSERT INTO identity.seat (email, source, status, revoked_at) " +
            "VALUES ('sneaky@example.com', 'founding', 'revoked', now())",
        ),
      (err) => err.code === '23514', // check_violation, raised by the trigger
      'a pre-revoked founding row would otherwise dodge the cap and then flip active',
    );
  });

  test('hand-granted and invited seats are not capped', async () => {
    // The cap is about the founding programme only. Counterparties invited onto
    // someone else's project must keep riding in freely (ADR-0008), even with
    // the founding fifty exhausted.
    await ownerPool.query("DELETE FROM identity.seat WHERE source = 'founding'");
    for (let i = 0; i < CAP; i += 1) await claim(i);
    await ownerPool.query(
      "INSERT INTO identity.seat (email, source) VALUES ('sub@example.com', 'invite')",
    );
    const { rows } = await ownerPool.query(
      "SELECT count(*)::int AS cnt FROM identity.seat WHERE source = 'invite'",
    );
    assert.ok(rows[0].cnt >= 1, 'invited seats must still be grantable');
    await ownerPool.query("DELETE FROM identity.seat WHERE email = 'sub@example.com'");
  });

  test('identity_app still cannot write a seat, and can still read one', async () => {
    // ADR-0008's actual property: the PORTAL's request path cannot seat anybody.
    // 0010 added a writer, but it is a different role — this must stay refused.
    await assert.rejects(
      () =>
        identityPool.query(
          "INSERT INTO identity.seat (email, source) VALUES ('self@example.com', 'founding')",
        ),
      (err) => err.code === '42501', // insufficient_privilege
      'identity_app must never be able to seat anybody',
    );

    // And the gate the portal actually depends on still works.
    const seats = createSeatStore({ pool: identityPool });
    assert.equal(await seats.hasActiveSeat('founder1@example.com'), true);
    assert.equal(await seats.hasActiveSeat('nobody@example.com'), false);
    // Normalisation parity: the landing site lower-cases before granting, and
    // the gate lower-cases before looking up. If those ever drift, a claimed
    // seat silently stops matching at sign-in.
    assert.equal(await seats.hasActiveSeat('  Founder1@Example.com '), true);
  });
});
