// Identity operations end to end through the /api/v2 router, DB-free: the
// fake store answers what pg-store would. Proves the doc-16 request flow —
// permission (token) → relationship (participation) → staffing — and the
// svix-authenticated webhook, per operation.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerIdentity } from './register.mjs';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const ME = '01920000-0000-7000-8000-0000000000c1';
const COLLEAGUE = '01920000-0000-7000-8000-0000000000c2';

const SECRET_RAW = Buffer.from('a-32-byte-webhook-signing-seed!!');
const SECRET = `whsec_${SECRET_RAW.toString('base64')}`;

function fakeStore() {
  const people = new Map([['user_me', { id: ME, clerk_user_id: 'user_me', email: 'me@douro.pt', name: 'Me', phone: null, locale: 'pt-PT' }]]);
  const orgs = new Map([['org_douro', { id: ORG, clerk_org_id: 'org_douro', kind: 'contractor', legal_name: 'Douro Lda', nif: null, approval_policy: 'any', created_at: 1 }]]);
  const memberships = new Map([[`${ORG}:${ME}`, 'admin'], [`${ORG}:${COLLEAGUE}`, 'member']]);
  const staffing = new Set();
  const participants = new Set([`${PROJECT}:${ORG}`]);
  const calls = [];

  return {
    calls, staffing, people, orgs,
    async getPersonByClerkId(id) { return people.get(id) ?? null; },
    async getOrgByClerkId(id) { return orgs.get(id) ?? null; },
    async listOrgsForPerson() { return [{ org: orgs.get('org_douro'), org_role: 'admin' }]; },
    async listMembers(orgId, { limit }) {
      const items = [...memberships.entries()].filter(([k]) => k.startsWith(orgId))
        .map(([k, role]) => ({ id: k.split(':')[1], email: 'x@x.pt', name: 'X', phone: null, locale: 'pt-PT', org_role: role }));
      return { items: items.slice(0, limit), nextCursor: null };
    },
    async getActiveMembership(orgId, personId) {
      const role = memberships.get(`${orgId}:${personId}`);
      return role ? { org_role: role } : null;
    },
    async isProjectParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async orgHasSignedContracts() { return false; },
    async mirrorReady() { return true; },
    async upsertPerson(cmd) { calls.push(['upsertPerson', cmd]); return { id: 'new' }; },
    async upsertOrganization(cmd) { calls.push(['upsertOrganization', cmd]); return { id: 'org-new', kind: cmd.orgKind, legal_name: cmd.legalName, nif: cmd.nif, approval_policy: cmd.approvalPolicy }; },
    async upsertMembership(cmd) { calls.push(['upsertMembership', cmd]); return {}; },
    async removeMembership(cmd) { calls.push(['removeMembership', cmd]); return true; },
    async staff(cmd) { staffing.add(`${cmd.projectId}:${cmd.personId}`); calls.push(['staff', cmd]); return { project_id: cmd.projectId, org_id: cmd.orgId, person_id: cmd.personId }; },
    async unstaff(cmd) { calls.push(['unstaff', cmd]); return staffing.delete(`${cmd.projectId}:${cmd.personId}`); },
    async idempotent(_meta, fn) { return fn(); },
  };
}

const viewer = (over = {}) => createViewerContext({
  clerkUserId: 'user_me', clerkOrgId: 'org_douro', orgKind: 'contractor', orgRole: 'admin',
  permissions: ['org:projects:staff', 'org:members:manage'], ...over,
});

