// PRD-12 N-12: share-link words, the create form and the holder's paths.
// Run: node --test src/lib/v2/share-links-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { statusWords, usageWords, accessWords, shareBody, sharedDocumentPath, opensInline, sizeWords } from './share-links-view.ts';

test('state and use, as the owner reads them', () => {
  assert.equal(statusWords({ status: 'active', expires_at: '2026-11-01T23:59:59Z' }), 'Open until 2026-11-01');
  assert.equal(statusWords({ status: 'expired', expires_at: '2026-10-01T23:59:59Z' }), 'Expired on 2026-10-01');
  assert.equal(statusWords({ status: 'revoked', expires_at: 'x', revoked_at: '2026-10-05T10:00:00Z' }), 'Revoked on 2026-10-05');
  assert.equal(usageWords({ access_count: 0 }), 'Not opened yet');
  assert.equal(usageWords({ access_count: 2, last_accessed_at: '2026-10-11T09:30:00Z' }), '2 accesses, last 2026-10-11 09:30');
  assert.equal(accessWords({ id: 'a', at: '2026-10-11T09:30:00Z', action: 'download', document_id: 'd', ip: '203.0.113.9' }, new Map([['d', 'Plantas']])),
    '2026-10-11 09:30 — Downloaded Plantas · 203.0.113.9');
});

test('create: audience, documents and an expiry within 90 days', () => {
  assert.equal(shareBody({ audience: '', expiresOn: '2026-10-20', documentIds: ['d'] }, '2026-10-11').ok, false);
  assert.equal(shareBody({ audience: 'CM Maia', expiresOn: '2026-10-20', documentIds: [] }, '2026-10-11').ok, false);
  assert.equal(shareBody({ audience: 'CM Maia', expiresOn: '2026-10-10', documentIds: ['d'] }, '2026-10-11').ok, false);
  // No client copy of the 90-day limit: a far date is the server's to refuse (422).
  assert.equal(shareBody({ audience: 'CM Maia', expiresOn: '2027-01-30', documentIds: ['d'] }, '2026-10-11').ok, true);
  assert.deepEqual(shareBody({ audience: ' CM Maia ', expiresOn: '2026-10-20', documentIds: ['d'] }, '2026-10-11'),
    { ok: true, body: { audience: 'CM Maia', document_ids: ['d'], expires_at: '2026-10-20T23:59:59Z' } });
});

test('the holder opens documents through the page route, never the API', () => {
  assert.equal(sharedDocumentPath('t0k', 'd', true), '/share/t0k/d?disposition=inline');
  assert.equal(opensInline({ mime: 'application/pdf' }), true);
  assert.equal(opensInline({ file_type: 'dwg', mime: 'application/acad' }), false);
  assert.equal(sizeWords(2_500_000), '2.4 MB');
});
