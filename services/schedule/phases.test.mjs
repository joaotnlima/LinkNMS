// Contract tests for the project phase lifecycle (LINA-278; ADR-0023 §3, §8,
// §10) against the in-memory store + identity. They prove the acceptance rules:
//   - auto-creation seeds procurement (seq 0) + execution (seq 1); hasSignedContractor
//     decides which starts active; seeding is idempotent (no duplicate on re-run);
//   - GET /phases is members-only (403 non-member, 401 unauthenticated) and
//     lazy-inits the two phases for a legacy project on first read;
//   - a sign-off request needs an ACTIVE phase and ≥1 plan task; one pending
//     request per phase (a second is 409);
//   - approve flips the phase to signed_off (one-way) and cannot be done by the
//     requester (self-approval 403); reject leaves the phase active and frees the
//     pending slot;
//   - signed_off is terminal: the store refuses to walk it back, and the
//     change-order guard (assertPlanEditable) locks the plan once signed off.
// Run: node --test services/schedule/phases.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryStore, createInMemoryIdentity } from './ports.mjs';
import { createPhaseService } from './phases.mjs';

const OWNER = 'party-owner';
const GC = 'party-gc';
const STRANGER = 'party-stranger';
const PROJECT = 'project-1';

function build({
  memberships = [OWNER, GC].map((p) => ({ projectId: PROJECT, partyId: p, role: 'member' })),
  withTask = true,
} = {}) {
  const store = createInMemoryStore();
  const identity = createInMemoryIdentity({ memberships });
  const service = createPhaseService({ store, identity });
  if (withTask) {
    store.insertStage(undefined, { id: 'stage-1', project_id: PROJECT, position: 1, plan_version_id: null });
  }
  return { store, identity, service };
}

async function statusOf(service, kind) {
  const { phases } = await service.listPhases(PROJECT, OWNER);
  return phases.find((p) => p.kind === kind)?.status;
}

// ── Auto-creation / seeding ───────────────────────────────────────────────────

test('ensurePhases seeds procurement active + execution pending when no signed contractor', async () => {
  const { service } = build();
  const phases = await service.ensurePhases(PROJECT, { hasSignedContractor: false });
  assert.deepEqual(phases.map((p) => [p.kind, p.sequence, p.status]), [
    ['procurement', 0, 'active'],
    ['execution', 1, 'pending'],
  ]);
});

test('ensurePhases skips procurement and activates execution when a contractor is signed', async () => {
  const { service } = build();
  const phases = await service.ensurePhases(PROJECT, { hasSignedContractor: true });
  assert.equal(phases.find((p) => p.kind === 'procurement').status, 'pending');
  assert.equal(phases.find((p) => p.kind === 'execution').status, 'active');
});

test('ensurePhases is idempotent — a second call never duplicates the phases', async () => {
  const { service, store } = build();
  await service.ensurePhases(PROJECT, { hasSignedContractor: false });
  await service.ensurePhases(PROJECT, { hasSignedContractor: true }); // must NOT re-seed / flip
  const rows = await store.listPhasesByProject(PROJECT);
  assert.equal(rows.length, 2, 'exactly two phases');
  assert.equal(rows.find((p) => p.kind === 'procurement').status, 'active', 'first seed wins');
});

// ── listPhases: auth + lazy-init ───────────────────────────────────────────────

test('listPhases lazily seeds the two default phases for a legacy project', async () => {
  const { service, store } = build();
  assert.equal((await store.listPhasesByProject(PROJECT)).length, 0);
  const { phases } = await service.listPhases(PROJECT, OWNER);
  assert.equal(phases.length, 2);
  assert.equal(phases[0].kind, 'procurement');
  assert.deepEqual(phases[0].signOffRequests, [], 'each phase carries its (empty) sign-off history');
});

test('listPhases denies a non-member (403) and an unauthenticated caller (401)', async () => {
  const { service } = build();
  await assert.rejects(() => service.listPhases(PROJECT, STRANGER), (e) => e.status === 403);
  await assert.rejects(() => service.listPhases(PROJECT, null), (e) => e.status === 401);
});

// ── requestSignOff ─────────────────────────────────────────────────────────────

test('requestSignOff requires an active phase', async () => {
  const { service, store } = build();
  await service.ensurePhases(PROJECT, { hasSignedContractor: false });
  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');
  assert.equal(execution.status, 'pending');
  await assert.rejects(
    () => service.requestSignOff(PROJECT, execution.id, GC),
    (e) => e.status === 409 && e.code === 'phase_not_active');
});

test('requestSignOff requires at least one plan task', async () => {
  const { service, store } = build({ withTask: false });
  await service.ensurePhases(PROJECT, { hasSignedContractor: false });
  const procurement = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'procurement');
  await assert.rejects(
    () => service.requestSignOff(PROJECT, procurement.id, GC),
    (e) => e.status === 409 && e.code === 'no_plan_tasks');
});

