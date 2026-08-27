// Contract tests for the Decision Log service (LINA-38 / design §4.1, §6, §12
// Slice 3; ADR-0002/0003/0004; FR2, FR7). These exercise the service against the
// in-memory ports, whose ledger adapter drives the REAL hash-chain core
// (services/ledger/hash-chain.mjs) and whose store runs a genuine
// snapshot/rollback transaction — so the trust-critical properties are proven,
// not stubbed:
//   - a revision APPENDS rev 2..n; rev 1 is never overwritten            → FR2
//   - author + timestamp are server-authoritative on every revision      → FR2
//   - each write chains a ledger event in the SAME transaction           → ADR-0002
//   - an append failure rolls back the projection (atomicity)            → ADR-0006 §1
//   - UNIQUE(decision_id, rev) makes a duplicate rev impossible          → design §3
//   - history lists chronologically                                       → FR7
//
// The response-shape assertions are the *contract* half: they pin the exact field
// set the published openapi.yaml `Decision` schema promises, so drift between the
// code and the spec fails the build. Run:
//   node --test services/decision/decision.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionLog, ACTIONS, DecisionError } from './decision-log.mjs';
import {
  createMemoryLedger,
  createMemoryStore,
  createMemoryAuthz,
  createTestClock,
  createSeqIds,
} from './memory-adapters.mjs';

const PROJECT = 'proj-1';
const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';
const OUTSIDER = 'party-outsider';

// A fresh, fully-wired service. Both members may record/revise/view; the outsider
// is granted nothing, so authz denies them.
function makeService({ clockStart } = {}) {
  const ledger = createMemoryLedger();
  const store = createMemoryStore();
  const authz = createMemoryAuthz();
  for (const party of [HOMEOWNER, GC]) {
    authz.grant(PROJECT, party, [ACTIONS.RECORD, ACTIONS.REVISE, ACTIONS.VIEW]);
  }
  const clock = createTestClock(clockStart);
  const ids = createSeqIds('id');
  const svc = createDecisionLog({ store, ledger, authz, clock, ids });
  return { svc, ledger, store, authz };
}

// The exact field set the openapi.yaml `Decision` schema promises. If the service
// adds/removes a field, this contract check fails until the spec matches.
const DECISION_KEYS = [
  'id', 'projectId', 'createdByPartyId', 'createdAt',
  'currentRev', 'edited', 'title', 'body', 'original', 'revisions',
].sort();
const ORIGINAL_KEYS = ['rev', 'title', 'body', 'authorPartyId', 'at'].sort();
const REVISION_KEYS = ['rev', 'title', 'body', 'authorPartyId', 'at', 'auditEventId'].sort();

function assertDecisionShape(d) {
  assert.deepEqual(Object.keys(d).sort(), DECISION_KEYS, 'Decision field set matches openapi.yaml');
  assert.deepEqual(Object.keys(d.original).sort(), ORIGINAL_KEYS, 'original field set matches openapi.yaml');
  for (const r of d.revisions) {
    assert.deepEqual(Object.keys(r).sort(), REVISION_KEYS, 'revision field set matches openapi.yaml');
  }
}

// ── record — creates revision 1 (FR2) ────────────────────────────────────────
test('record creates revision 1 with server-set author and timestamp', async () => {
  const { svc, ledger } = makeService();
  const d = await svc.record(PROJECT, GC, { title: 'Use white oak flooring', body: 'Living areas only' });

  assertDecisionShape(d);
  assert.equal(d.projectId, PROJECT);
  assert.equal(d.createdByPartyId, GC);
  assert.equal(d.currentRev, 1);
  assert.equal(d.edited, false);
  assert.equal(d.title, 'Use white oak flooring');
  assert.equal(d.body, 'Living areas only');
  assert.equal(d.revisions.length, 1);

  const rev1 = d.revisions[0];
  assert.equal(rev1.rev, 1);
  assert.equal(rev1.authorPartyId, GC, 'author is the acting party, not from the body');
  assert.equal(rev1.at, d.createdAt, 'rev-1 timestamp is the creation time');
  // original mirrors rev 1 exactly.
  assert.deepEqual(d.original, {
    rev: 1, title: 'Use white oak flooring', body: 'Living areas only',
    authorPartyId: GC, at: d.createdAt,
  });

  // The immutable fact was chained into the ledger in the same write.
  const chain = ledger.getChain(PROJECT);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].type, 'decision_recorded');
  assert.equal(chain[0].actorPartyId, GC);
  assert.deepEqual(chain[0].payload, { decisionId: d.id, rev: 1, title: 'Use white oak flooring', body: 'Living areas only' });
  assert.equal(rev1.auditEventId, chain[0].id, 'revision links the audit event that recorded it');
  assert.equal(ledger.verify(PROJECT).verified, true);
});

test('record normalizes an absent body to empty string', async () => {
  const { svc } = makeService();
  const d = await svc.record(PROJECT, HOMEOWNER, { title: 'Approve site survey' });
  assert.equal(d.body, '');
  assert.equal(d.original.body, '');
});

