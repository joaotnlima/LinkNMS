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
    for (const f of ['0001_schema.sql', '0002_platform_idempotency.sql', '0003_project_claim.sql', '0020_project_build_location.sql', '0025_project_party_invite.sql', '0029_project_share_link_access.sql']) {
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

  test('the build point (PRD-03 R-3): set, kept when not patched, cleared; both or neither', async () => {
    const id = randomUUID();
    const created = await store.createProject({
      id, name: 'Encosta', address: null, municipalityCode: '1111', typology: null,
      grossAreaM2: null, indicativeBudgetCents: null, location: { lat: 38.80291, lng: -9.3817 },
      ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    assert.deepEqual([Number(created.location_lat), Number(created.location_lng)], [38.80291, -9.3817]);
    const renamed = await store.updateProjectBrief({ projectId: id, expectedVersion: 1, patch: { name: 'E2' }, actor: ACTOR });
    assert.equal(Number(renamed.location_lat), 38.80291);
    const cleared = await store.updateProjectBrief({ projectId: id, expectedVersion: 2, patch: { location: null }, actor: ACTOR });
    assert.equal(cleared.location_lat, null);
    await assert.rejects(pool.query('UPDATE project.project SET location_lat = 1 WHERE id = $1', [id]), /project_location_pair/);
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
    // LINA-398 — the unauthenticated preview joins build + inviter before accept.
    const preview = await store.getInvitationPreviewByTokenHash(tokenHash);
    assert.equal(preview.status, 'pending');
    assert.equal(preview.capacity, 'inspection');
    assert.equal(preview.project_name, 'Inv');
    assert.equal(preview.invited_by_name, 'Família Silva');
    assert.equal(await store.getInvitationPreviewByTokenHash('deadbeef'), null);

    const participant = await store.acceptInvitation({
      invitationId: inv.id, projectId: id, orgId: GC_ORG, inviteCapacity: 'inspection', actor: ACTOR,
    });
    assert.equal(participant.capacity, 'consultant');
    assert.equal(participant.invite_capacity, 'inspection');
    assert.equal((await store.getInvitationByTokenHash(tokenHash)).status, 'accepted');
    // PRD-12 N-1: the acceptance is on the outbox for the inviter's notification.
    const { rows: evts } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'project.invitation.accepted' AND project_id = $1`, [id],
    );
    assert.equal(evts.length, 1);
    assert.equal(evts[0].data.invited_by_org_id, OWNER_ORG);
    assert.equal(evts[0].data.org_id, GC_ORG);
    assert.equal(evts[0].data.invitation_id, inv.id);
    // Spent token: the preview now reads 'accepted', which the use case 404s.
    assert.equal((await store.getInvitationPreviewByTokenHash(tokenHash)).status, 'accepted');
    await assert.rejects(() => store.acceptInvitation({
      invitationId: inv.id, projectId: id, orgId: GC_ORG, inviteCapacity: 'inspection', actor: ACTOR,
    }));
  });

  test('PRD-09 O-3..O-5: a contractor invite carries name, trade and scope; the trade travels to the participation', async () => {
    const id = randomUUID();
    await store.createProject({
      id, name: 'Casa Almeida', address: null, municipalityCode: '1111', typology: null,
      grossAreaM2: null, indicativeBudgetCents: null,
      ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    const tokenHash = createHash('sha256').update('tok-gc').digest('hex');
    const inv = await store.createInvitation({
      id: randomUUID(), projectId: id, invitedByOrgId: OWNER_ORG, email: 'nuno@ferreira.pt',
      capacity: 'contractor', specialtyCode: 'electrical', inviteeName: 'Nuno Ferreira', scopeNote: 'Whole-house wiring',
      tokenHash, expiresAt: new Date(Date.now() + 86400000).toISOString(), actor: ACTOR,
    });
    const preview = await store.getInvitationPreviewByTokenHash(tokenHash);
    assert.deepEqual([preview.capacity, preview.specialty_code, preview.invitee_name, preview.scope_note],
      ['contractor', 'electrical', 'Nuno Ferreira', 'Whole-house wiring']);
    const sent = await store.listInvitationsSentBy(id, OWNER_ORG, { cursor: null, limit: 10 });
    assert.deepEqual(sent.items.map((i) => i.id), [inv.id]);
    assert.equal((await store.listInvitationsSentBy(id, GC_ORG, { cursor: null, limit: 10 })).items.length, 0);

    const participant = await store.acceptInvitation({
      invitationId: inv.id, projectId: id, orgId: GC_ORG, inviteCapacity: 'contractor', specialtyCode: 'electrical', actor: ACTOR,
    });
    assert.deepEqual([participant.capacity, participant.invite_capacity, participant.specialty_code], ['consultant', 'contractor', 'electrical']);
    await pool.query(`INSERT INTO identity.project_staffing (project_id, org_id, person_id, staffed_by) VALUES ($1, $2, $3, $3)`, [id, GC_ORG, PERSON]);
    assert.deepEqual(await store.listStaffedPeople(id, [GC_ORG]), [{ org_id: GC_ORG, person_id: PERSON, name: 'Ana' }]);
    const parts = await store.listParticipants(id, { cursor: null, limit: 10 });
    assert.equal(parts.items.find((r) => r.org_id === GC_ORG).specialty_code, 'electrical');
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

  test('share links (PRD-12 N-12): access log + ledger in one txn, frozen scope, revoke once', async () => {
    const projectId = randomUUID();
    await store.createProject({
      id: projectId, name: 'Partilha', address: null, municipalityCode: '1306', typology: null, grossAreaM2: null,
      indicativeBudgetCents: null, ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    const linkId = randomUUID();
    const tokenHash = createHash('sha256').update('t'.repeat(48)).digest('hex');
    const doc = randomUUID();
    await store.createShareLink({
      id: linkId, projectId, createdByPersonId: PERSON, audience: 'CM Maia', documentIds: [doc], taskIds: [],
      tokenHash, expiresAt: new Date(Date.now() + 86400000).toISOString(), actor: ACTOR,
    });
    const link = await store.getShareLinkByTokenHash(tokenHash);
    assert.equal(link.id, linkId);

    await store.recordShareLinkAccess({ id: randomUUID(), link, action: 'view', documentId: null, ip: '203.0.113.9', userAgent: 'UA' });
    await store.recordShareLinkAccess({ id: randomUUID(), link, action: 'download', documentId: doc, ip: null, userAgent: null });
    const withUse = await store.getShareLink(linkId);
    assert.equal(withUse.access_count, 2);
    const { items } = await store.listShareLinkAccesses({ shareLinkId: linkId, cursor: null, limit: 1 });
    assert.equal(items.length, 1);
    assert.equal(items[0].action, 'download');
    const { rows: ledger } = await pool.query(
      `SELECT type, payload, actor_person_id FROM record.audit_event WHERE project_id = $1 AND type = 'project.share_link.accessed' ORDER BY seq`,
      [projectId],
    );
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].actor_person_id, null);
    assert.equal(JSON.stringify(ledger[0].payload).includes('203.0.113.9'), false); // the address stays out of the chain

    // The access log is append-only; the scope is frozen; a link is never deleted.
    await assert.rejects(() => pool.query('UPDATE project.share_link_access SET ip = NULL'));
    await assert.rejects(() => pool.query('UPDATE project.share_link SET document_ids = $2 WHERE id = $1', [linkId, [doc, randomUUID()]]));
    await assert.rejects(() => pool.query('DELETE FROM project.share_link WHERE id = $1', [linkId]));

    const revoked = await store.revokeShareLink({ shareLinkId: linkId, projectId, actor: { ...ACTOR, personId: PERSON } });
    assert.ok(revoked.revoked_at);
    assert.equal(revoked.revoked_by_person_id, PERSON);
    assert.equal(await store.revokeShareLink({ shareLinkId: linkId, projectId, actor: ACTOR }), null);
    await assert.rejects(() => pool.query('UPDATE project.share_link SET revoked_at = now() WHERE id = $1', [linkId]));
    const list = await store.listShareLinks({ projectId, cursor: null, limit: 10 });
    assert.equal(list.items.length, 1);
  });

  test('build port facts (PRD-12 N-3/N-4): known locations of the build only', async () => {
    const projectId = randomUUID();
    await store.createProject({
      id: projectId, name: 'Locais', address: null, municipalityCode: '1306', typology: null, grossAreaM2: null,
      indicativeBudgetCents: null, ownerOrgId: OWNER_ORG, pendingOwnerEmail: null, createdByOrgId: OWNER_ORG, actor: ACTOR,
    });
    const loc = randomUUID();
    await store.createLocation({ id: loc, projectId, parentId: null, kind: 'zone', name: 'Cozinha', position: 'a0', actor: ACTOR });
    const known = await store.knownLocationIds(projectId, [loc, randomUUID()]);
    assert.deepEqual([...known], [loc]);
  });
});
