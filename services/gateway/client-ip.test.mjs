// Client-IP derivation for the per-IP sign-in rate limit (LINA-79, ADR-0007 §4).
//
// THE test is `a forged left-most hop does not win`: that is the bug this module
// exists to close. Keying the limit on a client-supplied value gave an attacker a
// fresh counter per request, so the limit read as protection it did not provide.
//
//   node --test services/gateway/client-ip.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientIpOf } from './client-ip.mjs';

const h = (obj) => new Headers(obj);

test('a forged left-most x-forwarded-for hop does not win — the appended hop does', () => {
  // What an attacker sends as `x-forwarded-for: 9.9.9.9` arrives here with the
  // proxy's observation appended on the RIGHT.
  const ip = clientIpOf(h({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }));
  assert.equal(ip, '203.0.113.7');
});

test('rotating the forged hop yields the SAME key, so the counter actually bites', () => {
  const a = clientIpOf(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }));
  const b = clientIpOf(h({ 'x-forwarded-for': '2.2.2.2, 203.0.113.7' }));
  const c = clientIpOf(h({ 'x-forwarded-for': '3.3.3.3, 4.4.4.4, 203.0.113.7' }));
  assert.equal(a, b);
  assert.equal(b, c);
});

test('x-vercel-forwarded-for outranks a client-supplied x-forwarded-for', () => {
  const ip = clientIpOf(h({
    'x-vercel-forwarded-for': '203.0.113.7',
    'x-forwarded-for': '9.9.9.9'
  }));
  assert.equal(ip, '203.0.113.7');
});

test('x-real-ip is used when there is no vercel header', () => {
  assert.equal(clientIpOf(h({ 'x-real-ip': '198.51.100.4' })), '198.51.100.4');
});

test('a single-hop x-forwarded-for is that hop', () => {
  assert.equal(clientIpOf(h({ 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
});

test('junk is not an IP — two junk strings must not each buy their own bucket', () => {
  assert.equal(clientIpOf(h({ 'x-forwarded-for': 'not-an-ip' })), null);
  assert.equal(clientIpOf(h({ 'x-forwarded-for': '999.1.1.1' })), null);
  assert.equal(clientIpOf(h({ 'x-real-ip': '<script>' })), null);
});

test('junk on the right falls back to the nearest well-formed hop, not to nothing', () => {
  assert.equal(clientIpOf(h({ 'x-forwarded-for': '203.0.113.7, unknown' })), '203.0.113.7');
});

test('no headers at all → null; the per-IP counter is skipped, per-email still holds', () => {
  assert.equal(clientIpOf(h({})), null);
  assert.equal(clientIpOf(undefined), null);
});

test('IPv6 survives, with and without brackets and a port', () => {
  assert.equal(clientIpOf(h({ 'x-forwarded-for': '2001:db8::1' })), '2001:db8::1');
  assert.equal(clientIpOf(h({ 'x-real-ip': '[2001:DB8::1]:443' })), '2001:db8::1');
});

test('an IPv4 with a port is normalised to the address', () => {
  assert.equal(clientIpOf(h({ 'x-real-ip': '203.0.113.7:41234' })), '203.0.113.7');
});
