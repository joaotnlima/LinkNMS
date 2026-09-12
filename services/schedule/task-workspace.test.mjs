// Contract tests for the task workspace (LINA-249): per-stage comments and
// attachments anchored on the stable client-minted `stage.key`. Against the
// in-memory store + in-memory blob store, these prove the acceptance criteria:
//   - members only, both rails shared: a non-member gets 403, an unauthenticated
//     party 401, and membership is checked BEFORE the stage lookup (no 404 leak);
//   - the actor is the session party — a forged author/uploader in the payload
//     is inert and never stored;
//   - append-only: rows only grow; the store interface exposes no update/delete;
//   - the stage must be LIVE (draft/proposal/accepted/legacy); an unknown key or
//     a key whose stage sits on a terminal version is 404;
//   - attachments: server-side magic-byte sniff decides the stored content type
//     (browser-declared type is never trusted), 10 MB cap → 413, empty → 400,
//     name sanitised (basename, ≤ 255);
//   - the workspace read returns both boxes, oldest → newest.
// Run: node --test services/schedule/task-workspace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { DomainError, now, createInMemoryStore, createInMemoryIdentity } from './ports.mjs';
import { createTaskWorkspaceService } from './task-workspace.mjs';
import { createInMemoryBlobStore } from './blob-store.mjs';

const ALICE = 'party-alice';
const BOB = 'party-bob';
const CHARLIE = 'party-charlie';
const PROJECT = 'project-1';
const STAGE_KEY = 'pre-construction';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF = Buffer.from('%PDF-1.7 fake bytes');
const GIF = Buffer.from('GIF89a fake bytes');
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBP fake');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);

function build({ memberships = [ALICE, BOB].map((p) => ({ projectId: PROJECT, partyId: p, role: 'member' })) } = {}) {
  const store = createInMemoryStore();
  const identity = createInMemoryIdentity({ memberships });
  const blob = createInMemoryBlobStore();
  const service = createTaskWorkspaceService({ store, identity, blob });
  // A live stage on the project — pre-versioning legacy row (plan_version_id
  // NULL), which `stageLiveByKey` treats as addressable.
  store.insertStage(undefined, { id: 'stage-1', project_id: PROJECT, key: STAGE_KEY, position: 1, plan_version_id: null });
  return { store, identity, blob, service };
}

function file(buffer, filename = 'pic.png') {
  return { buffer, filename };
}

// A server-side re-derivation helper matching the actual magic of the wire.
test('addComment stores the SESSION actor and ignores a forged author in the body', async () => {
  const { service } = build();
  const out = await service.addComment(PROJECT, STAGE_KEY, ALICE, { body: '  scope is widening  ', authorPartyId: CHARLIE });
  assert.equal(out.comment.body, 'scope is widening');
  assert.equal(out.comment.authorPartyId, ALICE);
  assert.notEqual(out.comment.authorPartyId, CHARLIE, 'body author must be inert');
});

test('workspace read returns both boxes oldest → newest with the server view shape', async () => {
  const { service } = build();
  await service.addComment(PROJECT, STAGE_KEY, ALICE, { body: 'first' });
  await service.addComment(PROJECT, STAGE_KEY, BOB, { body: 'second' });
  await service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(PNG, 'a.png'));
  await service.addAttachment(PROJECT, STAGE_KEY, BOB, file(PNG, 'b.png'));

  const ws = await service.getWorkspace(PROJECT, STAGE_KEY, ALICE);
  assert.equal(ws.stageKey, STAGE_KEY);
  assert.deepEqual(ws.comments.map((c) => c.body), ['first', 'second']);
  assert.deepEqual(ws.comments.map((c) => c.authorPartyId), [ALICE, BOB]);
  assert.deepEqual(ws.attachments.map((a) => a.fileName), ['a.png', 'b.png']);
  assert.equal(ws.attachments[0].contentType, 'image/png');
  assert.equal(ws.attachments[0].uploaderPartyId, ALICE);
  assert.equal(ws.attachments[0].blobUrl.startsWith('blob://'), true);
});

