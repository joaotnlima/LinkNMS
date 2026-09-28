// The change-order lock wired into planning writes (LINA-356; ADR-0024).
// Once the project's execution phase is signed_off, store.isPlanLocked returns
// true and every STRUCTURAL plan mutation must refuse with invalid_transition /
// reason:'plan_locked' — the edit routes through the change-order ledger
// (ADR-0014). Execution REPORTING (recordActual, reportProgress) is deliberately
// NOT gated: recording what happened on a signed-off, executing plan is the
// whole point of the lock. Proven at the use-case layer with a minimal fake
// store — the guard runs before any withPlanTx write, so no DB is needed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createTask, applySchedule } from './use-cases.mjs';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const TASK = '01920000-0000-7000-8000-0000000000d1';
const PERSON = '01920000-0000-7000-8000-0000000000c1';

function store({ locked }) {
  return {
    async getPersonByClerkId() { return { id: PERSON, clerk_user_id: 'u', email: 'a@b.pt' }; },
    async getProject() { return { id: PROJECT, owner_org_id: ORG, created_by_org_id: ORG, status: 'active' }; },
    async isParticipant() { return true; },
    async isStaffed() { return true; },
    async isPlanLocked() { return locked; },
    async getTask() { return { id: TASK, projectId: PROJECT, deletedAt: null, parentId: null }; },
    async loadPlan() { return { tasks: new Map(), links: [], boqLines: [] }; },
    async withPlanTx() { throw new Error('withPlanTx must not run once the plan is locked'); },
  };
}

const viewer = createViewerContext({
  clerkUserId: 'u', orgId: ORG, clerkOrgId: 'org', orgKind: 'contractor', orgRole: 'admin',
  permissions: ['org:plan:edit', 'org:costs:edit'],
});

const isPlanLocked = (err) => err?.problem?.code === 'invalid_transition' && err?.problem?.reason === 'plan_locked';

describe('plan lock (execution signed_off) blocks structural writes', () => {
  test('createTask refuses with plan_locked before it validates or writes', async () => {
    await assert.rejects(
      () => createTask({ viewer, store: store({ locked: true }), projectId: PROJECT, body: {}, idempotencyKey: null }),
      isPlanLocked,
    );
  });

  test('applySchedule refuses with plan_locked', async () => {
    await assert.rejects(
      () => applySchedule({ viewer, store: store({ locked: true }), projectId: PROJECT, body: { operations: [{}] }, idempotencyKey: null }),
      isPlanLocked,
    );
  });

  test('when unlocked the guard passes through (createTask reaches validation)', async () => {
    // locked:false → guard is a no-op; an empty body then fails validation, not the lock.
    await assert.rejects(
      () => createTask({ viewer, store: store({ locked: false }), projectId: PROJECT, body: {}, idempotencyKey: null }),
      (e) => e?.problem?.code === 'validation_failed',
    );
  });
});
