// Money-flow operations end to end through the /api/v2 router, DB-free: the
// fake store answers what pg-store would. Proves the doc-16 request flow per
// operation, the doc-09 state machines on the wire, the two-sided rule
// (proposer never decides), x-human-only over MCP, the ruling-11 ancestor
// projection (existence only, amounts ABSENT) and the V3 fence on cash-flow
// (owner never sees sub-level payments).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { ProblemError } from '../../../platform/errors.mjs';
import { registerContracting } from './register.mjs';
import { lineAmountCents, retentionCents } from '../domain/money.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const SUB_ORG = '01920000-0000-7000-8000-0000000000a3';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a4';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const PRIME = '01920000-0000-7000-8000-0000000000c1';
const SUBK = '01920000-0000-7000-8000-0000000000c2';
const ME = '01920000-0000-7000-8000-0000000000e1';
const TASK = '01920000-0000-7000-8000-0000000000d1';
const BOQ_1 = '01920000-0000-7000-8000-0000000000f1';
const BOQ_2 = '01920000-0000-7000-8000-0000000000f2';
const BOQ_SUB = '01920000-0000-7000-8000-0000000000f3';

const uuid = () => randomUUID();
const ALL_PERMS = [
  'org:contracts:sign', 'org:money:view', 'org:billing:manage',
  'org:changes:propose', 'org:changes:decide',
  'org:measurements:submit', 'org:measurements:approve',
  'org:payments:declare', 'org:payments:confirm',
];

function org(id, name) {
  return { id, kind: id === OWNER_ORG ? 'household' : 'contractor', legal_name: name, nif: null };
}

function contractRow(id, over = {}) {
  return {
    id, project_id: PROJECT, kind: 'prime', parent_contract_id: null,
    client_org_id: OWNER_ORG, supplier_org_id: GC_ORG, reference: `CTR-${id.slice(-2)}`,
    specialties: [], scope_inclusions: null, scope_exclusions: null,
    payment_terms: 'measurement_monthly', retention_bp: 500, payment_days: 30,
    contractual_start: null, contractual_end: null, revision: 1,
    origin: 'direct_entry', status: 'signed', sponsored_by_org_id: null, version: 1,
    ...over,
  };
}

