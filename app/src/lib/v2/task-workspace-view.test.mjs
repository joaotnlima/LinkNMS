// Unit tests for the v2 task-workspace wire→view transforms (LINA-324, S7).
//
// The rules worth pinning: a tombstoned comment keeps its slot but not its words;
// the author is the v2 `{ person_id, org_id }` pair, never a v1 party; a
// document's shown version is `current_version` (with a highest-number
// fall-back), never invented; the download path is a colon-command route the
// browser follows (never url-encoded away); the sha256 crosses to storage as
// base64 of the declared hex; and a problem code maps to a sentence, falling
// back to the server's own words for anything this screen cannot itself provoke.
//
// Run: node --experimental-strip-types --test src/lib/v2/task-workspace-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toCommentView, toDocumentView, latestVersionOf,
  versionRefOf, taskDocumentDownloadPath,
  formatBytes, relativeTime, hexToBase64, workspaceMessage,
} from './task-workspace-view.ts';

const actor = (over = {}) => ({ person_id: 'per-1', org_id: 'org-1', ...over });

const comment = (over = {}) => ({
  id: 'c1', object_type: 'task', object_id: 't1', kind: 'note',
  body: 'poured the slab today', author: actor(), created_at: '2026-09-27T10:00:00Z',
  deleted: false, ...over,
});

const version = (over = {}) => ({
  version_no: 1, mime: 'application/pdf', size_bytes: 2048, sha256: 'a'.repeat(64),
  uploaded_by: actor(), uploaded_at: '2026-09-27T09:00:00Z', ...over,
});

const doc = (over = {}) => ({
  id: 'd1', scope_type: 'task', scope_id: 't1', kind: 'photo', title: 'Slab',
  share_with_ancestors: false, current_version: 1, versions: [version()], ...over,
});

// ── comments ──────────────────────────────────────────────────────────────────

test('toCommentView: a note maps its author pair and carries no question fields', () => {
  const v = toCommentView(comment());
  assert.equal(v.id, 'c1');
  assert.equal(v.kind, 'note');
  assert.equal(v.body, 'poured the slab today');
  assert.equal(v.authorPersonId, 'per-1');
  assert.equal(v.authorOrgId, 'org-1');
  assert.equal(v.questionStatus, null);
  assert.equal(v.addresseeOrgId, null);
  assert.deepEqual(v.attachmentIds, []);
  assert.equal(v.deleted, false);
});

test('toCommentView: a tombstone keeps the slot, never the words', () => {
  const v = toCommentView(comment({ deleted: true, body: 'was here' }));
  assert.equal(v.deleted, true);
  assert.equal(v.body, ''); // the record shows the slot, not the retracted text
});

test('toCommentView: a question surfaces its status, addressee and attachments', () => {
  const v = toCommentView(comment({
    kind: 'question', question_status: 'answered', addressee_org_id: 'org-2',
    attachment_ids: ['d1', 'd2'],
  }));
  assert.equal(v.kind, 'question');
  assert.equal(v.questionStatus, 'answered');
  assert.equal(v.addresseeOrgId, 'org-2');
  assert.deepEqual(v.attachmentIds, ['d1', 'd2']);
});

// ── documents ───────────────────────────────────────────────────────────────

test('versionRefOf / taskDocumentDownloadPath: the ref and its 302 route', () => {
  assert.equal(versionRefOf('d1', 3), 'd1.3');
  // The colon is a router command; it must NOT be url-encoded, or the route
  // never matches `…:download`.
  assert.equal(taskDocumentDownloadPath('d1.3'), '/api/v2/document-versions/d1.3:download');
});

test('latestVersionOf: the shown version is current_version, not the newest row', () => {
  const d = doc({
    current_version: 2,
    versions: [version({ version_no: 1 }), version({ version_no: 2, size_bytes: 4096 }),
      version({ version_no: 3, size_bytes: 8192 })], // a reserved-but-uncompleted v3 could appear
  });
  const latest = latestVersionOf(d);
  assert.equal(latest.versionNo, 2);
  assert.equal(latest.sizeBytes, 4096);
  assert.equal(latest.ref, 'd1.2');
});

test('latestVersionOf: falls back to the highest number when current is absent', () => {
  const d = doc({ current_version: 9, versions: [version({ version_no: 1 }), version({ version_no: 2 })] });
  assert.equal(latestVersionOf(d).versionNo, 2);
});

test('latestVersionOf: no versions → null, never a fabricated version', () => {
  assert.equal(latestVersionOf(doc({ versions: [] })), null);
});

test('toDocumentView: versions are oldest→newest with a download path each', () => {
  const d = toDocumentView(doc({
    current_version: 2,
    versions: [version({ version_no: 2 }), version({ version_no: 1 })], // wire order is arbitrary
  }));
  assert.equal(d.id, 'd1');
  assert.equal(d.kind, 'photo');
  assert.equal(d.title, 'Slab');
  assert.equal(d.currentVersion, 2);
  assert.deepEqual(d.versions.map((v) => v.versionNo), [1, 2]);
  assert.equal(d.versions[0].downloadPath, '/api/v2/document-versions/d1.1:download');
  assert.equal(d.latest.versionNo, 2);
  assert.equal(d.latest.sizeBytes, Number(d.versions[1].sizeBytes));
});

// ── formatters ──────────────────────────────────────────────────────────────

test('formatBytes: decimal units, one place above a KB', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1_400_000), '1.4 MB');
  assert.equal(formatBytes(-1), '—');
});

test('relativeTime: buckets, and a future timestamp reads "just now"', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  assert.equal(relativeTime('2026-09-27T11:59:30Z', now), 'just now');
  assert.equal(relativeTime('2026-09-27T11:56:00Z', now), '4 min ago');
  assert.equal(relativeTime('2026-09-27T09:00:00Z', now), '3 h ago');
  assert.equal(relativeTime('2026-09-26T12:00:00Z', now), 'yesterday');
  assert.equal(relativeTime('2026-09-27T12:05:00Z', now), 'just now'); // clock skew, never "in 5 min"
  assert.equal(relativeTime('not-a-date', now), '');
});

// ── sha256 hand-off ────────────────────────────────────────────────────────

test('hexToBase64: the checksum crosses to storage as base64 of the declared hex', () => {
  // sha256("") = e3b0c442... ; its base64 is 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(hexToBase64(emptyHash), '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  assert.throws(() => hexToBase64('too-short'), /64 hex/);
});

// ── refusal wording ───────────────────────────────────────────────────────

test('workspaceMessage: known codes get a sentence; unknown falls back to server detail', () => {
  assert.match(workspaceMessage('not_found'), /not available/);
  assert.match(workspaceMessage('forbidden'), /not allowed/);
  assert.match(workspaceMessage('version_conflict'), /still being set up/);
  assert.equal(workspaceMessage('teapot', 'the server said so'), 'the server said so');
  assert.equal(workspaceMessage('teapot'), 'That did not go through. Try again.');
});
