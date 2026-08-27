// Adversarial tests for the session cookie (LINA-56).
//
// The whole permission model (ADR-0004) rests on one assumption: `session.partyId`
// cannot be chosen by the client. Every test here is an attempt to break that.
//   node --test services/identity/session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintSession, verifySession, sessionCookie, clearSessionCookie, SESSION_COOKIE } from './session.mjs';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const PARTY = '11111111-1111-4111-8111-111111111111';
const ATTACKER = '22222222-2222-4222-8222-222222222222';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

test('a minted session round-trips to the same party', () => {
  const { token, expiresAt } = mintSession({ partyId: PARTY }, { secret: SECRET });
  const session = verifySession(token, { secret: SECRET });
  assert.equal(session.partyId, PARTY);
  assert.equal(session.expiresAt, expiresAt);
});

test('editing the payload to another party invalidates the signature', () => {
  const { token } = mintSession({ partyId: PARTY }, { secret: SECRET });
  const [v, payloadB64, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const forged = `${v}.${b64url({ ...payload, sub: ATTACKER })}.${sig}`;
  assert.equal(verifySession(forged, { secret: SECRET }), null);
});

test('an unsigned or self-signed token is rejected', () => {
  const payload = { sub: ATTACKER, iat: 0, exp: Math.floor(Date.now() / 1000) + 3600 };
  assert.equal(verifySession(`v1.${b64url(payload)}.`, { secret: SECRET }), null);
  // Signed with a secret the server does not hold.
  const { token } = mintSession({ partyId: ATTACKER }, { secret: OTHER_SECRET });
  assert.equal(verifySession(token, { secret: SECRET }), null);
});

test('expiry is inside the signed payload, so it cannot be extended', () => {
  const past = Date.now() - 10_000;
  const { token } = mintSession({ partyId: PARTY }, { secret: SECRET, ttlSeconds: 1, now: past });
  assert.equal(verifySession(token, { secret: SECRET }), null, 'expired token is refused');

  // Re-writing exp without the secret cannot produce a valid signature.
  const [v, payloadB64, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const extended = `${v}.${b64url({ ...payload, exp: payload.exp + 10 ** 6 })}.${sig}`;
  assert.equal(verifySession(extended, { secret: SECRET }), null);
});

test('garbage, wrong version, and missing tokens are anonymous, not errors', () => {
  for (const bad of [undefined, null, '', 'not-a-token', 'v2.a.b', 'v1.%%%.%%%', 'a.b.c.d']) {
    assert.equal(verifySession(bad, { secret: SECRET }), null);
  }
});

test('a weak or absent SESSION_SECRET fails closed, loudly', () => {
  assert.throws(() => mintSession({ partyId: PARTY }, { secret: 'short' }), /SESSION_SECRET/);
  // Verification must not silently treat a misconfigured server as "anonymous" —
  // that would hide the fact that no session can ever be trusted.
  assert.throws(() => verifySession('v1.a.b', { secret: '' }), /SESSION_SECRET/);
});

test('the cookie carries httpOnly, SameSite and a signed lifetime', () => {
  const { token } = mintSession({ partyId: PARTY }, { secret: SECRET });
  const cookie = sessionCookie(token, { ttlSeconds: 60 });
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=60/);
  // Local http development would otherwise be unable to hold a session at all.
  assert.doesNotMatch(sessionCookie(token, { secure: false }), /Secure/);

  assert.match(clearSessionCookie(), /Max-Age=0/);
});