test('requestSignOff opens a pending request; a second is rejected (one pending per phase)', async () => {
  const { service, store } = build();
  await service.ensurePhases(PROJECT, { hasSignedContractor: true }); // execution active
  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');

  const { signOffRequest } = await service.requestSignOff(PROJECT, execution.id, GC);
  assert.equal(signOffRequest.status, 'pending');
  assert.equal(signOffRequest.requestedBy, GC);

  await assert.rejects(
    () => service.requestSignOff(PROJECT, execution.id, GC),
    (e) => e.status === 409 && e.code === 'sign_off_already_pending');
});

test('requestSignOff 404s for a phase that is not on this project', async () => {
  const { service } = build();
  await assert.rejects(
    () => service.requestSignOff(PROJECT, '00000000-0000-0000-0000-000000000000', GC),
    (e) => e.status === 404);
});

// ── approve / reject ────────────────────────────────────────────────────────────

test('approveSignOff signs the phase off (one-way) and cannot be done by the requester', async () => {
  const { service, store } = build();
  await service.ensurePhases(PROJECT, { hasSignedContractor: true });
  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');
  const { signOffRequest } = await service.requestSignOff(PROJECT, execution.id, GC);

  // The requester may not approve their own request.
  await assert.rejects(
    () => service.approveSignOff(PROJECT, execution.id, signOffRequest.id, GC),
    (e) => e.status === 403 && e.code === 'cannot_self_approve');

  const out = await service.approveSignOff(PROJECT, execution.id, signOffRequest.id, OWNER, { comment: 'looks good' });
  assert.equal(out.signOffRequest.status, 'approved');
  assert.equal(out.signOffRequest.resolutionComment, 'looks good');
  assert.ok(out.signOffRequest.resolvedAt, 'resolved_at stamped');
  assert.equal(out.phase.status, 'signed_off');
  assert.equal(await statusOf(service, 'execution'), 'signed_off');
});

test('approveSignOff 409s when the request is already resolved', async () => {
  const { service, store } = build();
  await service.ensurePhases(PROJECT, { hasSignedContractor: true });
  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');
  const { signOffRequest } = await service.requestSignOff(PROJECT, execution.id, GC);
  await service.approveSignOff(PROJECT, execution.id, signOffRequest.id, OWNER);
  await assert.rejects(
    () => service.approveSignOff(PROJECT, execution.id, signOffRequest.id, OWNER),
    (e) => e.status === 409 && e.code === 'sign_off_already_resolved');
});

test('rejectSignOff leaves the phase active, stores the comment, and frees the pending slot', async () => {
  const { service, store } = build();
  await service.ensurePhases(PROJECT, { hasSignedContractor: true });
  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');
  const first = (await service.requestSignOff(PROJECT, execution.id, GC)).signOffRequest;

  const rejected = (await service.rejectSignOff(PROJECT, execution.id, first.id, OWNER, { comment: 'add the roofing line' })).signOffRequest;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.resolutionComment, 'add the roofing line');
  assert.equal(await statusOf(service, 'execution'), 'active', 'a rejected sign-off leaves the phase editable');

  // Pending slot freed → a fresh request is allowed.
  const second = await service.requestSignOff(PROJECT, execution.id, GC);
  assert.equal(second.signOffRequest.status, 'pending');
});

// ── one-way terminality + change-order guard ─────────────────────────────────────

test('a signed_off phase cannot be walked back out of the terminal state', async () => {
  const { service, store } = build();
  await service.ensurePhases(PROJECT, { hasSignedContractor: true });
  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');
  const { signOffRequest } = await service.requestSignOff(PROJECT, execution.id, GC);
  await service.approveSignOff(PROJECT, execution.id, signOffRequest.id, OWNER);

  assert.throws(
    () => store.updatePhaseStatus(undefined, execution.id, 'active'),
    (e) => e.trigger === 'project_phase_signed_off_one_way');
});

test('assertPlanEditable locks the plan once execution is signed off, and is a no-op otherwise', async () => {
  const { service, store } = build();
  // No phases yet → unlocked (safe before lazy-init).
  await assert.doesNotReject(() => service.assertPlanEditable(PROJECT));

  await service.ensurePhases(PROJECT, { hasSignedContractor: true }); // execution active
  await assert.doesNotReject(() => service.assertPlanEditable(PROJECT));

  const execution = (await store.listPhasesByProject(PROJECT)).find((p) => p.kind === 'execution');
  const { signOffRequest } = await service.requestSignOff(PROJECT, execution.id, GC);
  await service.approveSignOff(PROJECT, execution.id, signOffRequest.id, OWNER);

  await assert.rejects(
    () => service.assertPlanEditable(PROJECT),
    (e) => e.status === 409 && e.code === 'plan_locked');
});
