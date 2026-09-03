// Auth — sync (JIT + webhook) + Svix tests (LINA-143; Auth Bridge §5).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMemoryAuthStore } from './store.mjs';
import { createAuthSyncService } from './sync.mjs';
import { createClerkWebhookHttp } from './webhook.mjs';
import { verifySvixSignature, signForTest } from './svix.mjs';

const svc = () => {
  const store = createMemoryAuthStore();
  const sync = createAuthSyncService({ store });
  return { store, sync };
};

describe('JIT provisioning (Auth Bridge §5 B)', () => {
  test('provisions a missing user on first auth', async () => {
    const { store, sync } = svc();
    const user = await sync.jitProvisionUser({ clerkUserId: 'usr_1', email: 'a@X.COM' });
    assert.equal(user.email, 'a@x.com');
    assert.equal((await store.getUserByClerkId('usr_1')).email, 'a@x.com');
  });

  test('is idempotent for a returning user (no duplicate row)', async () => {
    const { store, sync } = svc();
    await sync.jitProvisionUser({ clerkUserId: 'usr_1', email: 'a@x.com', displayName: 'Ana' });
    await sync.jitProvisionUser({ clerkUserId: 'usr_1', email: 'a@x.com', displayName: 'Ana Lee' });
    assert.equal((await store.getUserByClerkId('usr_1')).displayName, 'Ana Lee');
  });

  test('a disabled user is refused (403)', async () => {
    const { store, sync } = svc();
    await store.upsertUser({ clerkUserId: 'usr_z', email: 'z@x.com' });
    await store.setUserStatus('usr_z', 'disabled');
    await assert.rejects(() => sync.jitProvisionUser({ clerkUserId: 'usr_z' }), /disabled/);
  });
});

describe('webhook event handling (Auth Bridge §5 A)', () => {
  test('user.created upserts a user', async () => {
    const { store, sync } = svc();
    await sync.handleWebhookEvent({ type: 'user.created', data: { id: 'usr_w', email_addresses: [{ email_address: 'w@x.com' }] } });
    assert.equal((await store.getUserByClerkId('usr_w')).email, 'w@x.com');
  });

  test('membership.created maps Clerk role → system role and seats the user', async () => {
    const { store, sync } = svc();
    await sync.handleWebhookEvent({ type: 'organizationMembership.created', data: { public_user_data: { user_id: 'usr_m' }, organization: { id: 'org_m' }, role: 'org:member' } });
    const mem = await store.getMembership((await store.getUserByClerkId('usr_m')).id, (await store.getOrgByClerkId('org_m')).id);
    assert.equal(mem.roleKey, 'gc');
  });

  test('unknown event type is a benign no-op', async () => {
    const { sync } = svc();
    const r = await sync.handleWebhookEvent({ type: 'organizationInvitation.accepted', data: {} });
    assert.deepEqual(r, { handled: false });
  });
});

describe('webhook HTTP handler — Svix signature gate', () => {
  const SECRET = 'whsec_test_secret';
  const makeHttp = () => {
    const store = createMemoryAuthStore();
    const sync = createAuthSyncService({ store });
    return { http: createClerkWebhookHttp({ sync, secret: () => SECRET }), store };
  };

  test('rejects a forged (unsigned) delivery with 401 and NO side effect', async () => {
    const { http, store } = makeHttp();
    const rawBody = JSON.stringify({ type: 'user.created', data: { id: 'usr_forged', email_addresses: [{ email_address: 'f@x.com' }] } });
    const now = String(Math.floor(Date.now() / 1000));
    const res = await http.handle({ rawBody, headers: { 'svix-id': 'msg_fake', 'svix-timestamp': now, 'svix-signature': 'v1,AAAA' } });
    assert.equal(res.status, 401);
    assert.equal(await store.getUserByClerkId('usr_forged'), null);
  });

  test('unconfigured secret fails closed with 503', async () => {
    const store = createMemoryAuthStore();
    const sync = createAuthSyncService({ store });
    const http = createClerkWebhookHttp({ sync, secret: () => undefined });
    const res = await http.handle({ rawBody: '{}', headers: {} });
    assert.equal(res.status, 503);
  });

  test('accepts a correctly-signed user.created and upserts', async () => {
    const { http, store } = makeHttp();
    const { body, headers } = signForTest({ secret: SECRET });
    const res = await http.handle({ rawBody: body, headers });
    assert.equal(res.status, 200);
    assert.equal(res.body.handled, true);
  });
});

describe('Svix signature primitive', () => {
  test('verifySvixSignature accepts a fresh valid delivery', () => {
    const { body, headers } = signForTest({ secret: 'whsec_s' });
    assert.equal(verifySvixSignature(headers, body, 'whsec_s'), true);
  });

  test('rejects an old (replayed) timestamp outside the tolerance window', () => {
    const secret = 'whsec_s';
    const ts = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const body = JSON.stringify({ data: { id: 'usr_test' }, type: 'user.created' });
    const content = `msg_test.${ts}.${body}`;
    const mac = createHmac('sha256', secret).update(content).digest('base64');
    const headers = { 'svix-id': 'msg_test', 'svix-timestamp': String(ts), 'svix-signature': `v1,${mac}` };
    assert.equal(verifySvixSignature(headers, body, secret, { nowMs: Date.now() }), false);
  });

  test('rejects a valid MAC on the wrong secret', () => {
    const { body, headers } = signForTest({ secret: 'whsec_right' });
    assert.equal(verifySvixSignature(headers, body, 'whsec_wrong'), false);
  });
});