function fakeStore() {
  const orgs = new Map([
    [OWNER_ORG, org(OWNER_ORG, 'Família Silva')],
    [GC_ORG, org(GC_ORG, 'Douro Construções')],
    [SUB_ORG, org(SUB_ORG, 'Canalizações Norte')],
  ]);
  const contracts = new Map([
    [PRIME, contractRow(PRIME)],
    [SUBK, contractRow(SUBK, { kind: 'sub', parent_contract_id: PRIME, client_org_id: GC_ORG, supplier_org_id: SUB_ORG })],
  ]);
  const boqItems = new Map([
    [BOQ_1, { id: BOQ_1, contract_id: PRIME, task_id: TASK, code: '1.1', description: 'Fundações', unit: 'm3', quantity: '10.000', unit_price_cents: 5000, superseded_by_change_order_id: null }],
    [BOQ_2, { id: BOQ_2, contract_id: PRIME, task_id: TASK, code: '1.2', description: 'Betão', unit: 'm3', quantity: '4.000', unit_price_cents: 2500, superseded_by_change_order_id: null }],
    [BOQ_SUB, { id: BOQ_SUB, contract_id: SUBK, task_id: TASK, code: 's.1', description: 'Prumadas', unit: 'un', quantity: '2.000', unit_price_cents: 10000, superseded_by_change_order_id: null }],
  ]);
  const changeOrders = new Map(); // id → {co, lines, time}
  const measurements = new Map(); // id → {m, lines: [{boq_item_id, quantity_this_period}]}
  const payments = new Map();
  const nonconformities = [];
  const ledger = [];
  const events = [];

  const liveValue = (contractId) => [...boqItems.values()]
    .filter((b) => b.contract_id === contractId && !b.superseded_by_change_order_id)
    .reduce((s, b) => s + lineAmountCents(b.quantity, b.unit_price_cents), 0);

  const contractBundle = (id) => {
    const c = contracts.get(id);
    if (!c) return null;
    return {
      contract: c,
      client: orgs.get(c.client_org_id),
      supplier: orgs.get(c.supplier_org_id),
      roots: [TASK],
      signatures: [],
      valueCents: liveValue(id),
    };
  };
  const coBundle = (id) => {
    const e = changeOrders.get(id);
    if (!e) return null;
    return { changeOrder: e.co, lines: e.lines, time: e.time, contract: contracts.get(e.co.contract_id) };
  };
  const measurementBundle = (id) => {
    const e = measurements.get(id);
    if (!e) return null;
    return {
      measurement: e.m,
      lines: e.lines.map((l) => ({
        ...l,
        description: boqItems.get(l.boq_item_id)?.description,
        unit_price_cents: boqItems.get(l.boq_item_id)?.unit_price_cents ?? 0,
        cumulative_quantity: l.quantity_this_period,
      })),
      contract: contracts.get(e.m.contract_id),
    };
  };
  const record = (type) => { ledger.push(type); events.push(type); };

  return {
    contracts, boqItems, changeOrders, measurements, payments, nonconformities, ledger, events,
    async getPersonByClerkId(id) {
      return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'me@x.pt' } : null;
    },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, status: 'in_execution' }
        : null;
    },
    async isParticipant(projectId, orgId) {
      return projectId === PROJECT && [OWNER_ORG, GC_ORG, SUB_ORG].includes(orgId);
    },
    async isStaffed() { return false; },
    async getOrganization(id) { return orgs.get(id) ?? null; },
    async getContract(id) { return contractBundle(id); },
    async hasOpenNonConformities(contractId) {
      return nonconformities.some((n) => n.contract_id === contractId && n.status !== 'closed');
    },
    async liveBoqItemsOf(contractId, ids) {
      return new Map(ids
        .map((id) => boqItems.get(id))
        .filter((b) => b && b.contract_id === contractId && !b.superseded_by_change_order_id)
        .map((b) => [b.id, b]));
    },
    async getChangeOrder(id) { return coBundle(id); },
    async linkedChainParties(id) {
      const chain = [];
      let cur = changeOrders.get(id);
      while (cur?.co.linked_change_order_id) {
        cur = changeOrders.get(cur.co.linked_change_order_id);
        if (!cur) break;
        const c = contracts.get(cur.co.contract_id);
        chain.push({ contract_id: c.id, client_org_id: c.client_org_id, supplier_org_id: c.supplier_org_id });
      }
      for (const e of changeOrders.values()) {
        if (e.co.linked_change_order_id === id) {
          const c = contracts.get(e.co.contract_id);
          chain.push({ contract_id: c.id, client_org_id: c.client_org_id, supplier_org_id: c.supplier_org_id });
        }
      }
      return chain;
    },
    async getMeasurement(id) { return measurementBundle(id); },
    async getPayment(id) {
      const p = payments.get(id);
      return p ? { payment: p, contract: contracts.get(p.contract_id) } : null;
    },
    async contractFinancials(contractId) {
      const approved = [...changeOrders.values()].filter((e) => e.co.contract_id === contractId && e.co.status === 'approved');
      const ms = [...measurements.values()].filter((e) => e.m.contract_id === contractId && e.m.status === 'approved');
      const paid = [...payments.values()].filter((p) => p.contract_id === contractId && p.status === 'confirmed');
      const unpaid = [...payments.values()].filter((p) => p.contract_id === contractId && p.status !== 'confirmed');
      const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
      return {
        valueCents: liveValue(contractId),
        approvedChangesCents: sum(approved, (e) => e.co.amount_delta_cents),
        measuredCents: sum(ms, (e) => e.m.gross_cents),
        retentionHeldCents: sum(ms, (e) => e.m.retention_cents),
        paidCents: sum(paid, (p) => p.amount_cents),
        outstandingCents: sum(unpaid, (p) => p.amount_cents),
      };
    },
    async suggestMeasurementLines() { return []; },
    async ownerCashFlow(projectId, ownerOrgId, { from, to }) {
      return [...payments.values()]
        .filter((p) => contracts.get(p.contract_id)?.client_org_id === ownerOrgId)
        .filter((p) => ['expected', 'declared_paid'].includes(p.status))
        .filter((p) => (!from || p.due_date >= from) && (!to || p.due_date <= to))
        .map((p) => ({
          due_date: p.due_date, contract_id: p.contract_id,
          supplier: orgs.get(contracts.get(p.contract_id).supplier_org_id).legal_name,
          amount_cents: p.amount_cents, status: p.status,
        }));
    },
    async sponsorContract({ contractId, sponsorOrgId }) {
      const c = contracts.get(contractId);
      contracts.set(contractId, { ...c, sponsored_by_org_id: sponsorOrgId, version: c.version + 1 });
      record('contracting.contract.sponsored');
      return contractBundle(contractId);
    },
    async transitionContract({ contractId, from, to, eventType }) {
      const c = contracts.get(contractId);
      if (c.status !== from) throw new Error('raced');
      contracts.set(contractId, { ...c, status: to, version: c.version + 1 });
      record(eventType);
      return contractBundle(contractId);
    },
    async createChangeOrder(cmd) {
      const number = String([...changeOrders.values()].filter((e) => e.co.contract_id === cmd.contractId).length + 1);
      changeOrders.set(cmd.id, {
        co: {
          id: cmd.id, contract_id: cmd.contractId, number, kind: cmd.kind, reason: cmd.reason,
          amount_delta_cents: 0, linked_change_order_id: cmd.linkedChangeOrderId,
          from_variation_ids: cmd.fromVariationIds, proposed_by_org_id: cmd.actor.orgId,
          proposed_by_person_id: cmd.actor.personId, decided_by_org_id: null,
          decided_by_person_id: null, decided_at: null, status: 'draft', version: 1,
        },
        lines: cmd.lines.map((l) => ({ op: l.op, boq_item_id: l.boqItemId, new_line: l.newLine })),
        time: cmd.time.map((t) => ({ task_id: t.taskId, new_baseline_start: t.newBaselineStart, new_baseline_finish: t.newBaselineFinish })),
      });
      record('contracting.change_order.created');
      return coBundle(cmd.id);
    },
    async transitionChangeOrder({ changeOrderId, to, eventType }) {
      const e = changeOrders.get(changeOrderId);
      e.co = { ...e.co, status: to, version: e.co.version + 1 };
      record(eventType);
      return coBundle(changeOrderId);
    },
    async decideChangeOrder({ changeOrderId, approve, note, actor }) {
      const e = changeOrders.get(changeOrderId);
      let delta = 0;
      if (approve) {
        for (const line of e.lines) {
          if (line.op !== 'add') {
            const old = boqItems.get(line.boq_item_id);
            boqItems.set(old.id, { ...old, superseded_by_change_order_id: changeOrderId });
            delta -= lineAmountCents(old.quantity, old.unit_price_cents);
          }
          if (line.op !== 'remove') {
            const n = line.new_line;
            boqItems.set(n.id, {
              id: n.id, contract_id: e.co.contract_id, task_id: n.task_id ?? TASK,
              code: n.code, description: n.description, unit: n.unit, quantity: n.quantity,
              unit_price_cents: n.unit_price.amount_cents, superseded_by_change_order_id: null,
              introduced_by_change_order_id: changeOrderId,
            });
            delta += lineAmountCents(n.quantity, n.unit_price.amount_cents);
          }
        }
        const c = contracts.get(e.co.contract_id);
        contracts.set(c.id, { ...c, revision: c.revision + 1, version: c.version + 1 });
      }
      e.co = {
        ...e.co, status: approve ? 'approved' : 'rejected', amount_delta_cents: delta,
        decided_by_org_id: actor.orgId, decided_by_person_id: actor.personId,
        decided_at: '2026-09-26T10:00:00Z', decision_note: note, version: e.co.version + 1,
      };
      record(approve ? 'contracting.change_order.approved' : 'contracting.change_order.rejected');
      return coBundle(changeOrderId);
    },
    async createMeasurement(cmd) {
      const existing = [...measurements.values()].find((e) => e.m.contract_id === cmd.contractId && e.m.period === cmd.period);
      let id = cmd.id;
      if (existing) {
        if (existing.m.status !== 'disputed') {
          throw new ProblemError('version_conflict', `a measurement for ${cmd.period} already exists`);
        }
        id = existing.m.id;
        existing.m = { ...existing.m, status: 'submitted', gross_cents: cmd.grossCents, retention_cents: cmd.retentionCents, net_cents: cmd.netCents };
        existing.lines = cmd.lines.map((l) => ({ boq_item_id: l.boqItemId, quantity_this_period: l.quantityThisPeriod }));
      } else {
        measurements.set(id, {
          m: {
            id, contract_id: cmd.contractId, period: cmd.period, status: 'submitted',
            gross_cents: cmd.grossCents, retention_cents: cmd.retentionCents, net_cents: cmd.netCents,
          },
          lines: cmd.lines.map((l) => ({ boq_item_id: l.boqItemId, quantity_this_period: l.quantityThisPeriod })),
        });
      }
      record('contracting.measurement.submitted');
      return measurementBundle(id);
    },
    async approveMeasurement({ measurementId, paymentDays }) {
      const e = measurements.get(measurementId);
      e.m = { ...e.m, status: 'approved' };
      const due = new Date(Date.now() + paymentDays * 86400000).toISOString().slice(0, 10);
      const paymentId = uuid();
      payments.set(paymentId, {
        id: paymentId, contract_id: e.m.contract_id, measurement_id: measurementId,
        milestone_label: null, amount_cents: e.m.net_cents, due_date: due, status: 'expected',
        declared_paid_at: null, confirmed_at: null,
      });
      record('contracting.measurement.approved');
      return measurementBundle(measurementId);
    },
    async disputeMeasurement({ measurementId }) {
      const e = measurements.get(measurementId);
      e.m = { ...e.m, status: 'disputed' };
      record('contracting.measurement.disputed');
      return measurementBundle(measurementId);
    },
    async transitionPayment({ paymentId, to, eventType }) {
      const p = payments.get(paymentId);
      payments.set(paymentId, {
        ...p, status: to,
        declared_paid_at: to === 'declared_paid' ? '2026-09-26T10:00:00Z' : p.declared_paid_at,
        confirmed_at: to === 'confirmed' ? '2026-09-26T11:00:00Z' : p.confirmed_at,
      });
      record(eventType);
      return payments.get(paymentId);
    },
    async idempotent(meta, fn) { return fn(); },
  };
}

