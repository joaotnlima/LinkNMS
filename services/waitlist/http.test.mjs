// HTTP handler tests for the Waitlist route (LINA-127; ADR-0004).
//
// These pin the POST /api/waitlist contract the frontend form consumes: a valid
// email is stored `waitlisted` with a DB-assigned signup_order and a 201 (with a
// degraded, non-fatal welcome-email send); a duplicate is a 409 `duplicate`
// without creating a second row; an invalid or disposable email is a 400; the
// response never leaks whether a prior signup exists. Run:
//   node --test services/waitlist/http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaitlistService } from './waitlist.mjs';
import { createWaitlistHttp } from './http.mjs';
import { createInMemoryStore, createInMemoryEmail } from './ports.mjs';

function makeHttp({ emailDeliver = true } = {}) {
  const store = createInMemoryStore();
  const email = createInMemoryEmail({ deliver: emailDeliver });
  const service = createWaitlistService({ store, email });
  const http = createWaitlistHttp({ service });
  return { http, store, email };
}

test('subscribe stores a valid email as waitlisted with a signup_order and returns 201', async () => {
  const { http, store } = makeHttp();
  const res = await http.subscribe({ session: null, body: { email: 'João@Example.COM ' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'waitlisted');
  assert.equal(res.body.email, 'João@Example.COM '.trim());
  assert.equal(typeof res.body.signupOrder, 'number');
  assert.equal(res.body.signupOrder, 1);
  assert.equal(store._rows.size, 1);
  // The stored dedupe key is the normalized email.
  assert.equal([...store._rows.keys()][0], 'joão@example.com');
});

test('two identical emails → second is a 409 duplicate, no second row', async () => {
  const { http, store } = makeHttp();
  const a = await http.subscribe({ body: { email: 'a@example.com' } });
  const b = await http.subscribe({ body: { email: 'A@example.com ' } }); // case/space-insensitive
  assert.equal(a.status, 201);
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'duplicate');
  assert.equal(store._rows.size, 1, 'a duplicate never creates a second row');
});

test('signup_order is monotonic across distinct signups', async () => {
  const { http } = makeHttp();
  const a = await http.subscribe({ body: { email: 'a@example.com' } });
  const b = await http.subscribe({ body: { email: 'b@example.com' } });
  const c = await http.subscribe({ body: { email: 'c@example.com' } });
  assert.deepEqual(
    [a.body.signupOrder, b.body.signupOrder, c.body.signupOrder],
    [1, 2, 3],
  );
});

test('invalid or disposable emails → 400 invalid_email', async () => {
  const { http, store } = makeHttp();
  for (const bad of ['not-an-email', 'x@', '@domain.com', '', 'user@mailinator.com']) {
    const res = await http.subscribe({ body: { email: bad } });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.body.error.code, 'invalid_email');
  }
  assert.equal(store._rows.size, 0, 'nothing invalid is persisted');
});

test('an invalid locale → 400 invalid_locale, but a valid one is accepted', async () => {
  const { http } = makeHttp();
  const bad = await http.subscribe({ body: { email: 'a@example.com', locale: 'xx' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_locale');
  const ok = await http.subscribe({ body: { email: 'a@example.com', locale: 'pt' } });
  assert.equal(ok.status, 201);
});

test('Malformed JSON is handled by the gateway; the handler treats a missing body as empty input', async () => {
  // The Next gateway strips a malformed body to undefined; the handler passes body ?? {}.
  const { http } = makeHttp();
  const res = await http.subscribe({ body: undefined });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_email');
});

test('a client cannot forge status or signup_order — server values win', async () => {
  const { http, store } = makeHttp();
  const res = await http.subscribe({
    body: { email: 'a@example.com', status: 'active', signupOrder: 999 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'waitlisted'); // server sets this
  assert.equal(res.body.signupOrder, 1);        // DB identity counter, not 999
});

test('welcome email is triggered on success and reported (degrade-safe)', async () => {
  const { http, email } = makeHttp({ emailDeliver: true });
  const res = await http.subscribe({ body: { email: 'a@example.com', locale: 'en' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.welcomeEmailSent, true);
  assert.deepEqual(email._sent[0], { to: 'a@example.com', locale: 'en', url: null });
});

test('an email-sender failure does not fail the signup (welcome email is best-effort)', async () => {
  const { http, store } = makeHttp({ emailDeliver: false });
  const res = await http.subscribe({ body: { email: 'a@example.com' } });
  assert.equal(res.status, 201); // signup commits regardless
  assert.equal(res.body.welcomeEmailSent, false);
  assert.equal(store._rows.size, 1, 'the signup is still persisted');
});

test('a duplicate response never leaks the prior row', async () => {
  const { http } = makeHttp();
  await http.subscribe({ body: { email: 'a@example.com', role: 'homeowner' } });
  const dup = await http.subscribe({ body: { email: 'a@example.com' } });
  assert.equal(dup.body.error.code, 'duplicate');
  assert.equal(dup.body.error.status, undefined);
  // No email/status/order echo on the error path.
  assert.ok(!('email' in dup.body.error));
});
