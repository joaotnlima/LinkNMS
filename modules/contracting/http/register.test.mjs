// Contracting operations end to end through the /api/v2 router, DB-free:
// the fake store answers what pg-store would. Proves the doc-16 request flow
// — permission (token) → relationship (owner / parent supplier / party) →
// staffing — the doc-06 signature rules (manager of each org, human-only),
// and the doc-04 V2/V3 projection per viewer.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerContracting } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const SUB_ORG = '01920000-0000-7000-8000-0000000000a3';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a4';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const PRIME = '01920000-0000-7000-8000-0000000000c1';
const NEW_ID = '01920000-0000-7000-8000-0000000000c2';
const TASK = '01920000-0000-7000-8000-0000000000d1';
const ME = '01920000-0000-7000-8000-0000000000e1';

function org(id, name) {
  return { id, kind: id === OWNER_ORG ? 'household' : 'contractor', legal_name: name, nif: null };
}

function primeContract(over = {}) {
  return {
    id: PRIME, project_id: PROJECT, kind: 'prime', parent_contract_id: null,
    client_org_id: OWNER_ORG, supplier_org_id: GC_ORG, reference: 'PRIME-1',
    specialties: [], scope_inclusions: null, scope_exclusions: null,
    payment_terms: 'measurement_monthly', retention_bp: 500, payment_days: 30,
    contractual_start: null, contractual_end: null, revision: 1,
    origin: 'direct_entry', status: 'draft', sponsored_by_org_id: null, version: 1,
    ...over,
  };
}

function fakeStore() {
  const contracts = new Map([[PRIME, primeContract()]]);
  const roots = new Map([[PRIME, [TASK]]]);
  const signatures = new Map([[PRIME, []]]);
  const participants = new Set([`${PROJECT}:${OWNER_ORG}`, `${PROJECT}:${GC_ORG}`, `${PROJECT}:${SUB_ORG}`]);
  const ledger = [];
  const events = [];
  const orgs = new Map([
    [OWNER_ORG, org(OWNER_ORG, 'Família Silva')],
    [GC_ORG, org(GC_ORG, 'Douro Construções')],
    [SUB_ORG, org(SUB_ORG, 'Canalizações Norte')],
    [STRANGER_ORG, org(STRANGER_ORG, 'Alheia Lda')],
  ]);

  const bundle = (id) => {
    const c = contracts.get(id);
    if (!c) return null;
    return {
      contract: c,
      client: orgs.get(c.client_org_id),
      supplier: orgs.get(c.supplier_org_id),
      roots: roots.get(id) ?? [],
      signatures: signatures.get(id) ?? [],
      valueCents: 0,
    };
  };

  return {
    contracts, signatures, ledger, events, participants,
    async getPersonByClerkId(id) {
      return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'me@x.pt' } : null;
    },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, status: 'draft' }
        : null;
    },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed() { return false; },
    async getOrganization(id) { return orgs.get(id) ?? null; },
    async tasksOfProject(projectId, ids) { return new Set(ids.filter((t) => t === TASK)); },
    async getContract(id) { return bundle(id); },
    async listContracts(projectId) {
      const items = [...contracts.values()].filter((c) => c.project_id === projectId).map((c) => bundle(c.id));
      return { items, nextCursor: null };
    },
    async createContract(cmd) {
      contracts.set(cmd.id, primeContract({
        id: cmd.id, kind: cmd.kind, parent_contract_id: cmd.parentContractId,
        client_org_id: cmd.clientOrgId, supplier_org_id: cmd.supplierOrgId,
        reference: cmd.reference, payment_terms: cmd.paymentTerms, retention_bp: cmd.retentionBp,
      }));
      roots.set(cmd.id, cmd.rootTaskIds);
      signatures.set(cmd.id, []);
      ledger.push('contracting.contract.created');
      events.push('contracting.contract.created');
      return bundle(cmd.id);
    },
    async updateDraft({ contractId, expectedVersion, patch }) {
      const c = contracts.get(contractId);
      if (c.version !== expectedVersion) return null;
      contracts.set(contractId, {
        ...c,
        reference: patch.reference ?? c.reference,
        retention_bp: patch.retentionBp ?? c.retention_bp,
        version: c.version + 1,
      });
      if (patch.rootTaskIds) roots.set(contractId, patch.rootTaskIds);
      ledger.push('contracting.contract.updated');
      return bundle(contractId);
    },
    async addSignature({ contractId, orgId, personId, becomesSigned }) {
      signatures.get(contractId).push({ org_id: orgId, person_id: personId, signed_at: '2026-09-25T10:00:00Z' });
      ledger.push('contracting.contract.signature_added');
      if (becomesSigned) {
        const c = contracts.get(contractId);
        contracts.set(contractId, { ...c, status: 'signed', version: c.version + 1 });
        ledger.push('contracting.contract.signed');
        events.push('contracting.contract.signed');
      }
      return bundle(contractId);
    },
    async idempotent(meta, fn) { return fn(); },
  };
}

