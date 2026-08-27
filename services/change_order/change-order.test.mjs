// Contract tests for the Change Order service (LINA-39 / design §4.2, §5, §6;
// ADR-0004; FR3–FR6, FR8). These exercise the service against the in-memory
// ports, which faithfully enforce the same invariants the SQL migration and the
// Ledger service enforce in production:
//   - CHECK (decided_by <> proposed_by)                        → FR4
//   - budget_event UNIQUE(change_order_id)                     → FR5 exactly-once
//   - the proposed→decided one-way transition                 → no re-decide
//   - UNIQUE(decision_idempotency_key)                         → safe retries
//
// The response-shape assertions are the *contract* half: they pin the fields the
// published openapi.yaml promises for the CO view (the shared GET / decide body),
// so a drift between code and the spec fails the build. Run:
//   node --test services/change_order/change-order.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChangeOrderService,
  DomainError,
} from './change-order.mjs';
import {
  createInMemoryLedger,
  createInMemoryIdentity,
  createInMemoryStore,
} from './ports.mjs';

const PROJECT = 'proj-1';
const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';
const OUTSIDER = 'party-outsider';
const BASELINE = 5_000_000; // $50,000.00 in cents

// A fresh, fully-wired service with a $50k baseline and two members.
function makeService() {
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, BASELINE]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: HOMEOWNER, role: 'homeowner' },
      { projectId: PROJECT, partyId: GC, role: 'general_contractor' },
    ],
  });
  const store = createInMemoryStore();
  const svc = createChangeOrderService({ store, ledger, identity });
  return { svc, ledger, identity, store };
}

// Returns a promise — the service is async so every caller awaits it.
function propose(svc, actor = GC, overrides = {}) {
  return svc.propose(PROJECT, actor, {
    title: 'Upgrade to oak flooring',
    costDeltaCents: 120_000,
    scopeImpactNote: 'Replace laminate with white oak in living areas',
    scheduleImpactDays: 5,
    scheduleImpactNote: 'Adds a week for material lead time',
    qualityFlag: true,
    qualityNote: 'Higher durability finish',
    ...overrides,
  });
}

// The exact field set the openapi.yaml `ChangeOrder` schema promises. If the
// service adds/removes a field, this contract test fails until the spec matches.
const CO_VIEW_FIELDS = [
  'id', 'projectId', 'decisionId', 'title', 'costDeltaCents', 'status',
  'proposedBy', 'decidedBy', 'createdAt', 'decidedAt',
  'scopeImpactNote', 'scheduleImpactDays', 'scheduleImpactNote',
  'qualityFlag', 'qualityNote',
  'budget',
];
const CO_BUDGET_FIELDS = [
  'baselineCents', 'currentCents', 'beforeCents', 'afterCents',
  'movedCents', 'projectedIfApprovedCents',
];

function assertCoContract(co) {
  assert.deepEqual(Object.keys(co).sort(), [...CO_VIEW_FIELDS].sort(),
    'CO view must expose exactly the openapi ChangeOrder fields');
  assert.deepEqual(Object.keys(co.budget).sort(), [...CO_BUDGET_FIELDS].sort(),
    'CO budget must expose exactly the openapi ChangeOrderBudget fields');
}

// ---- propose (FR3, FR8) ----------------------------------------------------

test('propose opens *proposed* and captures scope/schedule/quality without moving the budget', async () => {
  const { svc, ledger } = makeService();
  const co = await propose(svc);

  assert.equal(co.status, 'proposed');
  assert.equal(co.proposedBy, GC);
  assert.equal(co.decidedBy, null);
  assert.equal(co.decidedAt, null);
  // FR8 — non-cost impacts are captured, verbatim.
  assert.equal(co.scopeImpactNote, 'Replace laminate with white oak in living areas');
  assert.equal(co.scheduleImpactDays, 5);
  assert.equal(co.qualityFlag, true);
  assert.equal(co.qualityNote, 'Higher durability finish');
  // FR5 — proposing NEVER moves the budget; only the projection is surfaced.
  assert.equal(co.budget.currentCents, BASELINE);
  assert.equal(co.budget.movedCents, 0);
  assert.equal(co.budget.projectedIfApprovedCents, BASELINE + 120_000);
  assert.equal(ledger._budgetEvents.size, 0);
  assertCoContract(co);
});

