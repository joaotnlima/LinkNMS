// Share-link domain (PRD-12 N-12) — pure rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shareLinkStatus, parseShareLinkCreate, requesterOf, shareLinkBody } from './share-link.mjs';

const NOW = new Date('2026-10-11T12:00:00Z');
const DOC = '01920000-0000-7000-8000-0000000000f1';

test('status: revoked wins over expired; expiry is exclusive', () => {
  assert.equal(shareLinkStatus({ expires_at: '2026-10-12T00:00:00Z' }, NOW), 'active');
  assert.equal(shareLinkStatus({ expires_at: '2026-10-11T12:00:00Z' }, NOW), 'expired');
  assert.equal(shareLinkStatus({ expires_at: '2020-01-01T00:00:00Z', revoked_at: '2019-12-01T00:00:00Z' }, NOW), 'revoked');
});

test('create: audience, a future expiry within 90 days and at least one document', () => {
  const ok = parseShareLinkCreate({ audience: ' CM Maia ', expires_at: '2026-11-01T00:00:00Z', document_ids: [DOC, DOC] }, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.audience, 'CM Maia');
  assert.deepEqual(ok.value.documentIds, [DOC]);
  const bad = parseShareLinkCreate({ audience: '', expires_at: '2027-06-01T00:00:00Z', document_ids: [] }, NOW);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['audience', 'document_ids', 'expires_at']);
  assert.ok(parseShareLinkCreate({ audience: 'x', expires_at: '2026-11-01T00:00:00Z', document_ids: ['nope'] }, NOW).errors.document_ids);
});

test('requester: first forwarded hop, bounded user agent', () => {
  assert.deepEqual(requesterOf({ 'x-forwarded-for': '198.51.100.7, 10.0.0.2', 'user-agent': 'a'.repeat(400) }),
    { ip: '198.51.100.7', userAgent: 'a'.repeat(300) });
  assert.deepEqual(requesterOf({}), { ip: null, userAgent: null });
});

test('body: never a url; absent fields stay absent', () => {
  const b = shareLinkBody({ id: 'l', audience: 'CM', document_ids: [DOC], expires_at: new Date('2026-11-01T00:00:00Z'), created_at: NOW }, NOW);
  assert.equal(b.url, undefined);
  assert.equal(b.revoked_at, undefined);
  assert.equal(b.status, 'active');
  assert.equal(b.access_count, 0);
});