test('a non-member is rejected 403 before any stage lookup (no 404 leak)', async () => {
  const { service, store } = build();
  await assert.rejects(
    () => service.getWorkspace(PROJECT, 'key-that-does-not-exist', CHARLIE),
    (e) => e instanceof DomainError && e.status === 403 && e.code === 'forbidden',
  );
  assert.equal(store.listStageCommentsByKey(PROJECT, 'key-that-does-not-exist').length, 0, 'nothing read/written for a non-member');
});

test('an unauthenticated party is rejected 401', async () => {
  const { service } = build();
  await assert.rejects(
    () => service.addComment(PROJECT, STAGE_KEY, null, { body: 'hey' }),
    (e) => e instanceof DomainError && e.status === 401 && e.code === 'unauthenticated',
  );
});

test('an unknown stage key is rejected 404 for a live member', async () => {
  const { service } = build();
  await assert.rejects(
    () => service.getWorkspace(PROJECT, 'demolished-stage', ALICE),
    (e) => e instanceof DomainError && e.status === 404 && e.code === 'not_found',
  );
});

test('a malformed stageKey is a 400 bad_request, never a server error', async () => {
  const { service } = build();
  // Same edge rules as the `:author` key validator: non-string / empty /
  // > 200 chars. A whitespace-only key is NOT malformed (matches the authoring
  // validator) — it simply addresses no stage → 404.
  for (const bad of [undefined, '', 'x-repeated'.repeat(40), 42]) {
    await assert.rejects(
      () => service.getWorkspace(PROJECT, bad, ALICE),
      (e) => e instanceof DomainError && e.status === 400 && e.code === 'bad_request',
      `stageKey ${JSON.stringify(bad)} must 400`,
    );
  }
});

test('comments and attachments are append-only — no update/delete surface, rows only grow', async () => {
  const { service, store } = build();
  assert.equal(['insertStageComment', 'listStageCommentsByKey', 'insertStageAttachment', 'listStageAttachmentsByKey']
    .every((m) => typeof store[m] === 'function'), true);
  assert.equal(typeof store.deleteStageComment, 'undefined');
  assert.equal(typeof store.updateStageAttachment, 'undefined');

  await service.addComment(PROJECT, STAGE_KEY, ALICE, { body: 'one' });
  await service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(PNG, 'one.png'));
  assert.equal(store._comments.length, 1);
  assert.equal(store._attachments.length, 1);

  // The read returns copies — the stored history cannot be mutated via a
  // returned row. Re-reading after mutating a copy leaves the store intact.
  const [c] = await service.getWorkspace(PROJECT, STAGE_KEY, ALICE).then((ws) => ws.comments);
  c.body = 'tampered';
  c.author_party_id = CHARLIE;
  const [again] = (await service.getWorkspace(PROJECT, STAGE_KEY, ALICE)).comments;
  assert.equal(again.body, 'one');
  assert.equal(again.authorPartyId, ALICE);
});

test('comment body is validated: missing, empty-after-trim, and > 4000 chars are 400', async () => {
  const { service } = build();
  await assert.rejects(() => service.addComment(PROJECT, STAGE_KEY, ALICE, {}),
    (e) => e instanceof DomainError && e.code === 'invalid_comment');
  await assert.rejects(() => service.addComment(PROJECT, STAGE_KEY, ALICE, { body: '   ' }),
    (e) => e instanceof DomainError && e.code === 'invalid_comment');
  await assert.rejects(() => service.addComment(PROJECT, STAGE_KEY, ALICE, { body: 'a'.repeat(4001) }),
    (e) => e instanceof DomainError && e.code === 'invalid_comment');
  // Boundary is allowed.
  const ok = await service.addComment(PROJECT, STAGE_KEY, ALICE, { body: 'a'.repeat(4000) });
  assert.equal(ok.comment.body.length, 4000);
});

test('attachments: a PNG file is sniffed image/png even when the client claims otherwise', async () => {
  const { service } = build();
  const out = await service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(PNG, 'report.docx'));
  assert.equal(out.attachment.contentType, 'image/png');
});

