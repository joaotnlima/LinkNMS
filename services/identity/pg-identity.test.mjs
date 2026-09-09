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
import { createPartyStore } from './parties.mjs';
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
//
// PG runs the FULL identity set, which is what gives the suite its write-guard
// teeth: identity_app reaches operating_model and status only through the
// column-scoped UPDATE granted in 0009, and still can't touch
// baseline_budget_cents / owner_party_id.
//
// This list must be EXTENDED whenever a migration is added — it stalled at 0009
// while 0010–0012 shipped, so the suite was quietly asserting against a schema
// production had already moved past, and `setup_complete` (0011) was untestable
// here. A migration missing from this list is a test that proves nothing about
// the database anyone actually runs.
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
  'services/identity/migrations/0011_identity.sql',
  'services/identity/migrations/0012_identity.sql',
  'services/identity/migrations/0013_identity.sql',
  'services/identity/migrations/0014_identity.sql',
  'services/identity/migrations/0015_identity.sql',
  'services/identity/migrations/0016_identity.sql',
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

  // ── Band B (ADR-0011) through pg-store as identity_app ─────────────────────
  test('draft → setOperatingModel → first invite commits, full lifecycle, chain verifies', async () => {
    const owner = randomUUID();

    // Step 1: draft-first create. The row lands status=draft, operating_model NULL.
    const draft = await svc.createProject({ actorPartyId: owner, name: 'Elm & Co', baselineBudgetCents: 300_000_00, draft: true });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.operatingModel, null);
    assert.equal((await ledger._chain(draft.id)).length, 1); // genesis only, nothing minted

    // Inviting a model-less draft must conflict — no silent commit, no invite.
    await assert.rejects(
      svc.inviteCounterparty({ actorPartyId: owner, projectId: draft.id, role: 'counterparty' }),
      (e) => e.status === 409,
    );

    // Step 2: the owner chooses a model (column-scoped UPDATE from 0009 + event).
    const modeled = await svc.setOperatingModel({ actorPartyId: owner, projectId: draft.id, operatingModel: 'direct' });
    assert.equal(modeled.operatingModel, 'direct');
    assert.equal(modeled.status, 'draft', 'choosing a model does not commit');

    // Step 3: the first invite flips draft→active and writes project_committed.
    // The pen's Invite screen name + scope note (LINA-222) ride the same INSERT
    // through identity_app's existing grants (0016 added columns, no new grant)
    // and round-trip back out of pg-store.
    const invited = await svc.inviteCounterparty({
      actorPartyId: owner,
      projectId: draft.id,
      role: 'subcontractor',
      inviteeName: 'Silva Electricidade, Lda.',
      scopeNote: 'Electrical rough-in and finish only.',
    });
    assert.equal(invited.invitation.role, 'subcontractor');
    assert.equal(invited.invitation.inviteeName, 'Silva Electricidade, Lda.');
    assert.equal(invited.invitation.scopeNote, 'Electrical rough-in and finish only.');

    const afterCommit = await svc.getProject({ actorPartyId: owner, projectId: draft.id });
    assert.equal(afterCommit.status, 'active');
    assert.equal(afterCommit.operatingModel, 'direct');
    assert.equal(afterCommit.members.length, 1, 'owner only so far — the invite has not been accepted');

    // The specialty sub accepts and joins as a full member with their own view.
    const sub = randomUUID();
    const { membership } = await svc.acceptInvitation({ actorPartyId: sub, token: invited.token });
    assert.equal(membership.role, 'subcontractor');
    assert.equal(membership.partyId, sub);
    const asSub = await svc.getProject({ actorPartyId: sub, projectId: draft.id });
    assert.equal(asSub.actingRole, 'subcontractor');
    assert.deepEqual(asSub.members.map((m) => m.role).sort(), ['owner', 'subcontractor']);
    // The subcontractor is read-only here — they cannot invite.
    await assert.rejects(
      svc.inviteCounterparty({ actorPartyId: sub, projectId: draft.id, role: 'subcontractor' }),
      (e) => e.status === 403,
    );

    // Every state change rode the ledger seam in the same unit as the projection
    // write, and the chain is intact end to end.
    const chain = await ledger._chain(draft.id);
    assert.deepEqual(chain.map((e) => e.type), [
      'project_created', 'operating_model_set', 'project_committed', 'member_joined']);
    assert.equal(verifyChain(chain).verified, true);
  });

  test('write-guard: identity_app updates wizard columns but can never rewrite budget/owner', async () => {
    const owner = randomUUID();
    const draft = await svc.createProject({ actorPartyId: owner, name: 'Fir', baselineBudgetCents: 50_000_00, draft: true });

    // The carve-out works: the column-scoped grant lets the row be driven by the
    // request path (an UPDATE that touches ONLY (operating_model, status)).
    const moved = await appPool.query(
      `update identity.project set status = 'active' where id = $1 returning status`,
      [draft.id],
    );
    assert.equal(moved.rows[0].status, 'active');

    // Baseline stays LOCKED at the grant layer: rewriting it means a silent budget
    // edit, which the column-scoped grant forbids outright (ADR-0002 intent) — no
    // WHERE clause can get past a missing privilege.
    await assert.rejects(
      appPool.query(`update identity.project set baseline_budget_cents = 1 where id = $1`, [draft.id]),
      /permission denied/i,
    );

    // owner_party_id is now GRANTABLE (ADR-0016: the accept path stamps the
    // homeowner onto a GC-founded build), so the lock moved from the grant to a
    // ONE-WAY, guarded write. The grant permits the UPDATE — proven by the query
    // running without a permission error — but the production path only ever runs
    // it `WHERE owner_party_id IS NULL`, so this already-owned (owner-created)
    // draft is untouched: zero rows, an existing owner is never re-pointed.
    const repoint = await appPool.query(
      `update identity.project set owner_party_id = $2
        where id = $1 and owner_party_id is null returning id`,
      [draft.id, randomUUID()],
    );
    assert.equal(repoint.rowCount, 0, 'an existing owner is never re-pointed');
  });

  // GET /me (LINA-154): resolve a party UUID to its identity.party row. The party
  // row is normally written by the Clerk bridge (app/src/server/session.ts), so we
  // seed one here exactly the way that bridge does and read it through the service.
  test('store.getParty resolves display name/email/role; unknown id is null', async () => {
    const id = randomUUID();
    await appPool.query(
      `insert into identity.party (id, display_name, email, role)
       values ($1, 'Marta', 'marta@example.com', 'owner')`,
      [id],
    );
    const party = await svc.getMe({ actorPartyId: id });
    assert.equal(party.partyId, id);
    assert.equal(party.displayName, 'Marta');
    assert.equal(party.email, 'marta@example.com');
    assert.equal(party.role, 'owner');

    // An unknown party is a 404, never a fabricated name.
    await assert.rejects(svc.getMe({ actorPartyId: randomUUID() }), (e) => e.status === 404);
  });

  // The portal root reads this flag to decide whether to send someone back to
  // account setup (LINA-189, app/src/app/page.tsx). It is asserted here because
  // the only way it can break is silently: drop `setup_complete` from
  // parties.mjs's row mapping and every party reads as "not set up", which turns
  // the portal into a permanent redirect to a screen the person already
  // finished. Nothing else in the suite would notice.
  test('the party mapping carries setup_complete across a first sign-in and setup', async () => {
    const parties = createPartyStore({ pool: appPool });
    const email = `seatless-${randomUUID()}@example.com`;

    // First authenticated request: the placeholder row. Unfinished by
    // construction — the name is guessed and the role is the default.
    const created = await parties.findOrCreateByEmail({ email, displayName: 'Ana' });
    assert.equal(created.setupComplete, false);
    assert.equal((await parties.getById(created.id)).setupComplete, false);

    // …and after the person actually completes the form.
    const store = createPgStore({ pool: appPool, ledger });
    await store.completeProfile({
      partyId: created.id, displayName: 'Ana Lima', role: 'owner', language: 'pt',
    });
    assert.equal((await parties.getById(created.id)).setupComplete, true);
  });
});
