// Postgres integration test for Identity & Membership (design §9, ADR-0006 §1).
//
// Runs against a real Postgres (a throwaway Neon branch) — set DATABASE_URL to the
// owner/migrator connection string. Without it the suite skips, so CI on a machine
// with no DB stays green while the DB job runs the real thing (same convention as
// the ledger suite).
//
// What it proves beyond the in-memory tests:
//   * the 0002_identity.sql DDL applies cleanly on top of the platform + ledger
//     migrations, and the grant matrix resolves;
//   * the create → invite → accept flow works through pg-store as `identity_app`;
//   * the cross-schema transaction is real: project_created / member_joined land in
//     ledger.audit_event via ledger.append_event, and the chain verifies;
//   * the write-guard holds — identity_app can EXECUTE append_event but holds NO
//     direct INSERT on ledger.audit_event (ADR-0002 §4).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, sslFor } from '../ledger/db.mjs';
import { createPgLedger } from '../ledger/pg-ledger.mjs';
import { verifyChain } from '../ledger/hash-chain.mjs';
import { createPgStore } from './pg-store.mjs';
import { createIdentityService } from './identity.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const DB = process.env.DATABASE_URL;
// sslFor() reads the target: TLS off-localhost, none on it. Hard-coding TLS here
// made this suite Neon-only — against the CI Postgres container it died with
// 'The server does not support SSL connections' before a single assertion ran.
const ssl = sslFor(DB);

// Migrations applied in the runner's deterministic order (db/migrate.mjs), minus
// db/roles.sql: role creation + database-level GRANTs are a one-per-environment
// bootstrap the platform owner runs (see roles.sql header), so DATABASE_URL here
// is the `migrator` (owner) connection and the *_app roles are assumed to exist —
// exactly the production split. pgcrypto is likewise pre-installed by the owner.
const MIGRATIONS = [
  'db/0001_platform.sql',
  'services/ledger/migrations/0001_ledger.sql',
  'services/ledger/migrations/0002_ledger_roles.sql',
  'services/identity/migrations/0001_identity.sql',
  'services/identity/migrations/0002_identity.sql',
];

describe('Postgres identity (membership + authz + ledger seam)', { skip: DB ? false : 'set DATABASE_URL to run' }, () => {
  let ownerPool; // migrator/owner: applies DDL, runs the ledger's reads
  let appPool; // connects AS identity_app: the real runtime grants
  let svc;
  let ledger;

  before(async () => {
    // DATABASE_URL is the migrator (owner) connection — it owns the schemas and the
    // append_event function, so all DDL/grants apply as in production.
    ownerPool = new Pool({ connectionString: DB, ssl, max: 4 });
    for (const rel of MIGRATIONS) {
      const sql = await readFile(join(ROOT, rel), 'utf8');
      await ownerPool.query(sql);
    }

    // Connect as the login role, then SET ROLE into identity_app — the same
    // mechanism the deployed API uses (services/gateway/container.mjs, LINA-56).
    //
    // This previously opened a second connection AS identity_app with a password
    // supplied out of band. Neon provisions the `<service>_app` roles NOLOGIN, so
    // on any real branch that failed with `28P01 password authentication failed`
    // and every assertion below — including the write-guard, which is the whole
    // point of the file — silently stopped running. SET ROLE needs no second
    // credential and yields exactly the same privilege set.
    appPool = createPool(DB, { role: 'identity_app', max: 4 });

    // The ledger core: budgetSummary reads run on the owner pool; append(client, …)
    // runs on whatever client it's handed — here, identity_app's tx client.
    ledger = createPgLedger({ pool: ownerPool });
    const store = createPgStore({ pool: appPool, ledger });
    svc = createIdentityService({ store, ledger });
  });

  after(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  test('create → invite → accept flow, with a verifying ledger chain', async () => {
    const owner = randomUUID();
    const project = await svc.createProject({ actorPartyId: owner, name: 'Maple Street', baselineBudgetCents: 250_000_00 });
    assert.equal(project.actingRole, 'owner');
    assert.equal(project.currentBudgetCents, 250_000_00);

    const { token, invitation } = await svc.inviteCounterparty({ actorPartyId: owner, projectId: project.id });
    assert.equal(invitation.status, 'pending');

    const gc = randomUUID();
    const { membership } = await svc.acceptInvitation({ actorPartyId: gc, token });
    assert.equal(membership.role, 'counterparty');

    const view = await svc.getProject({ actorPartyId: gc, projectId: project.id });
    assert.deepEqual(view.members.map((m) => m.role).sort(), ['counterparty', 'owner']);

    // The two identity events chained through ledger.append_event, and verify.
    const chain = await ledger._chain(project.id);
    assert.deepEqual(chain.map((e) => e.type), ['project_created', 'member_joined']);
    assert.equal(verifyChain(chain).verified, true);
  });

  test('non-members get 403; only the owner invites', async () => {
    const owner = randomUUID();
    const p = await svc.createProject({ actorPartyId: owner, name: 'Oak', baselineBudgetCents: 100 });
    await assert.rejects(svc.getProject({ actorPartyId: randomUUID(), projectId: p.id }), (e) => e.status === 403);
    await assert.rejects(svc.inviteCounterparty({ actorPartyId: randomUUID(), projectId: p.id }), (e) => e.status === 403);
  });

  test('write-guard: identity_app cannot INSERT ledger.audit_event directly', async () => {
    await assert.rejects(
      appPool.query(
        `insert into ledger.audit_event
           (project_id, seq, type, occurred_at, payload_hash, prev_hash, entry_hash)
         values ($1, 1, 'forged', now(), repeat('0',64), repeat('0',64), repeat('0',64))`,
        [randomUUID()],
      ),
      /permission denied/i,
    );
  });

  test('a second counterparty is rejected by UNIQUE(project_id, role)', async () => {
    const owner = randomUUID();
    const p = await svc.createProject({ actorPartyId: owner, name: 'Birch', baselineBudgetCents: 100 });
    const { token } = await svc.inviteCounterparty({ actorPartyId: owner, projectId: p.id });
    await svc.acceptInvitation({ actorPartyId: randomUUID(), token });
    // The GC already joined ⇒ inviting again is a clean 409 (no 2nd pending invite).
    await assert.rejects(svc.inviteCounterparty({ actorPartyId: owner, projectId: p.id }), (e) => e.status === 409);
  });
});
