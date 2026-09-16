// HTTP-layer contract tests for the phase lifecycle (LINA-278; ADR-0023). They
// prove, independent of Next, that createScheduleHttp wires the phase service:
//   - the acting party is taken from the session, never the body;
//   - GET /phases returns 200 with the lazily-seeded phases;
//   - a denial is a typed 4xx envelope { error: { code, message } }, never a 500;
//   - the sign-off request → approve flow returns the platform envelope and flips
//     the phase to signed_off.
// Run: node --test services/schedule/phases.http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleService } from './schedule.mjs';
import { createPhaseService } from './phases.mjs';
import { createScheduleHttp } from './http.mjs';
import { createInMemoryLedger, createInMemoryStore, createInMemoryIdentity } from './ports.mjs';

const PROJECT = 'proj-1';
const OWNER = 'party-owner';
const GC = 'party-gc';

function build() {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, 5_000_000]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: OWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  const service = createScheduleService({ store, ledger, identity });
  const phases = createPhaseService({ store, identity });
  // A plan task so a sign-off request is valid.
  store.insertStage(undefined, { id: 'stage-1', project_id: PROJECT, position: 1, plan_version_id: null });
  return { http: createScheduleHttp({ service, phases }), store };
}

const owner = { partyId: OWNER };
const gc = { partyId: GC };

test('GET /projects/:id/phases — 200, lazily seeded phases', async () => {
  const { http } = build();
  const res = await http.listPhases({ session: gc, params: { projectId: PROJECT } });
  assert.equal(res.status, 200);
  assert.equal(res.body.phases.length, 2);
  assert.equal(res.body.phases[0].kind, 'procurement');
});

test('GET /projects/:id/phases — unauthenticated is a typed 401 envelope, not a 500', async () => {
  const { http } = build();
  const res = await http.listPhases({ session: null, params: { projectId: PROJECT } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

test('sign-off request → approve flips the execution phase to signed_off', async () => {
  const { http, store } = build();
  // Seed with a signed contractor so execution starts active.
  const phaseSvc = createPhaseService({ store, identity: createInMemoryIdentity({
    memberships: [{ projectId: PROJECT, partyId: OWNER, role: 'owner' }, { projectId: PROJECT, partyId: GC, role: 'counterparty' }],
  }) });
  await phaseSvc.ensurePhases(PROJECT, { hasSignedContractor: true });
  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');

  const reqRes = await http.requestSignOff({ session: gc, params: { projectId: PROJECT, phaseId: execution.id } });
  assert.equal(reqRes.status, 201);
  const requestId = reqRes.body.signOffRequest.id;

  const approveRes = await http.approveSignOff({
    session: owner,
    params: { projectId: PROJECT, phaseId: execution.id, requestId },
    body: { comment: 'approved' },
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.phase.status, 'signed_off');
  assert.equal(approveRes.body.signOffRequest.status, 'approved');
});

test('sign-off approve by the requester is a typed 403 envelope', async () => {
  const { http, store } = build();
  const phaseSvc = createPhaseService({ store, identity: createInMemoryIdentity({
    memberships: [{ projectId: PROJECT, partyId: GC, role: 'counterparty' }],
  }) });
  await phaseSvc.ensurePhases(PROJECT, { hasSignedContractor: true });
  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');
  const reqRes = await http.requestSignOff({ session: gc, params: { projectId: PROJECT, phaseId: execution.id } });
  const requestId = reqRes.body.signOffRequest.id;

  const res = await http.approveSignOff({
    session: gc,
    params: { projectId: PROJECT, phaseId: execution.id, requestId },
    body: {},
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'cannot_self_approve');
});
