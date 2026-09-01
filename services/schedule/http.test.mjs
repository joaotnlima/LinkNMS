// HTTP-layer contract tests for Schedule & Progress (LINA-69; ADR-0004). These
// prove the two properties the gateway relies on, independent of Next:
//   - the acting party is taken from the session, NEVER the body (a forged
//     reportedBy is inert);
//   - every authorization denial is a typed 4xx envelope, never a 500 (spec §8.2,
//     LINA-56 finding).
// Run: node --test services/schedule/http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleService } from './schedule.mjs';
import { createScheduleHttp } from './http.mjs';
import { createInMemoryLedger, createInMemoryStore, createInMemoryIdentity } from './ports.mjs';

const PROJECT = 'proj-1';
const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';

function build() {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, 5_000_000]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: HOMEOWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  const service = createScheduleService({ store, ledger, identity });
  return createScheduleHttp({ service });
}

const gc = { partyId: GC };
const homeowner = { partyId: HOMEOWNER };

test('POST /projects/:id/stages — GC adds a stage → 201', async () => {
  const http = build();
  const res = await http.addStage({
    session: gc, params: { projectId: PROJECT },
    body: { name: 'Foundation', position: 1, plannedCostCents: 1_000_000 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Foundation');
  assert.equal(res.body.currentStatus, 'not_started');
});

test('the actor is the session, never the body — a forged reportedBy is inert', async () => {
  const http = build();
  const created = await http.addStage({ session: gc, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  const stageId = created.body.id;

  // Body claims the homeowner is acting, but the session is the GC → allowed, and
  // the report is attributed to the GC, not the body's claim.
  const res = await http.reportProgress({
    session: gc, params: { stageId },
    body: { status: 'in_progress', percent: 30, reportedBy: HOMEOWNER, actorPartyId: HOMEOWNER },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.history[0].reportedBy, GC);
});

test('homeowner write → 403 envelope, not 500 (spec §8.2)', async () => {
  const http = build();
  const created = await http.addStage({ session: gc, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  const stageId = created.body.id;

  const add = await http.addStage({ session: homeowner, params: { projectId: PROJECT }, body: { name: 'X', position: 2 } });
  assert.equal(add.status, 403);
  assert.equal(add.body.error.code, 'forbidden');

  const report = await http.reportProgress({ session: homeowner, params: { stageId }, body: { status: 'done' } });
  assert.equal(report.status, 403);
  assert.equal(report.body.error.code, 'forbidden');
});

test('unauthenticated (no session) → 401 envelope', async () => {
  const http = build();
  const res = await http.addStage({ session: null, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

test('GET /projects/:id/plan — both parties read the timeline + rollup', async () => {
  const http = build();
  await http.addStage({ session: gc, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  for (const s of [gc, homeowner]) {
    const res = await http.getPlan({ session: s, params: { projectId: PROJECT } });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalStages, 1);
    assert.ok('headline' in res.body && 'allocation' in res.body);
  }
});

test('a bad status is a typed 400, not a 500', async () => {
  const http = build();
  const created = await http.addStage({ session: gc, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  const res = await http.reportProgress({ session: gc, params: { stageId: created.body.id }, body: { status: 'nope' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_status');
});
