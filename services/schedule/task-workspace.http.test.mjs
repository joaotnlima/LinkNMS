// HTTP-layer contract tests for the task workspace routes (LINA-249). Proving,
// at the handler boundary (what the Next routes actually call), that:
//   - the three routes are wired and return the platform envelope (200/201);
//   - actor comes from the session (ADR-0004); a forged author/uploader is inert;
//   - every denial is a typed 4xx envelope (403 membership, 404 unknown stage,
//     400 malformed key / empty file, 413 oversize, 415 unsupported type),
//     never a 500.
// Run: node --test services/schedule/task-workspace.http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleHttp } from './http.mjs';
import { createInMemoryStore, createInMemoryIdentity } from './ports.mjs';
import { createTaskWorkspaceService } from './task-workspace.mjs';
import { createInMemoryBlobStore } from './blob-store.mjs';

const PROJECT = 'proj-1';
const ALICE = 'party-alice';
const CHARLIE = 'party-charlie';
const STAGE_KEY = 'pre-construction';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function build() {
  const store = createInMemoryStore();
  const identity = createInMemoryIdentity({
    memberships: [{ projectId: PROJECT, partyId: ALICE, role: 'member' }],
  });
  store.insertStage(undefined, { id: 'stage-1', project_id: PROJECT, key: STAGE_KEY, position: 1, plan_version_id: null });
  const taskWorkspace = createTaskWorkspaceService({
    store, identity, blob: createInMemoryBlobStore(),
  });
  // The workspace handlers never touch the schedule `service`; a stub satisfies
  // the composition-front requirement.
  return createScheduleHttp({ service: {}, taskWorkspace });
}

const alice = { partyId: ALICE };
const charlie = { partyId: CHARLIE };
const params = { projectId: PROJECT, stageKey: STAGE_KEY };

test('GET workspace → 200 with both boxes, oldest → newest', async () => {
  const http = build();
  await http.addStageComment({ session: alice, params, body: { body: 'one' } });
  await http.addStageAttachment({ session: alice, params, file: { filename: 'a.png', buffer: PNG } });
  const res = await http.getWorkspace({ session: alice, params });
  assert.equal(res.status, 200);
  assert.equal(res.body.stageKey, STAGE_KEY);
  assert.equal(res.body.comments.length, 1);
  assert.equal(res.body.comments[0].authorPartyId, ALICE);
  assert.equal(res.body.attachments.length, 1);
  assert.equal(res.body.attachments[0].uploaderPartyId, ALICE);
  assert.equal(res.body.attachments[0].contentType, 'image/png');
});

test('POST comment → 201; a forged author in the body is inert', async () => {
  const http = build();
  const res = await http.addStageComment({ session: alice, params, body: { body: '  hi  ', authorPartyId: CHARLIE } });
  assert.equal(res.status, 201);
  assert.equal(res.body.comment.body, 'hi');
  assert.equal(res.body.comment.authorPartyId, ALICE);
});

test('POST attachment → 201 with server-sniffed metadata', async () => {
  const http = build();
  const res = await http.addStageAttachment({ session: alice, params, file: { filename: 'deck.xlsx', buffer: PNG } });
  assert.equal(res.status, 201);
  assert.equal(res.body.attachment.contentType, 'image/png');
  assert.equal(res.body.attachment.blobUrl.startsWith('blob://'), true);
});

test('a non-member gets a typed 403 envelope, never a 500', async () => {
  const http = build();
  const res = await http.getWorkspace({ session: charlie, params });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'forbidden');
});

test('an unknown stage key gets a typed 404 envelope', async () => {
  const http = build();
  const res = await http.getWorkspace({ session: alice, params: { projectId: PROJECT, stageKey: 'gone' } });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

test('a malformed stageKey gets a typed 400 envelope', async () => {
  const http = build();
  const res = await http.addStageComment({ session: alice, params: { projectId: PROJECT, stageKey: '' }, body: { body: 'x' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'bad_request');
});

test('an oversize upload gets a typed 413 envelope; an empty one 400', async () => {
  const http = build();
  const big = await http.addStageAttachment({ session: alice, params, file: { filename: 'big.png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) } });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'attachment_too_large');

  const empty = await http.addStageAttachment({ session: alice, params, file: { filename: 'empty.png', buffer: Buffer.alloc(0) } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'empty_file');
});

test('a non-allowlisted type gets a typed 415 envelope', async () => {
  const http = build();
  const res = await http.addStageAttachment({ session: alice, params, file: { filename: 'notes.txt', buffer: Buffer.from('hello world') } });
  assert.equal(res.status, 415);
  assert.equal(res.body.error.code, 'unsupported_content_type');
});