test('attachments: a fake office file (zip magic, non-ooxml name) is rejected 415', async () => {
  const { service } = build();
  await assert.rejects(() => service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(ZIP, 'archive.bin')),
    (e) => e instanceof DomainError && e.status === 415 && e.code === 'unsupported_content_type');
});

test('attachments: allowed magic bytes spot checks across the allowlist', async () => {
  const { service } = build();
  const cases = [
    [JPEG, 'photo.jpg', 'image/jpeg'],
    [GIF, 'anim.gif', 'image/gif'],
    [WEBP, 'web.webp', 'image/webp'],
    [PDF, 'spec.pdf', 'application/pdf'],
    [SVG, 'logo.svg', 'image/svg+xml'],
    [OLE, 'legacy.doc', 'application/msword'],
    [OLE, 'stats.xls', 'application/vnd.ms-excel'],
    [ZIP, 'deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ];
  for (const [buf, name, expect] of cases) {
    const out = await service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(buf, name));
    assert.equal(out.attachment.contentType, expect, name);
  }
});

test('attachments: > 10 MB is 413; zero bytes is 400 empty_file', async () => {
  const { service } = build();
  await assert.rejects(() => service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(Buffer.alloc(10 * 1024 * 1024 + 1, 0x89))),
    (e) => e instanceof DomainError && e.status === 413 && e.code === 'attachment_too_large');
  await assert.rejects(() => service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(Buffer.alloc(0), 'empty.png')),
    (e) => e instanceof DomainError && e.code === 'empty_file');
});

test('attachments: file names are sanitised to a basename and capped', async () => {
  const { service } = build();
  const out = await service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(PNG, '../../../../etc/passwd.png'));
  assert.equal(out.attachment.fileName, 'passwd.png');
  await assert.rejects(() => service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(PNG, 'x'.repeat(256) + '.png')),
    (e) => e instanceof DomainError && e.code === 'invalid_filename');
  await assert.rejects(() => service.addAttachment(PROJECT, STAGE_KEY, ALICE, file(PNG, '')),
    (e) => e instanceof DomainError && e.code === 'invalid_filename');
});

test('attachments: the uploader is the SESSION actor — a forged uploader is inert', async () => {
  const { service } = build();
  const out = await service.addAttachment(PROJECT, STAGE_KEY, BOB, { buffer: PNG, filename: 'p.png', uploader: CHARLIE });
  assert.equal(out.attachment.uploaderPartyId, BOB);
});

test('a key whose only stage sits on a terminal version is not live → 404', async () => {
  const { store, service } = build();
  // Create the stage while its version is a draft (the DB guard would reject an
  // insert straight onto a terminal version), then withdraw it.
  store.insertPlanVersion(undefined, {
    id: 'version-terminal', project_id: PROJECT, version_no: 1, status: 'draft',
    proposed_by_party_id: ALICE, created_at: now(),
  });
  store.insertStage(undefined, {
    id: 'stage-terminal', project_id: PROJECT, key: 'doomed', position: 2,
    plan_version_id: 'version-terminal',
  });
  assert.equal(await store.stageLiveByKey(PROJECT, 'doomed'), true);
  store.updatePlanVersionStatus(undefined, 'version-terminal', { status: 'withdrawn', versionNo: 1 });
  assert.equal(await store.stageLiveByKey(PROJECT, 'doomed'), false);
  await assert.rejects(() => service.getWorkspace(PROJECT, 'doomed', ALICE),
    (e) => e instanceof DomainError && e.status === 404 && e.code === 'not_found');
});

test('the blob store adapter: in-memory store returns blob:// URLs and exposes objects for assert', async () => {
  const { blob } = build();
  const url = await blob.put({ fileName: 'pic.png', contentType: 'image/png', buffer: PNG });
  assert.match(url, /^blob:\/\/[0-9a-f-]+\/pic\.png$/);
  assert.equal(blob._objects.get(url).contentType, 'image/png');
  assert.equal(blob._objects.get(url).size, PNG.length);
});