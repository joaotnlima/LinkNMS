// Project store over the REAL v2 migrations (throwaway DB, like
// platform/pg-integration.test.mjs). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

import { createProjectStore } from './pg-store.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the project Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_project_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const PERSON = randomUUID();
const ACTOR = { personId: null, orgId: OWNER_ORG, orgRole: 'admin', channel: 'ui' };

describe('project store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    for (const f of ['0001_schema.sql', '0002_platform_idempotency.sql', '0003_project_claim.sql']) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_owner', 'household', 'Família Silva'),
         ($2, 'org_gc', 'contractor', 'Douro Construções')`,
      [OWNER_ORG, GC_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'ana@casa.pt', 'Ana')`,
      [PERSON],
    );
    store = createProjectStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('create → owner participation + project.created in the ledger', async () => {
    const id = randomUUID();
    const p = await store.createProject({
      id, name: 'Casa da Maia', address: null, municipalityCode: '1306',
      typology: 'T3', grossAreaM2: 180.5, indicativeBudgetCents: 25_000_000,
      ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    assert.equal(p.status, 'draft');
    assert.equal(p.version, 1);
    assert.ok(await store.isParticipant(id, OWNER_ORG));
    const { rows } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 ORDER BY seq`, [id],
    );
    assert.deepEqual(rows.map((r) => r.type), ['project.created']);
  });

  test('on-behalf create → claim: owner stamped once, email cleared, ledgered', async () => {
    const id = randomUUID();
    await store.createProject({
      id, name: 'Moradia Gaia', address: null, municipalityCode: '1304',
      typology: null, grossAreaM2: null, indicativeBudgetCents: null,
      ownerOrgId: null, pendingOwnerEmail: 'ana@casa.pt', createdByOrgId: GC_ORG, actor: { ...ACTOR, orgId: GC_ORG },
    });
    assert.equal((await store.getProject(id)).owner_org_id, null);

    const claimed = await store.claimProject({ projectId: id, ownerOrgId: OWNER_ORG, actor: ACTOR });
    assert.equal(claimed.owner_org_id, OWNER_ORG);
    assert.equal(claimed.pending_owner_email, null);
    assert.ok(await store.isParticipant(id, OWNER_ORG));
    await assert.rejects(() => store.claimProject({ projectId: id, ownerOrgId: GC_ORG, actor: ACTOR }));
  });

  test('brief update honours the expected version and bumps it', async () => {
    const id = randomUUID();
    await store.createProject({
      id, name: 'V1', address: null, municipalityCode: '1306', typology: null,
      grossAreaM2: null, indicativeBudgetCents: null,
      ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    const updated = await store.updateProjectBrief({
      projectId: id, expectedVersion: 1, patch: { name: 'V2', indicativeBudgetCents: 100 }, actor: ACTOR,
    });
    assert.equal(updated.name, 'V2');
    assert.equal(updated.version, 2);
    assert.equal(Number(updated.indicative_budget_cents), 100);
    assert.equal(await store.updateProjectBrief({ projectId: id, expectedVersion: 1, patch: { name: 'V3' }, actor: ACTOR }), null);
  });

  test('calendar daterange[] round-trips closures with inclusive bounds', async () => {
    const id = randomUUID();
    await store.createProject({
      id, name: 'Cal', address: null, municipalityCode: '1306', typology: null,
      grossAreaM2: null, indicativeBudgetCents: null,
      ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    await store.putCalendar({
      projectId: id, workDays: [1, 2, 3, 4, 5, 6],
      closures: [{ from: '2026-08-01', to: '2026-08-15' }], actor: ACTOR,
    });
    const cal = await store.getCalendar(id);
    assert.deepEqual(cal.work_days, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(cal.closures, [{ from: '2026-08-01', to: '2026-08-15' }]);
  });

  test('invitation accept flips status, writes consultant participation', async () => {
    const id = randomUUID();
    await store.createProject({
      id, name: 'Inv', address: null, municipalityCode: '1306', typology: null,
      grossAreaM2: null, indicativeBudgetCents: null,
      ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    const tokenHash = createHash('sha256').update('tok').digest('hex');
    const inv = await store.createInvitation({
      id: randomUUID(), projectId: id, invitedByOrgId: OWNER_ORG, email: 'f@i.pt',
      capacity: 'inspection', tokenHash,
      expiresAt: new Date(Date.now() + 86400000).toISOString(), actor: ACTOR,
    });
    const participant = await store.acceptInvitation({
      invitationId: inv.id, projectId: id, orgId: GC_ORG, inviteCapacity: 'inspection', actor: ACTOR,
    });
    assert.equal(participant.capacity, 'consultant');
    assert.equal(participant.invite_capacity, 'inspection');
    assert.equal((await store.getInvitationByTokenHash(tokenHash)).status, 'accepted');
    await assert.rejects(() => store.acceptInvitation({
      invitationId: inv.id, projectId: id, orgId: GC_ORG, inviteCapacity: 'inspection', actor: ACTOR,
    }));
  });

  test('locationInUse sees children; delete removes and ledgers', async () => {
    const id = randomUUID();
    await store.createProject({
      id, name: 'Loc', address: null, municipalityCode: '1306', typology: null,
      grossAreaM2: null, indicativeBudgetCents: null,
      ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    const parent = randomUUID();
    const child = randomUUID();
    await store.createLocation({ id: parent, projectId: id, parentId: null, kind: 'building', name: 'A', position: '1', actor: ACTOR });
    await store.createLocation({ id: child, projectId: id, parentId: parent, kind: 'unit', name: 'A1', position: '1', actor: ACTOR });
    assert.equal(await store.locationInUse(parent), true);
    assert.equal(await store.locationInUse(child), false);
    await store.deleteLocation({ locationId: child, projectId: id, actor: ACTOR });
    assert.equal(await store.getLocation(child), null);
  });

  test('lifecycle setStatus is compare-and-set and ledgers the action', async () => {
    const id = randomUUID();
    await store.createProject({
      id, name: 'Life', address: null, municipalityCode: '1306', typology: null,
      grossAreaM2: null, indicativeBudgetCents: null,
      ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    const cancelled = await store.setStatus({ projectId: id, from: 'draft', to: 'cancelled', action: 'cancel', actor: ACTOR });
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(() => store.setStatus({ projectId: id, from: 'draft', to: 'cancelled', action: 'cancel', actor: ACTOR }));
    const { rows } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 ORDER BY seq`, [id],
    );
    assert.deepEqual(rows.map((r) => r.type), ['project.created', 'project.cancel']);
  });
});