test('propose ledgers a change_order_proposed event (auditable) but no budget move', async () => {
  const { svc, ledger } = makeService();
  await propose(svc);
  const types = ledger._events.map((e) => e.type);
  assert.deepEqual(types, ['change_order_proposed']);
});

test('propose rejects a missing title and non-integer cost', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.propose(PROJECT, GC, { costDeltaCents: 100 }),
    (e) => e instanceof DomainError && e.status === 400 && e.code === 'invalid_title');
  await assert.rejects(() => svc.propose(PROJECT, GC, { title: 'x', costDeltaCents: 1.5 }),
    (e) => e instanceof DomainError && e.status === 400 && e.code === 'invalid_cost');
  await assert.rejects(() => svc.propose(PROJECT, GC, { title: 'x', costDeltaCents: 100, scheduleImpactDays: 1.5 }),
    (e) => e instanceof DomainError && e.status === 400 && e.code === 'invalid_schedule_days');
});

test('a non-member cannot propose (403)', async () => {
  const { svc } = makeService();
  await assert.rejects(() => propose(svc, OUTSIDER),
    (e) => e instanceof DomainError && e.status === 403 && e.code === 'not_a_member');
});

test('an unauthenticated actor cannot propose (401)', async () => {
  const { svc } = makeService();
  await assert.rejects(() => propose(svc, null),
    (e) => e instanceof DomainError && e.status === 401 && e.code === 'unauthenticated');
});

// ---- two-sided approval (FR4) ---------------------------------------------

test('the proposer can NOT decide their own change order (403 self_decision)', async () => {
  const { svc, ledger } = makeService();
  const co = await propose(svc, GC);
  await assert.rejects(() => svc.decide(co.id, GC, { decision: 'approve' }),
    (e) => e instanceof DomainError && e.status === 403 && e.code === 'self_decision');
  // The blocked self-decision must not have moved the budget or written events.
  assert.equal(ledger._budgetEvents.size, 0);
  assert.equal((await svc.view(co.id)).status, 'proposed');
});

test('a non-member cannot decide (403)', async () => {
  const { svc } = makeService();
  const co = await propose(svc, GC);
  await assert.rejects(() => svc.decide(co.id, OUTSIDER, { decision: 'approve' }),
    (e) => e instanceof DomainError && e.status === 403 && e.code === 'not_a_member');
});

test('an invalid decision verb is rejected (400)', async () => {
  const { svc } = makeService();
  const co = await propose(svc, GC);
  await assert.rejects(() => svc.decide(co.id, HOMEOWNER, { decision: 'maybe' }),
    (e) => e instanceof DomainError && e.status === 400 && e.code === 'invalid_decision');
});

test('deciding an unknown change order is a 404', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.decide('does-not-exist', HOMEOWNER, { decision: 'approve' }),
    (e) => e instanceof DomainError && e.status === 404 && e.code === 'not_found');
});

// ---- budget move on approve (FR5, FR6) ------------------------------------