function viewer(orgId, { role = 'manager', perms = ALL_PERMS, channel = 'ui' } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: orgId ? role : null,
    permissions: perms, channel,
  });
}

describe('money flow over the /api/v2 router', () => {
  let router, store;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerContracting(router, { store });
  });

  const dispatch = (method, path, viewerCtx, body = null, headers = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, headers });

  describe('contract lifecycle tail', () => {
    test('sponsor: the client with org:billing:manage → 200 + sponsorship', async () => {
      const res = await dispatch('POST', `/contracts/${PRIME}:sponsor`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.sponsored_by_org_id, OWNER_ORG);
      assert.ok(store.events.includes('contracting.contract.sponsored'));
    });

    test('sponsor: the supplier never sponsors itself → 403; no permission → 403', async () => {
      assert.equal((await dispatch('POST', `/contracts/${PRIME}:sponsor`, viewer(GC_ORG))).status, 403);
      assert.equal((await dispatch('POST', `/contracts/${PRIME}:sponsor`,
        viewer(OWNER_ORG, { perms: ['org:contracts:sign'] }))).status, 403);
    });

    test('receive-provisionally: only from ACTIVE and with no open non-conformities', async () => {
      const early = await dispatch('POST', `/contracts/${PRIME}:receive-provisionally`, viewer(OWNER_ORG));
      assert.equal(early.status, 409); // still signed, not active

      store.contracts.set(PRIME, contractRow(PRIME, { status: 'active' }));
      store.nonconformities.push({ contract_id: PRIME, status: 'open' });
      const blocked = await dispatch('POST', `/contracts/${PRIME}:receive-provisionally`, viewer(OWNER_ORG));
      assert.equal(blocked.status, 409);

      store.nonconformities[0].status = 'closed';
      const ok = await dispatch('POST', `/contracts/${PRIME}:receive-provisionally`, viewer(OWNER_ORG));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.status, 'provisionally_received');
    });

    test('close: client only, from provisionally_received', async () => {
      store.contracts.set(PRIME, contractRow(PRIME, { status: 'provisionally_received' }));
      assert.equal((await dispatch('POST', `/contracts/${PRIME}:close`, viewer(GC_ORG))).status, 403);
      const res = await dispatch('POST', `/contracts/${PRIME}:close`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'closed');
    });

    test('terminate: either party from signed/active; never from draft', async () => {
      const res = await dispatch('POST', `/contracts/${PRIME}:terminate`, viewer(GC_ORG), { note: 'obra parada' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'terminated');

      store.contracts.set(SUBK, contractRow(SUBK, { kind: 'sub', parent_contract_id: PRIME, client_org_id: GC_ORG, supplier_org_id: SUB_ORG, status: 'draft' }));
      assert.equal((await dispatch('POST', `/contracts/${SUBK}:terminate`, viewer(GC_ORG), {})).status, 409);
      // the owner is NOT a party of the sub contract
      store.contracts.set(SUBK, contractRow(SUBK, { kind: 'sub', parent_contract_id: PRIME, client_org_id: GC_ORG, supplier_org_id: SUB_ORG }));
      assert.equal((await dispatch('POST', `/contracts/${SUBK}:terminate`, viewer(OWNER_ORG), {})).status, 403);
    });

    test('financials: party ∧ org:money:view; everyone else 403', async () => {
      const res = await dispatch('GET', `/contracts/${PRIME}/financials`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.value, { amount_cents: 60000, currency: 'EUR' }); // 10×50 + 4×25 €
      assert.deepEqual(res.body.paid, { amount_cents: 0, currency: 'EUR' });
      assert.equal((await dispatch('GET', `/contracts/${PRIME}/financials`, viewer(SUB_ORG))).status, 403);
      assert.equal((await dispatch('GET', `/contracts/${PRIME}/financials`,
        viewer(OWNER_ORG, { perms: ['org:contracts:sign'] }))).status, 403);
      assert.equal((await dispatch('GET', `/contracts/${PRIME}/financials`, viewer(STRANGER_ORG))).status, 404);
    });
  });

  describe('change orders', () => {
    const coCreate = (over = {}) => ({
      id: uuid(),
      kind: 'scope',
      reason: 'mais tomadas na cozinha',
      lines: [
        { op: 'replace', boq_item_id: BOQ_1, new_line: { id: uuid(), code: '1.1a', description: 'Fundações reforçadas', unit: 'm3', quantity: '12.000', unit_price_cents: undefined, unit_price: { amount_cents: 5000, currency: 'EUR' } } },
      ],
      ...over,
    });

    test('a party proposes on a signed contract → 201, server number, draft', async () => {
      const res = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate());
      assert.equal(res.status, 201);
      assert.equal(res.body.number, '1');
      assert.equal(res.body.status, 'draft');
      const second = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate());
      assert.equal(second.body.number, '2'); // ruling 9: sequential per contract
    });

    test('validation: kind/reason/lines consistency', async () => {
      const noReason = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate({ reason: ' ' }));
      assert.equal(noReason.status, 422);
      const timeless = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate({ kind: 'time' }));
      assert.equal(timeless.status, 422); // time kind without time entries
      store.contracts.set(PRIME, contractRow(PRIME, { status: 'draft' }));
      const onDraft = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate());
      assert.equal(onDraft.status, 409);
    });

    test('a non-party never proposes → 403', async () => {
      const res = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(SUB_ORG), coCreate());
      assert.equal(res.status, 403);
    });

    test('submit is the proposer’s; the other party cannot', async () => {
      const created = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate());
      const id = created.body.id;
      assert.equal((await dispatch('POST', `/change-orders/${id}:submit`, viewer(OWNER_ORG), {})).status, 403);
      const res = await dispatch('POST', `/change-orders/${id}:submit`, viewer(GC_ORG), { note: 'p.f. analisar' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'submitted');
      assert.equal('decided_by' in res.body, false); // ruling 10: note ledgered only
    });

    test('two-sided rule: the proposer NEVER decides its own change order', async () => {
      const created = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate());
      await dispatch('POST', `/change-orders/${created.body.id}:submit`, viewer(GC_ORG), {});
      const res = await dispatch('POST', `/change-orders/${created.body.id}:approve`, viewer(GC_ORG), {});
      assert.equal(res.status, 403);
      assert.match(res.body.type, /two_sided_rule/);
    });

    test('x-human-only: approve over MCP → 403 human_only', async () => {
      const created = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate());
      await dispatch('POST', `/change-orders/${created.body.id}:submit`, viewer(GC_ORG), {});
      const res = await dispatch('POST', `/change-orders/${created.body.id}:approve`,
        viewer(OWNER_ORG, { channel: 'mcp' }), {});
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'human_only');
    });

    test('approve applies supersede + add and reports the delta', async () => {
      const created = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate());
      await dispatch('POST', `/change-orders/${created.body.id}:submit`, viewer(GC_ORG), {});
      const res = await dispatch('POST', `/change-orders/${created.body.id}:approve`, viewer(OWNER_ORG), { note: 'aprovado' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'approved');
      // replace 10×50€ with 12×50€ → +100€
      assert.deepEqual(res.body.amount_delta, { amount_cents: 10000, currency: 'EUR' });
      assert.equal(res.body.decided_by.org_id, OWNER_ORG);
      assert.equal(store.boqItems.get(BOQ_1).superseded_by_change_order_id, created.body.id);
      // a second decision on the settled CO → 409
      assert.equal((await dispatch('POST', `/change-orders/${created.body.id}:reject`, viewer(OWNER_ORG), {})).status, 409);
      // withdraw after approval → 409
      assert.equal((await dispatch('POST', `/change-orders/${created.body.id}:withdraw`, viewer(GC_ORG), {})).status, 409);
    });

    test('the ancestor view is existence-only (ruling 11): amounts ABSENT', async () => {
      // GC proposes a prime-level CO, then links a sub-level CO back-to-back
      const primeCo = await dispatch('POST', `/contracts/${PRIME}/change-orders`, viewer(GC_ORG), coCreate());
      const subCo = await dispatch('POST', `/contracts/${SUBK}/change-orders`, viewer(SUB_ORG), {
        id: uuid(), kind: 'scope', reason: 'prumadas extra',
        linked_change_order_id: primeCo.body.id,
        lines: [{ op: 'add', new_line: { id: uuid(), code: 's.2', description: 'Prumada extra', unit: 'un', quantity: '1.000', unit_price: { amount_cents: 10000, currency: 'EUR' } } }],
      });
      assert.equal(subCo.status, 201);

      // the OWNER is a party of the LINKED prime CO's contract → existence only
      const asOwner = await dispatch('GET', `/change-orders/${subCo.body.id}`, viewer(OWNER_ORG));
      assert.equal(asOwner.status, 200);
      assert.equal(asOwner.body.id, subCo.body.id);
      assert.equal('amount_delta' in asOwner.body, false);
      assert.equal('lines' in asOwner.body, false);
      assert.equal(asOwner.body._visibility.commercial, false);

      // a party reads it whole
      const asSub = await dispatch('GET', `/change-orders/${subCo.body.id}`, viewer(SUB_ORG));
      assert.equal(asSub.body.lines.length, 1);
    });

    test('an unrelated participant gets 404 on a sub CO', async () => {
      const subCo = await dispatch('POST', `/contracts/${SUBK}/change-orders`, viewer(SUB_ORG), {
        id: uuid(), kind: 'scope', reason: 'x',
        lines: [{ op: 'add', new_line: { id: uuid(), code: 's.3', description: 'y', unit: 'un', quantity: '1.000', unit_price: { amount_cents: 1, currency: 'EUR' } } }],
      });
      // no linked chain: the owner is NOT a party and learns nothing
      assert.equal((await dispatch('GET', `/change-orders/${subCo.body.id}`, viewer(OWNER_ORG))).status, 404);
    });
  });

  describe('measurements', () => {
    const mCreate = (over = {}) => ({
      id: uuid(),
      period: '2026-09',
      lines: [{ boq_item_id: BOQ_1, quantity_this_period: '3.000' }],
      ...over,
    });

    test('the supplier submits → 201 with gross/retention/net computed', async () => {
      const res = await dispatch('POST', `/contracts/${PRIME}/measurements`, viewer(GC_ORG), mCreate());
      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'submitted');
      const gross = lineAmountCents('3.000', 5000);
      assert.deepEqual(res.body.gross, { amount_cents: gross, currency: 'EUR' });
      assert.deepEqual(res.body.retention, { amount_cents: retentionCents(gross, 500), currency: 'EUR' });
      assert.equal(res.body.net.amount_cents, gross - retentionCents(gross, 500));
    });

    test('the client never measures → 403; bad period → 422', async () => {
      assert.equal((await dispatch('POST', `/contracts/${PRIME}/measurements`, viewer(OWNER_ORG), mCreate())).status, 403);
      assert.equal((await dispatch('POST', `/contracts/${PRIME}/measurements`, viewer(GC_ORG), mCreate({ period: 'setembro' }))).status, 422);
    });

    test('approve is the client’s, human-only, and mints the expected payment', async () => {
      const created = await dispatch('POST', `/contracts/${PRIME}/measurements`, viewer(GC_ORG), mCreate());
      const id = created.body.id;
      assert.equal((await dispatch('POST', `/measurements/${id}:approve`, viewer(GC_ORG))).status, 403);
      assert.equal((await dispatch('POST', `/measurements/${id}:approve`, viewer(OWNER_ORG, { channel: 'mcp' }))).status, 403);
      const res = await dispatch('POST', `/measurements/${id}:approve`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'approved');
      const payment = [...store.payments.values()][0];
      assert.equal(payment.status, 'expected');
      assert.equal(payment.amount_cents, res.body.net.amount_cents);
      assert.equal(payment.measurement_id, id);
    });

    test('dispute → disputed; a revised submission for the same period resubmits', async () => {
      const created = await dispatch('POST', `/contracts/${PRIME}/measurements`, viewer(GC_ORG), mCreate());
      const id = created.body.id;
      const disputed = await dispatch('POST', `/measurements/${id}:dispute`, viewer(OWNER_ORG), { note: 'quantidades erradas' });
      assert.equal(disputed.status, 200);
      assert.equal(disputed.body.status, 'disputed');
      const revised = await dispatch('POST', `/contracts/${PRIME}/measurements`, viewer(GC_ORG),
        mCreate({ lines: [{ boq_item_id: BOQ_1, quantity_this_period: '2.500' }] }));
      assert.equal(revised.status, 201);
      assert.equal(revised.body.status, 'submitted');
      assert.equal(revised.body.id, id); // the period is the identity
    });
  });

  describe('payments + cash-flow', () => {
    async function mintPayment(contractId, supplierViewer, clientViewer, period = '2026-09') {
      const m = await dispatch('POST', `/contracts/${contractId}/measurements`, supplierViewer, {
        id: uuid(), period,
        lines: [{ boq_item_id: contractId === PRIME ? BOQ_1 : BOQ_SUB, quantity_this_period: '2.000' }],
      });
      await dispatch('POST', `/measurements/${m.body.id}:approve`, clientViewer);
      return [...store.payments.values()].at(-1);
    }

    test('declare (client, human) → confirm (supplier, human); wrong side 403', async () => {
      const payment = await mintPayment(PRIME, viewer(GC_ORG), viewer(OWNER_ORG));
      assert.equal((await dispatch('POST', `/payments/${payment.id}:declare-paid`, viewer(GC_ORG))).status, 403);
      assert.equal((await dispatch('POST', `/payments/${payment.id}:declare-paid`, viewer(OWNER_ORG, { channel: 'mcp' }))).status, 403);
      assert.equal((await dispatch('POST', `/payments/${payment.id}:confirm`, viewer(GC_ORG))).status, 409); // not declared yet

      const declared = await dispatch('POST', `/payments/${payment.id}:declare-paid`, viewer(OWNER_ORG));
      assert.equal(declared.body.status, 'declared_paid');
      assert.equal((await dispatch('POST', `/payments/${payment.id}:confirm`, viewer(OWNER_ORG))).status, 403);
      const confirmed = await dispatch('POST', `/payments/${payment.id}:confirm`, viewer(GC_ORG));
      assert.equal(confirmed.body.status, 'confirmed');
    });

    test('dispute ⇄ re-declare (doc 09)', async () => {
      const payment = await mintPayment(PRIME, viewer(GC_ORG), viewer(OWNER_ORG));
      await dispatch('POST', `/payments/${payment.id}:declare-paid`, viewer(OWNER_ORG));
      const disputed = await dispatch('POST', `/payments/${payment.id}:dispute`, viewer(GC_ORG), { note: 'nada recebido' });
      assert.equal(disputed.body.status, 'disputed');
      const redeclared = await dispatch('POST', `/payments/${payment.id}:declare-paid`, viewer(OWNER_ORG));
      assert.equal(redeclared.body.status, 'declared_paid');
    });

    test('cash-flow is the OWNER’s; sub-level payments never appear (V3)', async () => {
      await mintPayment(PRIME, viewer(GC_ORG), viewer(OWNER_ORG));
      await mintPayment(SUBK, viewer(SUB_ORG), viewer(GC_ORG), '2026-10'); // sub-level money
      const res = await dispatch('GET', `/projects/${PROJECT}/cash-flow`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].contract_id, PRIME);
      assert.equal(res.body.items[0].supplier, 'Douro Construções');
      assert.equal(res.body.total.amount_cents, res.body.items[0].amount.amount_cents);

      assert.equal((await dispatch('GET', `/projects/${PROJECT}/cash-flow`, viewer(GC_ORG))).status, 403);
      assert.equal((await dispatch('GET', `/projects/${PROJECT}/cash-flow`,
        viewer(OWNER_ORG, { perms: [] }))).status, 403);
      assert.equal((await dispatch('GET', `/projects/${PROJECT}/cash-flow`, viewer(STRANGER_ORG))).status, 404);
    });
  });
});