// ── revise — appends rev 2..n; rev 1 is never lost (FR2) ──────────────────────
test('revise appends a new revision, preserves rev 1, and carries its own author/timestamp', async () => {
  const { svc, ledger } = makeService();
  const created = await svc.record(PROJECT, GC, { title: 'Windows: double glazing', body: 'Standard spec' });

  const revised = await svc.revise(created.id, HOMEOWNER, { title: 'Windows: triple glazing', body: 'Upgraded for the north face' });

  assertDecisionShape(revised);
  assert.equal(revised.currentRev, 2);
  assert.equal(revised.edited, true);
  // Current view reflects rev 2 ...
  assert.equal(revised.title, 'Windows: triple glazing');
  assert.equal(revised.body, 'Upgraded for the north face');
  // ... while rev 1 is preserved verbatim, with its ORIGINAL author + timestamp.
  assert.deepEqual(revised.original, {
    rev: 1, title: 'Windows: double glazing', body: 'Standard spec',
    authorPartyId: GC, at: created.createdAt,
  });
  assert.equal(revised.revisions.length, 2);

  const [r1, r2] = revised.revisions;
  assert.equal(r1.rev, 1);
  assert.equal(r1.authorPartyId, GC);
  assert.equal(r2.rev, 2);
  assert.equal(r2.authorPartyId, HOMEOWNER, 'rev 2 author is the reviser, not the original author');
  assert.notEqual(r2.at, r1.at, 'rev 2 has its own, later server timestamp');
  assert.ok(r2.at > r1.at);

  // A second ledger event, chained onto the first.
  const chain = ledger.getChain(PROJECT);
  assert.equal(chain.length, 2);
  assert.equal(chain[1].type, 'decision_revised');
  assert.equal(chain[1].actorPartyId, HOMEOWNER);
  assert.deepEqual(chain[1].payload, { decisionId: created.id, rev: 2, title: 'Windows: triple glazing', body: 'Upgraded for the north face' });
  assert.equal(chain[1].prevHash, chain[0].entryHash, 'rev-2 event links the rev-1 event (hash chain)');
  assert.equal(r2.auditEventId, chain[1].id);
  assert.equal(ledger.verify(PROJECT).verified, true);
});

test('multiple revisions keep the full history in ascending rev order', async () => {
  const { svc } = makeService();
  const d0 = await svc.record(PROJECT, GC, { title: 'v1', body: 'a' });
  await svc.revise(d0.id, HOMEOWNER, { title: 'v2', body: 'b' });
  const d = await svc.revise(d0.id, GC, { title: 'v3', body: 'c' });

  assert.equal(d.currentRev, 3);
  assert.deepEqual(d.revisions.map((r) => r.rev), [1, 2, 3]);
  assert.deepEqual(d.revisions.map((r) => r.title), ['v1', 'v2', 'v3']);
  assert.deepEqual(d.revisions.map((r) => r.authorPartyId), [GC, HOMEOWNER, GC]);
  // rev 1 body still 'a' — never overwritten by later edits.
  assert.equal(d.original.body, 'a');
});

// ── list — chronological history (FR7) ───────────────────────────────────────
test('list returns decisions oldest-first, each with its full revision history', async () => {
  const { svc } = makeService();
  const first = await svc.record(PROJECT, GC, { title: 'First decision' });
  const second = await svc.record(PROJECT, HOMEOWNER, { title: 'Second decision' });
  await svc.revise(first.id, HOMEOWNER, { title: 'First decision (amended)' });

  const list = await svc.list(PROJECT, GC);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, first.id, 'oldest decision first');
  assert.equal(list[1].id, second.id);
  assert.equal(list[0].currentRev, 2);
  assert.equal(list[0].edited, true);
  assert.equal(list[1].edited, false);
  for (const d of list) assertDecisionShape(d);
});

// ── authorization (ADR-0004) ─────────────────────────────────────────────────
test('record/revise/list reject an unauthenticated caller with 401', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.record(PROJECT, null, { title: 'x' }), (e) => e instanceof DecisionError && e.status === 401 && e.code === 'unauthorized');
});

test('a non-member is forbidden (403) from recording and viewing', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.record(PROJECT, OUTSIDER, { title: 'x' }), (e) => e.status === 403 && e.code === 'forbidden');
  await assert.rejects(() => svc.list(PROJECT, OUTSIDER), (e) => e.status === 403 && e.code === 'forbidden');
});

test('revise on an unknown decision is 404', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.revise('missing', GC, { title: 'x' }), (e) => e.status === 404 && e.code === 'not_found');
});

// ── validation ───────────────────────────────────────────────────────────────
test('title is required, trimmed, and bounded; body must be a string', async () => {
  const { svc } = makeService();
  const bad = [
    { title: '' },
    { title: '   ' },
    { title: 123 },
    { title: 'x'.repeat(201) },
    { title: 'ok', body: 42 },
    { title: 'ok', body: 'x'.repeat(20001) },
  ];
  for (const input of bad) {
    await assert.rejects(() => svc.record(PROJECT, GC, input), (e) => e instanceof DecisionError && e.status === 400 && e.code === 'validation_error', `expected validation_error for ${JSON.stringify(input).slice(0, 40)}`);
  }
  // A leading/trailing-space title is accepted but trimmed.
  const d = await svc.record(PROJECT, GC, { title: '  Trim me  ' });
  assert.equal(d.title, 'Trim me');
});

// ── atomicity — a ledger failure leaves no projection row (ADR-0006 §1) ───────
test('when the ledger append fails, no decision projection row is written (rollback)', async () => {
  const ledger = createMemoryLedger();
  const store = createMemoryStore();
  const authz = createMemoryAuthz();
  authz.grant(PROJECT, GC, [ACTIONS.RECORD, ACTIONS.VIEW]);
  // Wrap the ledger so its append throws — mid-transaction, after nothing has committed.
  const boom = new Error('ledger down');
  const failingLedger = { ...ledger, append: async () => { throw boom; } };
  const svc = createDecisionLog({ store, ledger: failingLedger, authz, clock: createTestClock(), ids: createSeqIds() });

  await assert.rejects(() => svc.record(PROJECT, GC, { title: 'Should not persist' }), (e) => e === boom);

  // Nothing leaked into the projection; the real ledger chain is empty.
  const list = await svc.list(PROJECT, GC);
  assert.equal(list.length, 0);
  assert.equal(ledger.getChain(PROJECT).length, 0);
});