test('approval by a non-proposer moves the budget exactly once and reports before→after', async () => {
  const { svc, ledger } = makeService();
  const co = await propose(svc, GC, { costDeltaCents: 120_000 });
  const decided = await svc.decide(co.id, HOMEOWNER, { decision: 'approve' });

  assert.equal(decided.status, 'approved');
  assert.equal(decided.decidedBy, HOMEOWNER);
  assert.match(decided.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
  // FR6 — the one-screen budget answer.
  assert.equal(decided.budget.beforeCents, BASELINE);
  assert.equal(decided.budget.afterCents, BASELINE + 120_000);
  assert.equal(decided.budget.movedCents, 120_000);
  assert.equal(decided.budget.currentCents, BASELINE + 120_000);
  assert.equal(decided.budget.projectedIfApprovedCents, null);
  // Exactly one budget_event.
  assert.equal(ledger._budgetEvents.size, 1);
  assertCoContract(decided);
});

test('a credit (negative delta) lowers the budget on approval', async () => {
  const { svc } = makeService();
  const co = await propose(svc, GC, { costDeltaCents: -50_000, title: 'De-scope the deck' });
  const decided = await svc.decide(co.id, HOMEOWNER, { decision: 'approve' });
  assert.equal(decided.budget.afterCents, BASELINE - 50_000);
  assert.equal(decided.budget.movedCents, -50_000);
});

test('rejection never moves the budget (FR5)', async () => {
  const { svc, ledger } = makeService();
  const co = await propose(svc, GC);
  const decided = await svc.decide(co.id, HOMEOWNER, { decision: 'reject' });
  assert.equal(decided.status, 'rejected');
  assert.equal(decided.decidedBy, HOMEOWNER);
  assert.equal(decided.budget.currentCents, BASELINE);
  assert.equal(decided.budget.movedCents, 0);
  assert.equal(decided.budget.projectedIfApprovedCents, null);
  assert.equal(ledger._budgetEvents.size, 0);
});

test('a decided change order cannot be decided again (409)', async () => {
  const { svc } = makeService();
  const co = await propose(svc, GC);
  await svc.decide(co.id, HOMEOWNER, { decision: 'approve' });
  await assert.rejects(() => svc.decide(co.id, HOMEOWNER, { decision: 'reject' }),
    (e) => e instanceof DomainError && e.status === 409 && e.code === 'already_decided');
});

// ---- idempotency: serverless retries can not double-apply -----------------

test('replaying an approve with the same idempotency key returns the prior result, no double budget move', async () => {
  const { svc, ledger } = makeService();
  const co = await propose(svc, GC, { costDeltaCents: 120_000 });
  const first = await svc.decide(co.id, HOMEOWNER, { decision: 'approve', idempotencyKey: 'retry-abc' });
  const replay = await svc.decide(co.id, HOMEOWNER, { decision: 'approve', idempotencyKey: 'retry-abc' });

  assert.equal(first.status, 'approved');
  assert.deepEqual(replay, first);
  // The budget moved once, not twice.
  assert.equal(ledger._budgetEvents.size, 1);
  assert.equal((await svc.view(co.id)).budget.currentCents, BASELINE + 120_000);
});

test('reusing an idempotency key for a DIFFERENT change order is rejected (409)', async () => {
  const { svc } = makeService();
  const a = await propose(svc, GC);
  const b = await propose(svc, GC, { title: 'Second CO' });
  await svc.decide(a.id, HOMEOWNER, { decision: 'approve', idempotencyKey: 'shared-key' });
  await assert.rejects(() => svc.decide(b.id, HOMEOWNER, { decision: 'approve', idempotencyKey: 'shared-key' }),
    (e) => e instanceof DomainError && e.status === 409 && e.code === 'idempotency_key_reused');
});

test('a duplicate budget_event at the ledger is absorbed as an idempotent no-op (exactly-once)', async () => {
  // Simulate the "transaction replayed after the budget_event already committed"
  // race: the ledger already has a budget_event for this CO. The service must
  // treat the LedgerBudgetConflict as the no-op it is, never a double-apply.
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, BASELINE]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: HOMEOWNER, role: 'homeowner' },
      { projectId: PROJECT, partyId: GC, role: 'general_contractor' },
    ],
  });
  const store = createInMemoryStore();
  const svc = createChangeOrderService({ store, ledger, identity });

  const co = await propose(svc, GC, { costDeltaCents: 90_000 });
  // Pre-seed the ledger as if a prior attempt already moved the budget.
  ledger.recordBudgetEvent({}, {
    projectId: PROJECT, changeOrderId: co.id, deltaCents: 90_000,
    actorPartyId: HOMEOWNER, occurredAt: new Date().toISOString(),
  });
  assert.equal(ledger._budgetEvents.size, 1);

  const decided = await svc.decide(co.id, HOMEOWNER, { decision: 'approve' });
  assert.equal(decided.status, 'approved');
  // Still exactly one budget_event; the second attempt did not double-apply.
  assert.equal(ledger._budgetEvents.size, 1);
  assert.equal(decided.budget.currentCents, BASELINE + 90_000);
});

