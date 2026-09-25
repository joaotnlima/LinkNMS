import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifySvix } from './svix.mjs';

const SECRET_RAW = Buffer.from('a-32-byte-webhook-signing-seed!!');
const SECRET = `whsec_${SECRET_RAW.toString('base64')}`;
const BODY = '{"type":"user.created","data":{"id":"user_1"}}';
const NOW = 1_760_000_000;

function sign(id, ts, body) {
  return createHmac('sha256', SECRET_RAW).update(`${id}.${ts}.${body}`).digest('base64');
}
const headers = (over = {}) => ({
  'svix-id': 'msg_1',
  'svix-timestamp': String(NOW),
  'svix-signature': `v1,${sign('msg_1', NOW, BODY)}`,
  ...over,
});

test('a correctly signed payload verifies', () => {
  assert.deepEqual(verifySvix({ secret: SECRET, headers: headers(), rawBody: BODY, now: NOW }), { ok: true });
});

test('any v1 signature in the list may match', () => {
  const h = headers({ 'svix-signature': `v1,${Buffer.from('junkjunkjunkjunkjunkjunkjunkjun!').toString('base64')} v1,${sign('msg_1', NOW, BODY)}` });
  assert.equal(verifySvix({ secret: SECRET, headers: h, rawBody: BODY, now: NOW }).ok, true);
});

test('a tampered body, wrong secret or wrong id fails', () => {
  assert.equal(verifySvix({ secret: SECRET, headers: headers(), rawBody: BODY.replace('user_1', 'user_2'), now: NOW }).ok, false);
  assert.equal(verifySvix({ secret: `whsec_${Buffer.from('another-32-byte-signing-seed!!!!').toString('base64')}`, headers: headers(), rawBody: BODY, now: NOW }).ok, false);
  assert.equal(verifySvix({ secret: SECRET, headers: headers({ 'svix-id': 'msg_2' }), rawBody: BODY, now: NOW }).ok, false);
});

test('timestamps outside ±5 min fail; inside pass', () => {
  const old = NOW - 301;
  const h = headers({ 'svix-timestamp': String(old), 'svix-signature': `v1,${sign('msg_1', old, BODY)}` });
  assert.equal(verifySvix({ secret: SECRET, headers: h, rawBody: BODY, now: NOW }).reason, 'timestamp outside tolerance');
  const edge = NOW - 299;
  const h2 = headers({ 'svix-timestamp': String(edge), 'svix-signature': `v1,${sign('msg_1', edge, BODY)}` });
  assert.equal(verifySvix({ secret: SECRET, headers: h2, rawBody: BODY, now: NOW }).ok, true);
});

test('missing pieces fail closed', () => {
  assert.equal(verifySvix({ secret: '', headers: headers(), rawBody: BODY, now: NOW }).ok, false);
  assert.equal(verifySvix({ secret: SECRET, headers: {}, rawBody: BODY, now: NOW }).reason, 'missing svix headers');
});