function viewer(orgId, { role = 'manager', perms = ['org:contracts:sign', 'org:money:view'], channel = 'ui' } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: orgId ? role : null,
    permissions: perms, channel,
  });
}

describe('contracting over the /api/v2 router', () => {
  let router, store;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerContracting(router, { store });
  });

  const dispatch = (method, path, viewerCtx, body = null, headers = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, headers });

  describe('createContract', () => {
    const valid = { id: NEW_ID, kind: 'direct', supplier_org_id: SUB_ORG, root_task_ids: [TASK] };

    test('owner creates a direct contract → 201, client = owner, ledger + event', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(OWNER_ORG), valid);
      assert.equal(res.status, 201);
      assert.equal(res.body.client.id, OWNER_ORG);
      assert.equal(res.body.supplier.id, SUB_ORG);
      assert.deepEqual(res.body.root_task_ids, [TASK]);
      assert.ok(res.body.reference.length > 0);
      assert.ok(store.ledger.includes('contracting.contract.created'));
    });

    test('without org:contracts:sign → 403', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(OWNER_ORG, { perms: [] }), valid);
      assert.equal(res.status, 403);
    });

    test('a non-owner participant cannot contract at owner level → 403', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(SUB_ORG), valid);
      assert.equal(res.status, 403);
    });

    test('a stranger org gets 404, never 403 (existence is not theirs to learn)', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(STRANGER_ORG), valid);
      assert.equal(res.status, 404);
    });

    test('sub contract: only the supplier of a LIVE parent → 201; client = that supplier', async () => {
      store.contracts.set(PRIME, primeContract({ status: 'signed' }));
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(GC_ORG), {
        ...valid, kind: 'sub', parent_contract_id: PRIME,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.client.id, GC_ORG);
    });

    test('sub contract under a DRAFT parent → 409', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(GC_ORG), {
        ...valid, kind: 'sub', parent_contract_id: PRIME,
      });
      assert.equal(res.status, 409);
    });

    test('sub contract by an org that is not the parent supplier → 403', async () => {
      store.contracts.set(PRIME, primeContract({ status: 'signed' }));
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(OWNER_ORG), {
        ...valid, kind: 'sub', parent_contract_id: PRIME, supplier_org_id: SUB_ORG,
      });
      assert.equal(res.status, 403);
    });

    test('client = supplier (C1) → 422', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(OWNER_ORG), {
        ...valid, supplier_org_id: OWNER_ORG,
      });
      assert.equal(res.status, 422);
    });

    test('supplier_email without an org → 422 with the documented limitation', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(OWNER_ORG), {
        id: NEW_ID, kind: 'direct', supplier_email: 'canalizador@sapo.pt', root_task_ids: [TASK],
      });
      assert.equal(res.status, 422);
      assert.match(res.body.errors.supplier_email, /supplier_org_id/);
    });

    test('root tasks must be rows of the project → 422', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/contracts`, viewer(OWNER_ORG), {
        ...valid, root_task_ids: ['01920000-0000-7000-8000-00000000ffff'],
      });
      assert.equal(res.status, 422);
    });
  });

  describe('projection on list/get (doc 04 V2/V3, §6.5)', () => {
    test('a party with org:money:view reads the full contract', async () => {
      const res = await dispatch('GET', `/projects/${PROJECT}/contracts`, viewer(GC_ORG));
      assert.equal(res.status, 200);
      const [c] = res.body.items;
      assert.equal(c._visibility, 'full');
      assert.deepEqual(c.value, { amount_cents: 0, currency: 'EUR' });
    });

    test('a party WITHOUT org:money:view gets no value field', async () => {
      const res = await dispatch('GET', `/contracts/${PRIME}`, viewer(GC_ORG, { perms: ['org:contracts:sign'] }));
      assert.equal(res.status, 200);
      assert.equal('value' in res.body, false);
      assert.equal(res.body._visibility, 'full');
    });

    test('a non-party participant sees scope only — no value, no terms (V3)', async () => {
      const res = await dispatch('GET', `/contracts/${PRIME}`, viewer(SUB_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body._visibility, 'scope');
      assert.equal('value' in res.body, false);
      assert.equal('retention_bp' in res.body, false);
    });

    test('a stranger org gets 404 on get', async () => {
      const res = await dispatch('GET', `/contracts/${PRIME}`, viewer(STRANGER_ORG));
      assert.equal(res.status, 404);
    });
  });

  describe('updateContract', () => {
    test('the client edits the draft with If-Match → 200 and version bump', async () => {
      const res = await dispatch('PATCH', `/contracts/${PRIME}`, viewer(OWNER_ORG),
        { reference: 'PRIME-1-REV', retention_bp: 1000 }, { 'if-match': '1' });
      assert.equal(res.status, 200);
      assert.equal(res.body.reference, 'PRIME-1-REV');
      assert.equal(res.body.version, 2);
    });

    test('stale If-Match → 409', async () => {
      const res = await dispatch('PATCH', `/contracts/${PRIME}`, viewer(OWNER_ORG),
        { reference: 'X' }, { 'if-match': '7' });
      assert.equal(res.status, 409);
    });

    test('the supplier does not edit the client draft → 403', async () => {
      const res = await dispatch('PATCH', `/contracts/${PRIME}`, viewer(GC_ORG),
        { reference: 'X' }, { 'if-match': '1' });
      assert.equal(res.status, 403);
    });

    test('after signature the draft edit door closes → 409', async () => {
      store.contracts.set(PRIME, primeContract({ status: 'signed' }));
      const res = await dispatch('PATCH', `/contracts/${PRIME}`, viewer(OWNER_ORG),
        { reference: 'X' }, { 'if-match': '1' });
      assert.equal(res.status, 409);
    });
  });

  describe('signContract (doc 06: manager of each org, human act)', () => {
    test('client signs, then supplier counter-signs → signed + event', async () => {
      const first = await dispatch('POST', `/contracts/${PRIME}:sign`, viewer(OWNER_ORG));
      assert.equal(first.status, 200);
      assert.equal(first.body.status, 'draft');
      assert.equal(first.body.signatures.length, 1);

      const second = await dispatch('POST', `/contracts/${PRIME}:sign`, viewer(GC_ORG));
      assert.equal(second.status, 200);
      assert.equal(second.body.status, 'signed');
      assert.ok(store.events.includes('contracting.contract.signed'));
    });

    test('the same org cannot sign twice → 409', async () => {
      await dispatch('POST', `/contracts/${PRIME}:sign`, viewer(OWNER_ORG));
      const res = await dispatch('POST', `/contracts/${PRIME}:sign`, viewer(OWNER_ORG));
      assert.equal(res.status, 409);
    });

    test('a non-party never signs → 403', async () => {
      const res = await dispatch('POST', `/contracts/${PRIME}:sign`, viewer(SUB_ORG));
      assert.equal(res.status, 403);
    });

    test('a member (not manager/admin) never signs → 403', async () => {
      const res = await dispatch('POST', `/contracts/${PRIME}:sign`, viewer(OWNER_ORG, { role: 'member' }));
      assert.equal(res.status, 403);
    });

    test('x-human-only: the MCP channel never signs → 403', async () => {
      const res = await dispatch('POST', `/contracts/${PRIME}:sign`, viewer(OWNER_ORG, { channel: 'mcp' }));
      assert.equal(res.status, 403);
    });

    test('signing a non-draft → 409', async () => {
      store.contracts.set(PRIME, primeContract({ status: 'terminated' }));
      const res = await dispatch('POST', `/contracts/${PRIME}:sign`, viewer(OWNER_ORG));
      assert.equal(res.status, 409);
    });
  });
});
