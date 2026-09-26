// Quality operations end to end through the /api/v2 router, DB-free: the
// fake store answers what pg-store would. Proves the doc-16 request flow —
// permission (token) → relationship (client chain / invited inspector /
// raiser / assignee) — the D-31 rule (never your own org's work), the
// human-only doors (verification decisions, NC close), the raiser-only
// closure, and 404-for-strangers existence hiding.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerQuality } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const SUB_ORG = '01920000-0000-7000-8000-0000000000a3';
const INSPECTOR_ORG = '01920000-0000-7000-8000-0000000000a4';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const SUBC = '01920000-0000-7000-8000-0000000000c1'; // sub contract: GC client, SUB supplier
const TASK = '01920000-0000-7000-8000-0000000000d1'; // bound to SUBC
const VR = '01920000-0000-7000-8000-0000000000e1'; // SUB reported it done
const NC = '01920000-0000-7000-8000-0000000000f1';
const NEW_ID = '01920000-0000-7000-8000-0000000000f2';
const ME = '01920000-0000-7000-8000-0000000000e9';

const QUALITY_PERMS = ['org:quality:verify', 'org:quality:inspect', 'org:progress:report'];

function pendingVerification(over = {}) {
  return {
    id: VR, task_id: TASK, task_name: 'Reboco WC', project_id: PROJECT,
    requested_by_org_id: SUB_ORG, criteria_snapshot: 'sem fissuras',
    status: 'pending', decided_by_org_id: null, decided_by_person_id: null,
    reason: null, decided_at: null,
    ...over,
  };
}

function openNc(over = {}) {
  return {
    id: NC, project_id: PROJECT, task_id: TASK, contract_id: SUBC, kind: 'quality',
    raised_by_org_id: GC_ORG, raised_by_person_id: ME, assigned_to_org_id: null,
    severity: 'major', description: 'Fissura no lintel', photo_document_ids: [],
    status: 'open', closed_by_org_id: null,
    ...over,
  };
}

function fakeStore() {
  const verifications = new Map([[VR, pendingVerification()]]);
  const ncs = new Map([[NC, openNc()]]);
  const inspections = new Map();
  const participants = new Set([OWNER_ORG, GC_ORG, SUB_ORG, INSPECTOR_ORG].map((o) => `${PROJECT}:${o}`));
  const ledger = [];
  const events = [];

  return {
    verifications, ncs, inspections, ledger, events,
    async getPersonByClerkId(id) {
      return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'me@x.pt' } : null;
    },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, status: 'active' }
        : null;
    },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed() { return false; },
    async isInvitedInspector(projectId, orgId) { return projectId === PROJECT && orgId === INSPECTOR_ORG; },
    async isProjectClient(projectId, orgId) {
      return projectId === PROJECT && (orgId === OWNER_ORG || orgId === GC_ORG);
    },
    async isClientChain(orgId, { taskId, contractId }) {
      if (orgId === OWNER_ORG) return true; // the chain tops out at the owner
      return orgId === GC_ORG && (taskId === TASK || contractId === SUBC);
    },
    async getTask(id) {
      return id === TASK
        ? { id: TASK, project_id: PROJECT, name: 'Reboco WC', contract_id: null, branch_contract_id: SUBC }
        : null;
    },
    async tasksOfProject(projectId, ids) { return new Set(ids.filter((t) => t === TASK)); },
    async getVerification(id) { return verifications.get(id) ?? null; },
    async listMyVerifications({ orgId, status }) {
      const items = [...verifications.values()]
        .filter((v) => v.status === status && v.requested_by_org_id !== orgId);
      return { items, nextCursor: null };
    },
    async decideVerification({ verificationId, status, reason, deciderOrgId, deciderPersonId }) {
      const v = verifications.get(verificationId);
      if (!v || v.status !== 'pending') return null;
      const decided = {
        ...v, status, reason, decided_by_org_id: deciderOrgId,
        decided_by_person_id: deciderPersonId, decided_at: '2026-09-25T10:00:00Z',
      };
      verifications.set(verificationId, decided);
      ledger.push(`quality.verification.${status}`);
      events.push(`quality.verification.${status}`);
      return decided;
    },
    async getNonConformity(id) { return ncs.get(id) ?? null; },
    async createNonConformity(cmd) {
      const row = openNc({
        id: cmd.id, project_id: cmd.projectId, task_id: cmd.taskId, contract_id: cmd.contractId,
        kind: cmd.kind, severity: cmd.severity, description: cmd.description,
        photo_document_ids: cmd.photoDocumentIds, assigned_to_org_id: cmd.assignedToOrgId,
        raised_by_org_id: cmd.raisedByOrgId, raised_by_person_id: cmd.raisedByPersonId,
      });
      ncs.set(cmd.id, row);
      ledger.push('quality.nonconformity.raised');
      events.push('quality.nonconformity.raised');
      return row;
    },
    async transitionNonConformity({ nonconformityId, from, to, set, eventType }) {
      const nc = ncs.get(nonconformityId);
      if (!nc || nc.status !== from) return null;
      const next = {
        ...nc, status: to,
        assigned_to_org_id: set.assignedToOrgId ?? nc.assigned_to_org_id,
        closed_by_org_id: set.closedByOrgId ?? nc.closed_by_org_id,
      };
      ncs.set(nonconformityId, next);
      ledger.push(eventType);
      events.push(eventType);
      return next;
    },
    async getInspection(id) { return inspections.get(id) ?? null; },
    async createInspection(cmd) {
      const row = {
        id: cmd.id, project_id: cmd.projectId, inspector_org_id: cmd.inspectorOrgId,
        kind: cmd.kind, date: cmd.date, checklist: cmd.checklist,
        findings: cmd.findings, task_ids: cmd.taskIds,
      };
      inspections.set(cmd.id, row);
      ledger.push('quality.inspection.recorded'); // ledger ONLY — no event
      return row;
    },
  };
}