describe('identity over the v2 router', () => {
  let router, store, clerkCalls;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    clerkCalls = [];
    registerIdentity(router, {
      store,
      clerk: { createOrganization: async (args) => { clerkCalls.push(args); return { clerkOrgId: 'org_new' }; } },
      webhookSecret: () => SECRET,
    });
  });

  test('GET /me answers person, active org and token permissions', async () => {
    const res = await router.dispatch({ method: 'GET', path: '/me', viewer: viewer() });
    assert.equal(res.status, 200);
    assert.equal(res.body.person.email, 'me@douro.pt');
    assert.equal(res.body.active_org.legal_name, 'Douro Lda');
    assert.equal(res.body.org_role, 'admin');
    assert.deepEqual(res.body.permissions, ['org:members:manage', 'org:projects:staff']);
    assert.deepEqual(res.body.pending_project_invitations, []);
  });

  test('GET /me before the mirror caught up → 404 problem, retryable', async () => {
    const res = await router.dispatch({ method: 'GET', path: '/me', viewer: viewer({ clerkUserId: 'user_unknown' }) });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'not_found');
  });

  test('POST /organizations creates in Clerk with kind metadata, mirrors, 201', async () => {
    const res = await router.dispatch({
      method: 'POST', path: '/organizations', viewer: viewer(),
      body: { kind: 'consultant', legal_name: 'Atelier Norte' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'consultant');
    assert.equal(clerkCalls[0].publicMetadata.kind, 'consultant');
    assert.deepEqual(store.calls.map(([n]) => n), ['upsertOrganization', 'upsertMembership']);
  });

  test('POST /organizations validates kind (supplier not yet) and legal_name', async () => {
    const res = await router.dispatch({
      method: 'POST', path: '/organizations', viewer: viewer(),
      body: { kind: 'supplier', legal_name: '' },
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.errors.kind && res.body.errors.legal_name);
    assert.equal(clerkCalls.length, 0, 'nothing reaches Clerk on a 422');
  });

  test('listMembers needs org:members:manage AND your own org', async () => {
    const ok = await router.dispatch({ method: 'GET', path: `/organizations/${ORG}/members`, viewer: viewer() });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.items.length, 2);

    const noPerm = await router.dispatch({
      method: 'GET', path: `/organizations/${ORG}/members`,
      viewer: viewer({ orgRole: 'manager', permissions: [] }),
    });
    assert.equal(noPerm.status, 403);

    const otherOrg = await router.dispatch({
      method: 'GET', path: `/organizations/${'01920000-0000-7000-8000-0000000000ff'}/members`, viewer: viewer(),
    });
    assert.equal(otherOrg.status, 403);
  });

  test('staffing: permission → membership → participation, then the write', async () => {
    const ok = await router.dispatch({ method: 'PUT', path: `/projects/${PROJECT}/staffing/${COLLEAGUE}`, viewer: viewer() });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { project_id: PROJECT, org_id: ORG, person_id: COLLEAGUE });
    const staffCall = store.calls.find(([n]) => n === 'staff')[1];
    assert.equal(staffCall.staffedBy, ME, 'staffed_by is the acting person, resolved from the mirror');
    assert.deepEqual(staffCall.actor, { personId: ME, orgId: ORG, orgRole: 'admin' });

    const noPerm = await router.dispatch({
      method: 'PUT', path: `/projects/${PROJECT}/staffing/${COLLEAGUE}`,
      viewer: viewer({ orgRole: 'site_lead', permissions: ['org:plan:edit'] }),
    });
    assert.equal(noPerm.status, 403);
    assert.equal(noPerm.body.reason, 'role');

    const stranger = await router.dispatch({ method: 'PUT', path: `/projects/${PROJECT}/staffing/01920000-0000-7000-8000-0000000000c9`, viewer: viewer() });
    assert.equal(stranger.status, 404, 'not one of your people');

    const otherProject = await router.dispatch({ method: 'PUT', path: `/projects/01920000-0000-7000-8000-0000000000b2/staffing/${COLLEAGUE}`, viewer: viewer() });
    assert.equal(otherProject.status, 403);
    assert.equal(otherProject.body.code, 'not_a_participant');
  });

  test('DELETE staffing: 204 when staffed, 404 when not', async () => {
    await router.dispatch({ method: 'PUT', path: `/projects/${PROJECT}/staffing/${COLLEAGUE}`, viewer: viewer() });
    const gone = await router.dispatch({ method: 'DELETE', path: `/projects/${PROJECT}/staffing/${COLLEAGUE}`, viewer: viewer() });
    assert.equal(gone.status, 204);
    const again = await router.dispatch({ method: 'DELETE', path: `/projects/${PROJECT}/staffing/${COLLEAGUE}`, viewer: viewer() });
    assert.equal(again.status, 404);
  });

  test('webhook: a signed user.created mirrors the person; a bad signature is 401', async () => {
    const body = JSON.stringify({
      type: 'user.created',
      data: { id: 'user_new', primary_email_address_id: 'em', email_addresses: [{ id: 'em', email_address: 'New@Casa.PT' }], first_name: 'Nova', last_name: 'Silva' },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', SECRET_RAW).update(`msg_1.${ts}.${body}`).digest('base64');
    const ok = await router.dispatch({
      method: 'POST', path: '/webhooks/clerk', rawBody: body, body: JSON.parse(body),
      headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
    });
    assert.equal(ok.status, 204);
    assert.deepEqual(store.calls.at(-1)[1].email, 'new@casa.pt');

    const forged = await router.dispatch({
      method: 'POST', path: '/webhooks/clerk', rawBody: body,
      headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': 'v1,AAAA' },
    });
    assert.equal(forged.status, 401);
  });
});
