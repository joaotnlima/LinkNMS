// Auth — requireAuth / authorize request path tests (LINA-143; Auth Bridge §3).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAuthStore } from './store.mjs';
import { createAuthSyncService } from './sync.mjs';
import { createAuthRequestPath } from './require-auth.mjs';
import { can, PERMISSION } from './can.mjs';

async function setup() {
  const store = createMemoryAuthStore();
  const sync = createAuthSyncService({ store });
  // mirror the active org locally so the actor's activeOrgId resolves to a
  // LOCAL authz.orgs.id (the token carries the CLERK org id)
  await store.upsertOrg({ clerkOrgId: 'org_active', name: 'Active Org' });
  // a verify that returns the same fake clerk id for any token
  const verifyToken = async (token) => {
    if (!token) return null;
    return { sub: token, activeOrgId: 'org_active' };
  };
  const path = createAuthRequestPath({ store, sync, verifyToken, can });
  return { store, sync, path };
}

describe('requireAuth — JWT verification + JIT provisioning', () => {
  test('missing token → 401', async () => {
    const { path } = await setup();
    await assert.rejects(() => path.requireAuth(''), /authentication required/);
    await assert.rejects(() => path.requireAuth(undefined), /authentication required/);
  });

  test('mints a local actor and JIT-provisions on first call', async () => {
    const { store, path } = await setup();
    const actor = await path.requireAuth('usr_ana');
    assert.equal(actor.clerkUserId, 'usr_ana');
    assert.ok(actor.userId);
    // JIT row was created
    assert.ok(await store.getUserByClerkId('usr_ana'));
  });

  test('invalid token (verifyToken throws) → 401, no actor, no row', async () => {
    const store = createMemoryAuthStore();
    const sync = createAuthSyncService({ store });
    const path = createAuthRequestPath({ store, sync, verifyToken: async () => { throw new Error('bad'); }, can });
    await assert.rejects(() => path.requireAuth('usr_x'), /authentication required/);
    assert.equal(await store.getUserByClerkId('usr_x'), null);
  });
});

describe('authorize — runs can() over resolved authz catalog', () => {
  test('member with the verb is allowed; non-member is denied 403', async () => {
    const { store, path } = await setup();
    const actor = await path.requireAuth('usr_gc');
    // seat gc in the active org with the gc role
    await store.setMembership({ clerkUserId: 'usr_gc', clerkOrgId: 'org_active', roleKey: 'gc' });

    const allowed = await path.authorize(actor, PERMISSION.SCHEDULE_UPDATE, { type: 'schedule', id: 's1' });
    assert.equal(allowed.action, PERMISSION.SCHEDULE_UPDATE);

    await assert.rejects(
      () => path.authorize(actor, PERMISSION.PROJECT_DELETE, { type: 'project', id: 'p1' }),
      (e) => e.status === 403,
    );
  });

  test("ADVERSARIAL: authorize cannot let a CO proposer decide their own CO", async () => {
    const { store, path } = await setup();
    const actor = await path.requireAuth('usr_owner');
    await store.setMembership({ clerkUserId: 'usr_owner', clerkOrgId: 'org_active', roleKey: 'owner' });

    await assert.rejects(
      () => path.authorize(actor, PERMISSION.CHANGE_ORDER_DECIDE, { type: 'change_order', id: 'co-9', proposedBy: actor.userId }),
      (e) => e.status === 403,
    );

    // same role, a DIFFERENT proposer → allowed
    const ok = await path.authorize(actor, PERMISSION.CHANGE_ORDER_DECIDE, { type: 'change_order', id: 'co-10', proposedBy: 'someone-else' });
    assert.equal(ok.action, PERMISSION.CHANGE_ORDER_DECIDE);
  });

  test('no active org on the token → scoped verbs are denied (closed)', async () => {
    const store = createMemoryAuthStore();
    const sync = createAuthSyncService({ store });
    const path = createAuthRequestPath({ store, sync, verifyToken: async () => ({ sub: 'usr_none', activeOrgId: null }), can });
    const actor = await path.requireAuth('usr_none');
    await store.setMembership({ clerkUserId: 'usr_none', clerkOrgId: 'org_active', roleKey: 'owner' });
    await assert.rejects(() => path.authorize(actor, PERMISSION.BUDGET_READ, { type: 'budget', id: 'b1' }), (e) => e.status === 403);
  });
});
