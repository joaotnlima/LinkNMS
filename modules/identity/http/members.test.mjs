// Member management (PRD-12 N-9) through the /api/v2 router, DB- and
// Clerk-free: a fake store answers what pg-store would, a fake Clerk gateway
// records what would be sent. Proves the doc-16 conjunction per operation —
// permission ∧ own org ∧ entitlement (seats) ∧ human-only — the role-set rule
// (doc 16 §4), the last-admin guard, and the D-38 role spelling in Clerk.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerIdentity } from './register.mjs';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '01920000-0000-7000-8000-0000000000a2';
const ME = '01920000-0000-7000-8000-0000000000c1';
const COLLEAGUE = '01920000-0000-7000-8000-0000000000c2';
const GHOST = '01920000-0000-7000-8000-0000000000c9';

function fakeStore() {
  const org = { id: ORG, clerk_org_id: 'org_douro', kind: 'contractor', legal_name: 'Douro Lda' };
  const members = new Map([
    [ME, { id: ME, clerk_user_id: 'user_me', email: 'me@douro.pt', name: 'Me', locale: 'pt-PT', org_role: 'admin' }],
    [COLLEAGUE, { id: COLLEAGUE, clerk_user_id: 'user_col', email: 'col@douro.pt', name: 'Col', locale: 'pt-PT', org_role: 'member' }],
  ]);
  const calls = [];
  return {
    calls, members,
    async getPersonByClerkId(id) { return id === 'user_me' ? members.get(ME) : null; },
    async getOrgByClerkId(id) { return id === 'org_douro' ? org : null; },
    async getOrg(id) { return id === ORG ? org : null; },
    async getMember(orgId, personId) { return orgId === ORG ? members.get(personId) ?? null : null; },
    async countAdmins() { return [...members.values()].filter((m) => m.org_role === 'admin').length; },
    async upsertMembership(cmd) { calls.push(['upsertMembership', cmd]); return {}; },
    async removeMembership(cmd) { calls.push(['removeMembership', cmd]); return true; },
    async idempotent(_meta, fn) { return fn(); },
  };
}

const viewer = (over = {}) => createViewerContext({
  clerkUserId: 'user_me', clerkOrgId: 'org_douro', orgKind: 'contractor', orgRole: 'admin',
  permissions: ['org:members:manage'], channel: 'ui', ...over,
});

describe('member management over the v2 router (PRD-12 N-9)', () => {
  let router, store, clerk, seat;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    seat = { allowed: true, limit: 5, used: 2 };
    clerk = {
      sent: [],
      async createOrganization() { return { clerkOrgId: 'x' }; },
      async createOrganizationInvitation(args) { clerk.sent.push(['invite', args]); return { id: 'orginv_1' }; },
      async updateMembership(args) { clerk.sent.push(['update', args]); },
      async deleteMembership(args) { clerk.sent.push(['delete', args]); },
    };
    registerIdentity(router, {
      store, clerk, webhookSecret: () => 'unused',
      entitlements: { entitled: async (orgId, key) => { assert.equal(key, 'seats'); return seat; } },
    });
  });

  const call = (method, path, body, v = viewer()) => router.dispatch({ method, path, viewer: v, body, headers: {} });

  test('invite: a finer role rides on public_metadata, Clerk role is org:member (D-38)', async () => {
    const res = await call('POST', `/organizations/${ORG}/invitations`, { email: ' Ines@Douro.PT ', org_role: 'site_lead' });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { id: 'orginv_1', email: 'ines@douro.pt', org_role: 'site_lead', status: 'pending' });
    const [, args] = clerk.sent[0];
    assert.equal(args.role, 'org:member');
    assert.deepEqual(args.publicMetadata, { org_role: 'site_lead' });
    assert.equal(args.clerkOrgId, 'org_douro');
  });

  test('invite: role outside the kind\'s role set → 422; no seat → 402 with the billing hint', async () => {
    const bad = await call('POST', `/organizations/${ORG}/invitations`, { email: 'a@b.pt', org_role: 'representative' });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.org_role);
    seat = { allowed: false, limit: 2, used: 2 };
    const full = await call('POST', `/organizations/${ORG}/invitations`, { email: 'a@b.pt', org_role: 'member' });
    assert.equal(full.status, 402);
    assert.equal(full.body.upgrade_hint, '/settings/billing');
    assert.equal(clerk.sent.length, 0, 'nothing reaches Clerk on a refusal');
  });

  test('permission, own org and human-only gate every command', async () => {
    const noPerm = await call('POST', `/organizations/${ORG}/invitations`, { email: 'a@b.pt', org_role: 'member' },
      viewer({ permissions: [] }));
    assert.equal(noPerm.status, 403);
    const other = await call('PATCH', `/organizations/${OTHER_ORG}/members/${COLLEAGUE}`, { org_role: 'manager' });
    assert.equal(other.status, 403);
    const mcp = await call('DELETE', `/organizations/${ORG}/members/${COLLEAGUE}`, undefined, viewer({ channel: 'mcp' }));
    assert.equal(mcp.status, 403);
    assert.equal(mcp.body.reason, 'human_only');
  });

  test('change role: Clerk + mirror; same role is a no-op; unknown member 404', async () => {
    const res = await call('PATCH', `/organizations/${ORG}/members/${COLLEAGUE}`, { org_role: 'finance' });
    assert.equal(res.status, 200);
    assert.equal(res.body.org_role, 'finance');
    assert.deepEqual(clerk.sent[0][1], {
      clerkOrgId: 'org_douro', clerkUserId: 'user_col', role: 'org:member', publicMetadata: { org_role: 'finance' },
    });
    assert.deepEqual(store.calls[0], ['upsertMembership', { clerkOrgId: 'org_douro', clerkUserId: 'user_col', orgRole: 'finance' }]);

    const promote = await call('PATCH', `/organizations/${ORG}/members/${COLLEAGUE}`, { org_role: 'admin' });
    assert.equal(clerk.sent[1][1].role, 'org:admin');
    assert.equal(promote.body.org_role, 'admin');

    const ghost = await call('PATCH', `/organizations/${ORG}/members/${GHOST}`, { org_role: 'manager' });
    assert.equal(ghost.status, 404);
  });

  test('the last admin can be neither demoted nor removed (409)', async () => {
    const demote = await call('PATCH', `/organizations/${ORG}/members/${ME}`, { org_role: 'manager' });
    assert.equal(demote.status, 409);
    const remove = await call('DELETE', `/organizations/${ORG}/members/${ME}`);
    assert.equal(remove.status, 409);
    assert.equal(clerk.sent.length, 0);
  });

  test('remove: Clerk membership deleted, mirror removal clears staffing → 204', async () => {
    const res = await call('DELETE', `/organizations/${ORG}/members/${COLLEAGUE}`);
    assert.equal(res.status, 204);
    assert.deepEqual(clerk.sent[0], ['delete', { clerkOrgId: 'org_douro', clerkUserId: 'user_col' }]);
    assert.deepEqual(store.calls[0], ['removeMembership', { clerkOrgId: 'org_douro', clerkUserId: 'user_col' }]);
  });
});
