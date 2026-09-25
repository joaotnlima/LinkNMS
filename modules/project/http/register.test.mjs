// Project operations end to end through the /api/v2 router, DB-free: the
// fake store answers what pg-store would. Proves the doc-16 request flow —
// permission (token) → relationship (owner / participant / prime supplier /
// draft-creator) → staffing — plus the doc-09 lifecycle guards, per operation.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerProject } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a3';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const DRAFT_UNCLAIMED = '01920000-0000-7000-8000-0000000000b2';
const ME = '01920000-0000-7000-8000-0000000000c1';
const LOC_USED = '01920000-0000-7000-8000-0000000000d1';
const LOC_FREE = '01920000-0000-7000-8000-0000000000d2';
const NEW_ID = '01920000-0000-7000-8000-0000000000e1';

function baseProject(over = {}) {
  return {
    id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG,
    name: 'Casa da Maia', address: null, municipality_code: '1306',
    typology: null, gross_area_m2: null, indicative_budget_cents: 25_000_000,
    status: 'draft', version: 1, pending_owner_email: null, ...over,
  };
}

function fakeStore() {
  const projects = new Map([
    [PROJECT, baseProject()],
    [DRAFT_UNCLAIMED, baseProject({
      id: DRAFT_UNCLAIMED, owner_org_id: null, created_by_org_id: GC_ORG,
      pending_owner_email: 'ana@casa.pt',
    })],
  ]);
  const participants = new Set([`${PROJECT}:${OWNER_ORG}`, `${PROJECT}:${GC_ORG}`]);
  const staffed = new Set();
  const locations = new Map([
    [LOC_USED, { id: LOC_USED, project_id: PROJECT, parent_id: null, kind: 'building', name: 'Main', position: '1' }],
    [LOC_FREE, { id: LOC_FREE, project_id: PROJECT, parent_id: null, kind: 'zone', name: 'Garden', position: '2' }],
  ]);
  const invitations = new Map();
  const ledger = [];
  const state = {
    signedContracts: false, openOwnerContracts: 0, primeSupplier: new Set(),
    calendar: null, shareLinks: [], person: { id: ME, clerk_user_id: 'user_me', email: 'ana@casa.pt' },
  };

  return {
    projects, participants, staffed, locations, invitations, ledger, state,
    async getPersonByClerkId(id) { return id === 'user_me' ? state.person : null; },
    async getProject(id) { return projects.get(id) ?? null; },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed(projectId, orgId, personId) { return staffed.has(`${projectId}:${orgId}:${personId}`); },
    async isPrimeSupplier(projectId, orgId) { return state.primeSupplier.has(`${projectId}:${orgId}`); },
    async hasSignedContracts() { return state.signedContracts; },
    async countOpenOwnerContracts() { return state.openOwnerContracts; },
    async getOperatingModel() { return 'undetermined'; },
    async listProjectsForOrg({ orgId, personId }) {
      const items = [...projects.values()].filter((p) =>
        (participants.has(`${p.id}:${orgId}`) || p.owner_org_id === orgId || p.created_by_org_id === orgId)
        && (personId === null || staffed.has(`${p.id}:${orgId}:${personId}`)))
        .map((p) => ({ ...p, operating_model: 'undetermined' }));
      return { items, nextCursor: null };
    },
    async getLocation(id) { return locations.get(id) ?? null; },
    async listLocations(projectId) {
      return { items: [...locations.values()].filter((l) => l.project_id === projectId), nextCursor: null };
    },
    async locationInUse(id) { return id === LOC_USED; },
    async listParticipants(projectId) {
      return {
        items: [...participants].filter((k) => k.startsWith(projectId)).map((k) => ({
          project_id: projectId, org_id: k.split(':')[1], capacity: 'owner', source: 'project',
          contract_id: null, invite_capacity: null, org_kind: 'household', legal_name: 'Org', nif: null,
        })),
        nextCursor: null,
      };
    },
    async getInvitationByTokenHash(hash) {
      return [...invitations.values()].find((i) => i.token_hash === hash) ?? null;
    },
    async getCalendar() { return state.calendar; },
    async listHolidays() { return [{ date: '2026-12-08', name: 'Imaculada Conceição' }]; },

    async createProject(cmd) {
      const row = baseProject({
        id: cmd.id, owner_org_id: cmd.ownerOrgId, created_by_org_id: cmd.createdByOrgId,
        name: cmd.name, municipality_code: cmd.municipalityCode,
        indicative_budget_cents: cmd.indicativeBudgetCents, pending_owner_email: cmd.pendingOwnerEmail,
      });
      projects.set(cmd.id, row);
      if (cmd.ownerOrgId) participants.add(`${cmd.id}:${cmd.ownerOrgId}`);
      ledger.push('project.created');
      return row;
    },
    async updateProjectBrief({ projectId, expectedVersion, patch }) {
      const p = projects.get(projectId);
      if (p.version !== expectedVersion) return null;
      const next = { ...p, name: patch.name ?? p.name, version: p.version + 1 };
      projects.set(projectId, next);
      ledger.push('project.brief.updated');
      return next;
    },
    async claimProject({ projectId, ownerOrgId }) {
      const next = { ...projects.get(projectId), owner_org_id: ownerOrgId, pending_owner_email: null };
      projects.set(projectId, next);
      participants.add(`${projectId}:${ownerOrgId}`);
      ledger.push('project.claimed');
      return next;
    },
    async setStatus({ projectId, to, action }) {
      const next = { ...projects.get(projectId), status: to };
      projects.set(projectId, next);
      ledger.push(`project.${action}`);
      return next;
    },
    async createLocation(cmd) {
      const row = { id: cmd.id, project_id: cmd.projectId, parent_id: cmd.parentId, kind: cmd.kind, name: cmd.name, position: cmd.position };
      locations.set(cmd.id, row);
      ledger.push('project.location.added');
      return row;
    },
    async updateLocation({ locationId, patch }) {
      const next = { ...locations.get(locationId), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      locations.set(locationId, next);
      ledger.push('project.location.updated');
      return next;
    },
    async deleteLocation({ locationId }) { locations.delete(locationId); ledger.push('project.location.removed'); },
    async createInvitation(cmd) {
      const row = {
        id: cmd.id, project_id: cmd.projectId, email: cmd.email, capacity: cmd.capacity,
        status: 'pending', token_hash: cmd.tokenHash, expires_at: cmd.expiresAt,
      };
      invitations.set(cmd.id, row);
      ledger.push('project.invitation.sent');
      return row;
    },
    async acceptInvitation({ invitationId, projectId, orgId, inviteCapacity }) {
      invitations.get(invitationId).status = 'accepted';
      participants.add(`${projectId}:${orgId}`);
      ledger.push('project.invitation.accepted');
      return {
        project_id: projectId, org_id: orgId, capacity: 'consultant', source: 'invitation',
        contract_id: null, invite_capacity: inviteCapacity, org_kind: 'consultant', legal_name: 'Fisc Lda', nif: null,
      };
    },
    async putCalendar({ workDays, closures }) {
      state.calendar = { work_days: workDays, closures };
      ledger.push('project.calendar.updated');
      return state.calendar;
    },
    async createShareLink(cmd) {
      state.shareLinks.push(cmd);
      ledger.push('project.share_link.created');
      return { ...cmd, document_ids: cmd.documentIds, task_ids: cmd.taskIds, expires_at: cmd.expiresAt };
    },
    async idempotent(_meta, fn) { return fn(); },
  };
}

const owner = (over = {}) => createViewerContext({
  clerkUserId: 'user_me', orgId: OWNER_ORG, clerkOrgId: 'org_owner', orgKind: 'household', orgRole: 'admin',
  permissions: ['org:projects:create', 'org:plan:edit', 'org:projects:staff'], ...over,
});
const gc = (over = {}) => owner({ orgId: GC_ORG, clerkOrgId: 'org_gc', orgKind: 'contractor', ...over });
const stranger = () => owner({ orgId: STRANGER_ORG, clerkOrgId: 'org_x' });

describe('project over the v2 router', () => {
  let router, store;
  const call = (method, path, { viewer = owner(), body = null, headers = {}, query = {} } = {}) =>
    router.dispatch({ method, path, viewer, body, headers, query });

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerProject(router, { store, shareBaseUrl: () => 'https://portal.linknms.com' });
  });

  describe('createProject', () => {
    test('201 as owner: participation + ledger, status draft', async () => {
      const res = await call('POST', '/projects', { body: { id: NEW_ID, name: 'Moradia', municipality_code: '1306' } });
      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'draft');
      assert.equal(res.body.owner_org_id, OWNER_ORG);
      assert.ok(store.participants.has(`${NEW_ID}:${OWNER_ORG}`));
      assert.deepEqual(store.ledger, ['project.created']);
    });

    test('on_behalf_of_owner_email → unowned draft holding the pending email', async () => {
      const res = await call('POST', '/projects', {
        viewer: gc(),
        body: { id: NEW_ID, name: 'Moradia', municipality_code: '1306', on_behalf_of_owner_email: 'Ana@Casa.PT' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.owner_org_id, undefined);
      assert.equal(store.projects.get(NEW_ID).pending_owner_email, 'ana@casa.pt');
    });

    test('403 without org:projects:create; 422 without a name', async () => {
      assert.equal((await call('POST', '/projects', { viewer: owner({ permissions: [] }), body: { id: NEW_ID, name: 'X', municipality_code: '1' } })).status, 403);
      const res = await call('POST', '/projects', { body: { id: NEW_ID, municipality_code: '1306' } });
      assert.equal(res.status, 422);
      assert.ok(res.body.errors.name);
    });
  });

  describe('listProjects — staffing gate (doc 16 §4)', () => {
    test('admin sees the org portfolio; an unstaffed member sees nothing', async () => {
      assert.equal((await call('GET', '/projects')).body.items.length, 1);
      const member = owner({ orgRole: 'member' });
      assert.equal((await call('GET', '/projects', { viewer: member })).body.items.length, 0);
      store.staffed.add(`${PROJECT}:${OWNER_ORG}:${ME}`);
      assert.equal((await call('GET', '/projects', { viewer: member })).body.items.length, 1);
    });
  });

  describe('getProject / relationship', () => {
    test('participant reads it; a stranger gets 404, not 403', async () => {
      assert.equal((await call('GET', `/projects/${PROJECT}`)).status, 200);
      assert.equal((await call('GET', `/projects/${PROJECT}`, { viewer: stranger() })).status, 404);
    });

    test('an unstaffed non-manager participant is refused with not_a_participant', async () => {
      const res = await call('GET', `/projects/${PROJECT}`, { viewer: owner({ orgRole: 'site_lead' }) });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'not_a_participant');
    });
  });

  describe('updateProject — If-Match optimistic concurrency', () => {
    test('right version updates and bumps; wrong version 409; missing 422', async () => {
      const ok = await call('PATCH', `/projects/${PROJECT}`, { body: { name: 'Casa Nova' }, headers: { 'if-match': '1' } });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.version, 2);
      assert.equal((await call('PATCH', `/projects/${PROJECT}`, { body: { name: 'X' }, headers: { 'if-match': '1' } })).status, 409);
      assert.equal((await call('PATCH', `/projects/${PROJECT}`, { body: { name: 'X' } })).status, 422);
    });

    test('the creating GC drives an unclaimed draft; a mere participant does not drive a claimed one', async () => {
      assert.equal((await call('PATCH', `/projects/${DRAFT_UNCLAIMED}`, { viewer: gc(), body: { name: 'Y' }, headers: { 'if-match': '1' } })).status, 200);
      assert.equal((await call('PATCH', `/projects/${PROJECT}`, { viewer: gc(), body: { name: 'Y' }, headers: { 'if-match': '2' } })).status, 403);
    });
  });

  describe('claimProject (doc 14 Q4)', () => {
    test('the invited email claims with its active org; participation appears', async () => {
      const res = await call('POST', `/projects/${DRAFT_UNCLAIMED}:claim`);
      assert.equal(res.status, 200);
      assert.equal(res.body.owner_org_id, OWNER_ORG);
      assert.ok(store.participants.has(`${DRAFT_UNCLAIMED}:${OWNER_ORG}`));
      assert.ok(store.ledger.includes('project.claimed'));
    });

    test('wrong email → 404 (existence not leaked); already owned → 409', async () => {
      store.state.person = { ...store.state.person, email: 'other@x.pt' };
      assert.equal((await call('POST', `/projects/${DRAFT_UNCLAIMED}:claim`)).status, 404);
      store.state.person = { ...store.state.person, email: 'ana@casa.pt' };
      assert.equal((await call('POST', `/projects/${PROJECT}:claim`)).status, 409);
    });
  });

  describe('lifecycle guards (doc 09)', () => {
    test('cancel: fine on a virgin draft, refused once a contract is signed', async () => {
      assert.equal((await call('POST', `/projects/${PROJECT}:cancel`)).status, 200);
      store.projects.set(PROJECT, baseProject({ status: 'tendering' }));
      store.state.signedContracts = true;
      const res = await call('POST', `/projects/${PROJECT}:cancel`);
      assert.equal(res.status, 409);
      assert.match(res.body.detail, /noSignedContract/);
    });

    test('close: only from in_execution and only with owner contracts settled', async () => {
      assert.equal((await call('POST', `/projects/${PROJECT}:close`)).status, 409);
      store.projects.set(PROJECT, baseProject({ status: 'in_execution' }));
      store.state.openOwnerContracts = 1;
      assert.equal((await call('POST', `/projects/${PROJECT}:close`)).status, 409);
      store.state.openOwnerContracts = 0;
      const res = await call('POST', `/projects/${PROJECT}:close`);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'closed');
    });

    test('overview answers zeroed roll-ups until planning lands', async () => {
      const res = await call('GET', `/projects/${PROJECT}/overview`);
      assert.equal(res.status, 200);
      assert.deepEqual(
        [res.body.open_variations, res.body.open_questions, res.body.pending_verifications],
        [0, 0, 0],
      );
    });
  });

  describe('locations', () => {
    test('create 201; a parent from another project is refused', async () => {
      const ok = await call('POST', `/projects/${PROJECT}/locations`, { body: { id: NEW_ID, kind: 'unit', name: 'T3', parent_id: LOC_USED } });
      assert.equal(ok.status, 201);
      const bad = await call('PATCH', `/projects/${DRAFT_UNCLAIMED}`, {}); // guard: route intact
      assert.notEqual(bad.status, 500);
      const cross = await call('POST', `/projects/${DRAFT_UNCLAIMED}/locations`, { viewer: gc(), body: { id: NEW_ID, kind: 'unit', name: 'T3', parent_id: LOC_USED } });
      assert.equal(cross.status, 422);
    });

    test('delete: in-use 409, free 204', async () => {
      assert.equal((await call('DELETE', `/locations/${LOC_USED}`)).status, 409);
      assert.equal((await call('DELETE', `/locations/${LOC_FREE}`)).status, 204);
      assert.ok(!store.locations.has(LOC_FREE));
    });
  });

  describe('invitations', () => {
    test('owner invites: 201 returns the one-time token, only its hash is stored', async () => {
      const res = await call('POST', `/projects/${PROJECT}/invitations`, { body: { email: 'fiscal@insp.pt', capacity: 'inspection' } });
      assert.equal(res.status, 201);
      assert.match(res.body.token, /^[0-9a-f]{48}$/);
      const stored = [...store.invitations.values()][0];
      assert.notEqual(stored.token_hash, res.body.token);
      assert.equal(stored.token_hash.length, 64);
    });

    test('prime supplier may invite; another participant may not; bad capacity 422', async () => {
      store.state.primeSupplier.add(`${PROJECT}:${GC_ORG}`);
      assert.equal((await call('POST', `/projects/${PROJECT}/invitations`, { viewer: gc(), body: { email: 'x@y.pt', capacity: 'safety' } })).status, 201);
      store.state.primeSupplier.clear();
      assert.equal((await call('POST', `/projects/${PROJECT}/invitations`, { viewer: gc(), body: { email: 'x@y.pt', capacity: 'safety' } })).status, 403);
      assert.equal((await call('POST', `/projects/${PROJECT}/invitations`, { body: { email: 'x@y.pt', capacity: 'owner' } })).status, 422);
    });

    test('accept: pending → participant; expired → 410; unknown token → 404', async () => {
      const sent = await call('POST', `/projects/${PROJECT}/invitations`, { body: { email: 'f@i.pt', capacity: 'inspection' } });
      const accepted = await call('POST', `/project-invitations/${sent.body.token}:accept`, { viewer: stranger() });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.capacity, 'consultant');
      assert.equal(accepted.body.invite_capacity, 'inspection');

      const sent2 = await call('POST', `/projects/${PROJECT}/invitations`, { body: { email: 'g@i.pt', capacity: 'other' } });
      [...store.invitations.values()].at(-1).expires_at = new Date(Date.now() - 1000).toISOString();
      assert.equal((await call('POST', `/project-invitations/${sent2.body.token}:accept`, { viewer: stranger() })).status, 410);
      assert.equal((await call('POST', '/project-invitations/deadbeef:accept', { viewer: stranger() })).status, 404);
    });
  });

  describe('calendar', () => {
    test('GET answers defaults + holidays before any PUT', async () => {
      const res = await call('GET', `/projects/${PROJECT}/calendar`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.work_days, [1, 2, 3, 4, 5]);
      assert.equal(res.body.holidays[0].date, '2026-12-08');
    });

    test('PUT validates weekdays and closure ranges; only owner or prime edits', async () => {
      assert.equal((await call('PUT', `/projects/${PROJECT}/calendar`, { body: { work_days: [0, 8] } })).status, 422);
      assert.equal((await call('PUT', `/projects/${PROJECT}/calendar`, { viewer: gc(), body: { work_days: [1, 2] } })).status, 403);
      const ok = await call('PUT', `/projects/${PROJECT}/calendar`, {
        body: { work_days: [1, 2, 3, 4, 5, 6], closures: [{ from: '2026-08-01', to: '2026-08-15' }] },
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body.work_days, [1, 2, 3, 4, 5, 6]);
      assert.ok(store.ledger.includes('project.calendar.updated'));
    });
  });

  describe('share links', () => {
    test('201: url carries the token once, the store only its hash; owner-only', async () => {
      const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const res = await call('POST', `/projects/${PROJECT}/share-links`, {
        body: { audience: 'Câmara Municipal da Maia', expires_at: expires },
      });
      assert.equal(res.status, 201);
      const token = res.body.url.split('/share/')[1];
      assert.match(token, /^[0-9a-f]{48}$/);
      assert.notEqual(store.state.shareLinks[0].tokenHash, token);
      assert.equal((await call('POST', `/projects/${PROJECT}/share-links`, { viewer: gc(), body: { audience: 'CM', expires_at: expires } })).status, 403);
    });

    test('past or >90d expiry refused', async () => {
      assert.equal((await call('POST', `/projects/${PROJECT}/share-links`, { body: { audience: 'CM', expires_at: '2020-01-01T00:00:00Z' } })).status, 422);
      const far = new Date(Date.now() + 120 * 24 * 3600 * 1000).toISOString();
      assert.equal((await call('POST', `/projects/${PROJECT}/share-links`, { body: { audience: 'CM', expires_at: far } })).status, 422);
    });
  });
});