// ---- the one-screen view (FR6) + list (FR7) -------------------------------

test('GET view returns the full one-screen answer for a proposed CO', async () => {
  const { svc } = makeService();
  const co = await propose(svc, GC);
  const view = await svc.view(co.id);
  assertCoContract(view);
  assert.equal(view.status, 'proposed');
  assert.equal(view.budget.beforeCents, BASELINE);
  assert.equal(view.budget.afterCents, BASELINE);
  assert.equal(view.budget.projectedIfApprovedCents, BASELINE + co.costDeltaCents);
});

test('viewing an unknown change order is a 404', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.view('nope'),
    (e) => e instanceof DomainError && e.status === 404 && e.code === 'not_found');
});

test('list returns a project\'s change orders chronologically (FR7) and requires membership', async () => {
  const { svc } = makeService();
  const a = await propose(svc, GC, { title: 'First' });
  const b = await propose(svc, HOMEOWNER, { title: 'Second' });
  const list = await svc.list(PROJECT, GC);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((c) => c.id), [a.id, b.id]);
  await assert.rejects(() => svc.list(PROJECT, OUTSIDER),
    (e) => e instanceof DomainError && e.status === 403);
});

test('multiple approved change orders sum into the budget, each contribution isolated (FR5)', async () => {
  const { svc, ledger } = makeService();
  const a = await propose(svc, GC, { costDeltaCents: 100_000, title: 'A' });
  const b = await propose(svc, GC, { costDeltaCents: 250_000, title: 'B' });
  await svc.decide(a.id, HOMEOWNER, { decision: 'approve' });
  await svc.decide(b.id, HOMEOWNER, { decision: 'approve' });

  assert.equal(ledger._budgetEvents.size, 2);
  const viewA = await svc.view(a.id);
  const viewB = await svc.view(b.id);
  // Each approved CO reports its own isolated contribution.
  assert.equal(viewA.budget.movedCents, 100_000);
  assert.equal(viewB.budget.movedCents, 250_000);
  // before→after brackets exactly this CO's delta against the running total.
  assert.equal(viewA.budget.afterCents - viewA.budget.beforeCents, 100_000);
  assert.equal(viewB.budget.afterCents - viewB.budget.beforeCents, 250_000);
  assert.equal(viewB.budget.currentCents, BASELINE + 350_000);
});

// ---- published spec ⇄ code contract ---------------------------------------
// The header of this file promises: "a drift between code and the spec fails the
// build". The services layer is zero-dep (no YAML parser), so we extract each
// schema's `required:` block from openapi.yaml directly and assert it is exactly
// the field set the code returns. Add/remove a field in either place → this fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Returns the `- name` bullets under the first `required:` that follows the given
// top-level `SchemaName:` line in the spec, until the block's indentation ends.
function specRequired(yaml, schemaName) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === `    ${schemaName}:`);
  assert.ok(start >= 0, `openapi.yaml must define schema ${schemaName}`);
  const reqIdx = lines.findIndex((l, i) => i > start && /^\s{6}required:\s*$/.test(l));
  assert.ok(reqIdx >= 0 && reqIdx < start + 60, `${schemaName} must have a required: block`);
  const out = [];
  for (let i = reqIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s{8}-\s+(\S+)\s*$/);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

test('openapi.yaml ChangeOrder / ChangeOrderBudget required fields match the code contract', () => {
  const specPath = fileURLToPath(new URL('./openapi.yaml', import.meta.url));
  const yaml = readFileSync(specPath, 'utf8');
  assert.deepEqual(specRequired(yaml, 'ChangeOrder').sort(), [...CO_VIEW_FIELDS].sort(),
    'openapi ChangeOrder.required must equal the CO view field set');
  assert.deepEqual(specRequired(yaml, 'ChangeOrderBudget').sort(), [...CO_BUDGET_FIELDS].sort(),
    'openapi ChangeOrderBudget.required must equal the CO budget field set');
});
