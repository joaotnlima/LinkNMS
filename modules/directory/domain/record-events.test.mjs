import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordOps } from './record-events.mjs';
import { buildState, publicProfileBody } from './public-profile.mjs';

const AT = '2026-10-01T10:00:00.000Z';

test('contract signed → a verified client for the supplier', () => {
  const ops = recordOps({
    type: 'contracting.contract.signed', occurred_at: AT, project_id: 'p1',
    scope: { type: 'contract', id: 'c1' },
    data: { kind: 'direct', client_org_id: 'owner', supplier_org_id: 'roofer' },
  });
  assert.deepEqual(ops, [{
    op: 'contract_signed', contractId: 'c1', projectId: 'p1', kind: 'direct',
    clientOrgId: 'owner', supplierOrgId: 'roofer', at: AT,
  }]);
});

test('contract state changes and change orders — never an amount', () => {
  assert.equal(recordOps({ type: 'contracting.contract.closed', scope: { type: 'contract', id: 'c1' }, data: { from: 'active', to: 'closed' } })[0].status, 'closed');
  const [co] = recordOps({
    type: 'contracting.change_order.approved', occurred_at: AT,
    data: { change_order_id: 'co1', contract_id: 'c1', amount_delta_cents: 246000 },
  });
  assert.equal(co.status, 'approved');
  assert.ok(!JSON.stringify(co).includes('246000'));
});

test('done with on-record facts → finished task; re-opened → removed; verified keeps', () => {
  const done = recordOps({
    type: 'planning.progress.reported', occurred_at: AT, project_id: 'p1',
    data: { task_id: 't1', status: 'done', assignee_org_id: 'roofer', contract_id: 'c1',
      baseline_finish: '2026-09-10', actual_finish: '2026-09-12' },
  });
  assert.equal(done[0].op, 'task_finished');
  assert.equal(done[0].actualFinish, '2026-09-12');
  assert.deepEqual(recordOps({ type: 'planning.progress.reported', data: { task_id: 't1', status: 'in_progress' } }),
    [{ op: 'task_reopened', taskId: 't1' }]);
  assert.deepEqual(recordOps({ type: 'planning.progress.reported', data: { task_id: 't1', status: 'verified' } }), []);
  // a pre-PRD-03 done (no assignee fact) records nothing
  assert.deepEqual(recordOps({ type: 'planning.progress.reported', data: { task_id: 't1', status: 'done' } }), []);
});

test('proposals for the listing stats; unrelated events ignored', () => {
  assert.equal(recordOps({ type: 'tendering.proposal.submitted', data: { rfp_id: 'r', proposal_id: 'x', bidder_org_id: 'o' } })[0].op, 'proposal_submitted');
  assert.equal(recordOps({ type: 'tendering.rfp.awarded', data: { rfp_id: 'r', proposal_id: 'x', contract_id: 'c' } })[0].op, 'proposal_awarded');
  assert.deepEqual(recordOps({ type: 'planning.task.updated', data: {} }), []);
});

test('build state and the public profile: names only with consent, stated only when claimed', () => {
  assert.equal(buildState(['active', 'closed']), 'in_progress');
  assert.equal(buildState(['closed', 'terminated']), 'closed');
  assert.equal(buildState(['terminated']), 'terminated');
  const row = {
    org_id: 'o', slug: 's', display_name: 'Silva Roofing', claimed: false, specialties: ['roofing-tiled'],
    description: 'should not show', declared_impic_number: 'X', created_at: '2026-03-01T00:00:00Z',
    verified_clients: 1, builds: 2, listed: true,
  };
  const body = publicProfileBody(row, {
    builds: [
      { statuses: ['closed'], signed_on: '2025-01-01', finished_on: '2025-09-12', consent_name: 'Moradia, Colares', tasks_finished: 3, tasks_on_time: 2 },
      { statuses: ['active'], signed_on: '2026-02-01', finished_on: null, consent_name: null },
    ],
    portfolio: [{ id: 'e', source: 'declared', title: 'Stated work' }],
  });
  assert.equal(body.description, undefined);
  assert.equal(body.stated, undefined);
  assert.deepEqual(body.portfolio, []);
  assert.equal(body.claim.available, true);
  assert.equal(body.builds[0].name, 'Moradia, Colares');
  assert.equal(body.builds[1].name, undefined);
  assert.equal(body.on_linknms_since, '2026-03-01');
});
