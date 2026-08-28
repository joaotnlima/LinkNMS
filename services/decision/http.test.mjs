// HTTP handler tests for the Decision Log routes (LINA-56 / ADR-0004).
//
// These pin the security-critical wiring the openapi.yaml promises: the acting
// party is taken from the SESSION, never the body; a forged author or timestamp
// in the body is inert; and typed domain errors map to the uniform
// `{ error: { code, message } }` envelope with the right HTTP status. Run:
//   node --test services/decision/http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionLog, ACTIONS } from './decision-log.mjs';
import { createDecisionHttp } from './http.mjs';
import { createIdentityAuthz } from './identity-authz.mjs';
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

function makeHttp() {
  const ledger = createMemoryLedger();
  const store = createMemoryStore();
  const authz = createMemoryAuthz();
  for (const p of [HOMEOWNER, GC]) {
    authz.grant(PROJECT, p, [ACTIONS.RECORD, ACTIONS.REVISE, ACTIONS.VIEW]);
  }
  const service = createDecisionLog({
    store, ledger, authz, clock: createTestClock(), ids: createSeqIds('dec'),
  });
  return { http: createDecisionHttp({ service }), ledger };
}

const session = (partyId) => ({ partyId });

test('record derives the author from the session and returns 201', async () => {
  const { http } = makeHttp();
  const res = await http.recordDecision({
    session: session(HOMEOWNER),
    params: { projectId: PROJECT },
    body: { title: 'Oak floors in the hall', body: 'Agreed on site.' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.createdByPartyId, HOMEOWNER);
  assert.equal(res.body.currentRev, 1);
  assert.equal(res.body.edited, false);
});

test('a forged author/timestamp in the body is inert', async () => {
  const { http } = makeHttp();
  const res = await http.recordDecision({
    session: session(GC),
    params: { projectId: PROJECT },
    body: {
      title: 'Move the utility door',
      // Everything below is an attempt to write history as someone else, earlier.
      createdByPartyId: HOMEOWNER,
      authorPartyId: HOMEOWNER,
      revisedByPartyId: HOMEOWNER,
      createdAt: '1999-01-01T00:00:00.000Z',
      at: '1999-01-01T00:00:00.000Z',
      rev: 99,
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.createdByPartyId, GC, 'author must come from the session');
  assert.equal(res.body.original.authorPartyId, GC);
  assert.equal(res.body.currentRev, 1, 'rev is server-assigned, not body-supplied');
  assert.notEqual(res.body.createdAt, '1999-01-01T00:00:00.000Z');
});

test('no session is a 401; a non-member is a 403', async () => {
  const { http } = makeHttp();
  const anon = await http.recordDecision({
    session: null, params: { projectId: PROJECT }, body: { title: 'x' },
  });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'unauthorized');

  const outsider = await http.recordDecision({
    session: session(OUTSIDER), params: { projectId: PROJECT }, body: { title: 'x' },
  });
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.error.code, 'forbidden');
});

test('a bad title is a 400 in the uniform error envelope', async () => {
  const { http } = makeHttp();
  const res = await http.recordDecision({
    session: session(GC), params: { projectId: PROJECT }, body: { title: '   ' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_error');
  assert.match(res.body.error.message, /empty/);
});

test('revise appends a revision authored by the revising session (FR2)', async () => {
  const { http } = makeHttp();
  const created = await http.recordDecision({
    session: session(HOMEOWNER),
    params: { projectId: PROJECT },
    body: { title: 'Oak floors', body: 'v1' },
  });

  const revised = await http.reviseDecision({
    session: session(GC),
    params: { decisionId: created.body.id },
    body: { title: 'Oak floors — engineered', body: 'v2' },
  });

  assert.equal(revised.status, 200);
  assert.equal(revised.body.currentRev, 2);
  assert.equal(revised.body.edited, true);
  assert.equal(revised.body.title, 'Oak floors — engineered');
  // rev 1 survives untouched, with its ORIGINAL author — the whole point of FR2.
  assert.equal(revised.body.original.title, 'Oak floors');
  assert.equal(revised.body.original.authorPartyId, HOMEOWNER);
  assert.equal(revised.body.revisions.length, 2);
  assert.equal(revised.body.revisions[1].authorPartyId, GC);
});

test('revising an unknown decision is a 404', async () => {
  const { http } = makeHttp();
  const res = await http.reviseDecision({
    session: session(GC), params: { decisionId: 'nope' }, body: { title: 'x' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

test('list is chronological and member-only (FR7)', async () => {
  const { http } = makeHttp();
  for (const title of ['first', 'second', 'third']) {
    await http.recordDecision({
      session: session(HOMEOWNER), params: { projectId: PROJECT }, body: { title },
    });
  }
  const res = await http.listDecisions({ session: session(GC), params: { projectId: PROJECT } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.decisions.map((d) => d.title), ['first', 'second', 'third']);

  const denied = await http.listDecisions({ session: session(OUTSIDER), params: { projectId: PROJECT } });
  assert.equal(denied.status, 403);
});

test('every write is chained into the real ledger and verifies', async () => {
  const { http, ledger } = makeHttp();
  const created = await http.recordDecision({
    session: session(HOMEOWNER), params: { projectId: PROJECT }, body: { title: 'a' },
  });
  await http.reviseDecision({
    session: session(GC), params: { decisionId: created.body.id }, body: { title: 'b' },
  });
  const chain = ledger.getChain(PROJECT);
  assert.deepEqual(chain.map((e) => e.type), ['decision_recorded', 'decision_revised']);
  assert.deepEqual(chain.map((e) => e.actorPartyId), [HOMEOWNER, GC]);
  assert.equal(ledger.verify(PROJECT).verified, true);
});

test('the identity authz bridge maps decision actions onto the capability table', async () => {
  // A stand-in Identity that records what it was asked and allows members only.
  const asked = [];
  const identity = {
    async authorize({ actorPartyId, action, projectId }) {
      asked.push(action);
      if (actorPartyId !== HOMEOWNER) {
        const e = new Error('not a member'); e.status = 403; e.code = 'forbidden'; throw e;
      }
      return { role: 'owner', projectId };
    },
  };
  const authz = createIdentityAuthz({ identity });

  assert.equal(await authz.can(HOMEOWNER, ACTIONS.RECORD, PROJECT), true);
  assert.equal(await authz.can(HOMEOWNER, ACTIONS.REVISE, PROJECT), true);
  assert.equal(await authz.can(HOMEOWNER, ACTIONS.VIEW, PROJECT), true);
  assert.equal(await authz.can(OUTSIDER, ACTIONS.RECORD, PROJECT), false);
  // Mapped onto the platform capability table, not re-invented locally.
  assert.deepEqual(asked, ['record_decision', 'revise_decision', 'view_project', 'record_decision']);

  // An action with no mapping must be a loud failure, never a silent allow.
  await assert.rejects(() => authz.can(HOMEOWNER, 'delete_everything', PROJECT), /unmapped action/);
});