function viewer(orgId, { role = 'manager', perms = QUALITY_PERMS, channel = 'ui' } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: orgId ? role : null,
    permissions: perms, channel,
  });
}

describe('quality over the /api/v2 router', () => {
  let router, store;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerQuality(router, { store });
  });

  const dispatch = (method, path, viewerCtx, body = null, query = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, query });

  describe('listMyVerifications', () => {
    test('a client-chain org sees the pending queue', async () => {
      const res = await dispatch('GET', '/me/verifications', viewer(GC_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].id, VR);
      assert.equal(res.body.items[0].task_name, 'Reboco WC');
      assert.deepEqual(res.body.items[0].requested_by, { org_id: SUB_ORG });
      assert.equal(res.body.next_cursor, null);
    });

    test('without org:quality:verify → 403', async () => {
      const res = await dispatch('GET', '/me/verifications', viewer(GC_ORG, { perms: [] }));
      assert.equal(res.status, 403);
    });

    test('an unknown status filter → 422', async () => {
      const res = await dispatch('GET', '/me/verifications', viewer(GC_ORG), null, { status: 'done' });
      assert.equal(res.status, 422);
    });
  });

  describe('accept / reject verification (human-only, D-31)', () => {
    test('the client of the branch contract accepts → 200 + ledger + event', async () => {
      const res = await dispatch('POST', `/verifications/${VR}:accept`, viewer(GC_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'accepted');
      assert.deepEqual(res.body.decided_by, { org_id: GC_ORG, person_id: ME });
      assert.ok(store.events.includes('quality.verification.accepted'));
    });

    test('an invited inspector accepts too', async () => {
      const res = await dispatch('POST', `/verifications/${VR}:accept`, viewer(INSPECTOR_ORG));
      assert.equal(res.status, 200);
    });

    test('D-31: the org that reported done never decides → 403', async () => {
      const res = await dispatch('POST', `/verifications/${VR}:accept`, viewer(SUB_ORG));
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'relationship');
    });

    test('x-human-only: the MCP channel never decides → 403 human_only', async () => {
      const res = await dispatch('POST', `/verifications/${VR}:accept`, viewer(GC_ORG, { channel: 'mcp' }));
      assert.equal(res.status, 403);
      assert.equal(res.body.reason, 'human_only');
      const rej = await dispatch('POST', `/verifications/${VR}:reject`, viewer(GC_ORG, { channel: 'mcp' }), { note: 'x' });
      assert.equal(rej.status, 403);
    });

    test('a participant outside the chain (the sub of ANOTHER branch) → 403', async () => {
      store.verifications.set(VR, pendingVerification({ requested_by_org_id: INSPECTOR_ORG }));
      const res = await dispatch('POST', `/verifications/${VR}:accept`, viewer(SUB_ORG));
      assert.equal(res.status, 403);
    });

    test('a stranger org gets 404, never 403', async () => {
      const res = await dispatch('POST', `/verifications/${VR}:accept`, viewer(STRANGER_ORG));
      assert.equal(res.status, 404);
    });

    test('an already-decided request → 409', async () => {
      await dispatch('POST', `/verifications/${VR}:accept`, viewer(GC_ORG));
      const res = await dispatch('POST', `/verifications/${VR}:accept`, viewer(OWNER_ORG));
      assert.equal(res.status, 409);
    });

    test('reject without a note → 422 with errors.note (DB CHECK backs it)', async () => {
      const res = await dispatch('POST', `/verifications/${VR}:reject`, viewer(GC_ORG), {});
      assert.equal(res.status, 422);
      assert.ok(res.body.errors.note);
    });

    test('reject with a note → 200, reason on the wire, event published', async () => {
      const res = await dispatch('POST', `/verifications/${VR}:reject`, viewer(GC_ORG), { note: 'fissura no canto' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'rejected');
      assert.equal(res.body.reason, 'fissura no canto');
      assert.ok(store.events.includes('quality.verification.rejected'));
    });
  });

  describe('raiseNonConformity', () => {
    const valid = { id: NEW_ID, severity: 'major', description: 'Tubo mal fixado', task_id: TASK };

    test('a participant raises → 201, contract derived from the task branch', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/nonconformities`, viewer(GC_ORG), valid);
      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'open');
      assert.equal(res.body.kind, 'quality');
      assert.equal(store.ncs.get(NEW_ID).contract_id, SUBC);
      assert.ok(store.ledger.includes('quality.nonconformity.raised'));
      assert.ok(store.events.includes('quality.nonconformity.raised'));
    });

    test('replaying the same id from the same caller answers the existing row', async () => {
      await dispatch('POST', `/projects/${PROJECT}/nonconformities`, viewer(GC_ORG), valid);
      const res = await dispatch('POST', `/projects/${PROJECT}/nonconformities`, viewer(GC_ORG), valid);
      assert.equal(res.status, 201);
      assert.equal(res.body.id, NEW_ID);
      assert.equal(store.events.filter((e) => e === 'quality.nonconformity.raised').length, 1);
    });

    test('the same id from a DIFFERENT org → 409', async () => {
      await dispatch('POST', `/projects/${PROJECT}/nonconformities`, viewer(GC_ORG), valid);
      const res = await dispatch('POST', `/projects/${PROJECT}/nonconformities`, viewer(OWNER_ORG), valid);
      assert.equal(res.status, 409);
    });

    test('missing severity/description → 422 with field errors', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/nonconformities`, viewer(GC_ORG), { id: NEW_ID });
      assert.equal(res.status, 422);
      assert.ok(res.body.errors.severity);
      assert.ok(res.body.errors.description);
    });

    test('a stranger org gets 404', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/nonconformities`, viewer(STRANGER_ORG), valid);
      assert.equal(res.status, 404);
    });
  });

  describe('non-conformity lifecycle (assign → fix → close, raiser owns closure)', () => {
    test('the raiser assigns naming the org → 200 assigned', async () => {
      const res = await dispatch('POST', `/nonconformities/${NC}:assign`, viewer(GC_ORG),
        { note: 'corrigir até sexta', assigned_to_org_id: SUB_ORG });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'assigned');
      assert.equal(res.body.assigned_to_org_id, SUB_ORG);
      assert.ok(store.events.includes('quality.nonconformity.assigned'));
    });

    test('assign with no org named anywhere → 422', async () => {
      const res = await dispatch('POST', `/nonconformities/${NC}:assign`, viewer(GC_ORG), { note: 'x' });
      assert.equal(res.status, 422);
      assert.ok(res.body.errors.assigned_to_org_id);
    });

    test('a participant that is neither raiser nor chain cannot assign → 403', async () => {
      const res = await dispatch('POST', `/nonconformities/${NC}:assign`, viewer(SUB_ORG),
        { assigned_to_org_id: SUB_ORG });
      assert.equal(res.status, 403);
    });

    test('only the ASSIGNEE org fixes; the raiser cannot → 403', async () => {
      store.ncs.set(NC, openNc({ status: 'assigned', assigned_to_org_id: SUB_ORG }));
      const raiser = await dispatch('POST', `/nonconformities/${NC}:fix`, viewer(GC_ORG), { note: 'x' });
      assert.equal(raiser.status, 403);
      const res = await dispatch('POST', `/nonconformities/${NC}:fix`, viewer(SUB_ORG), { note: 'refeito' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'fixed');
      assert.ok(store.events.includes('quality.nonconformity.fixed'));
    });

    test('fixing an open (unassigned) NC → 403 (nobody is the assignee yet)', async () => {
      const res = await dispatch('POST', `/nonconformities/${NC}:fix`, viewer(SUB_ORG), { note: 'x' });
      assert.equal(res.status, 403);
    });

    test('only the RAISING org closes, from fixed, human-only', async () => {
      store.ncs.set(NC, openNc({ status: 'fixed', assigned_to_org_id: SUB_ORG }));
      const owner = await dispatch('POST', `/nonconformities/${NC}:close`, viewer(OWNER_ORG), { note: 'x' });
      assert.equal(owner.status, 403); // in the chain, but not the raiser
      const mcp = await dispatch('POST', `/nonconformities/${NC}:close`, viewer(GC_ORG, { channel: 'mcp' }), { note: 'x' });
      assert.equal(mcp.status, 403);
      assert.equal(mcp.body.reason, 'human_only');
      const res = await dispatch('POST', `/nonconformities/${NC}:close`, viewer(GC_ORG), { note: 'conforme' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'closed');
      assert.equal(store.ncs.get(NC).closed_by_org_id, GC_ORG);
      assert.ok(store.events.includes('quality.nonconformity.closed'));
    });

    test('closing an open NC → 409 (fixed → closed only)', async () => {
      const res = await dispatch('POST', `/nonconformities/${NC}:close`, viewer(GC_ORG), { note: 'x' });
      assert.equal(res.status, 409);
    });

    test('the raiser rejects the fix → rejected_fix, then the assignee fixes again', async () => {
      store.ncs.set(NC, openNc({ status: 'fixed', assigned_to_org_id: SUB_ORG }));
      const res = await dispatch('POST', `/nonconformities/${NC}:reject-fix`, viewer(GC_ORG), { note: 'ainda fissura' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'rejected_fix');
      assert.ok(store.events.includes('quality.nonconformity.fix_rejected'));
      const again = await dispatch('POST', `/nonconformities/${NC}:fix`, viewer(SUB_ORG), { note: 'agora sim' });
      assert.equal(again.status, 200);
      assert.equal(again.body.status, 'fixed');
    });

    test('a non-raiser cannot reject the fix → 403; a stranger → 404', async () => {
      store.ncs.set(NC, openNc({ status: 'fixed', assigned_to_org_id: SUB_ORG }));
      const owner = await dispatch('POST', `/nonconformities/${NC}:reject-fix`, viewer(OWNER_ORG), { note: 'x' });
      assert.equal(owner.status, 403);
      const stranger = await dispatch('POST', `/nonconformities/${NC}:reject-fix`, viewer(STRANGER_ORG), { note: 'x' });
      assert.equal(stranger.status, 404);
    });
  });

  describe('recordInspection (ledger only — doc 10 lists no event)', () => {
    const valid = {
      id: NEW_ID, kind: 'safety', date: '2026-09-25',
      checklist: [{ item: 'EPIs', ok: true }, { item: 'Guarda-corpos', ok: false, note: 'em falta no piso 2' }],
      findings: 'Guarda-corpos em falta', task_ids: [TASK],
    };

    test('an invited inspector records → 201, ledger entry, NO outbox event', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/inspections`, viewer(INSPECTOR_ORG), valid);
      assert.equal(res.status, 201);
      assert.equal(res.body.date, '2026-09-25');
      assert.equal(res.body.checklist.length, 2);
      assert.ok(store.ledger.includes('quality.inspection.recorded'));
      assert.equal(store.events.length, 0);
    });

    test('the owner (client) records too', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/inspections`, viewer(OWNER_ORG), valid);
      assert.equal(res.status, 201);
    });

    test('an ordinary supplier participant is neither inspector nor client → 403', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/inspections`, viewer(SUB_ORG), valid);
      assert.equal(res.status, 403);
    });

    test('a bad date or foreign task ids → 422', async () => {
      const badDate = await dispatch('POST', `/projects/${PROJECT}/inspections`, viewer(INSPECTOR_ORG),
        { ...valid, date: '25/09/2026' });
      assert.equal(badDate.status, 422);
      const badTask = await dispatch('POST', `/projects/${PROJECT}/inspections`, viewer(INSPECTOR_ORG),
        { ...valid, task_ids: ['01920000-0000-7000-8000-00000000ffff'] });
      assert.equal(badTask.status, 422);
    });

    test('a stranger org gets 404', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/inspections`, viewer(STRANGER_ORG), valid);
      assert.equal(res.status, 404);
    });
  });
});
