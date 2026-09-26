// Tendering operations end to end through the /api/v2 router, DB-free: the
// fake store answers what pg-store would (including the V8 filter its SQL
// applies). Proves the doc-16 request flow — permission (token) →
// relationship (issuer | recipient | author) — the V8 wall (a bidder never
// sees another lane; a mere participant sees none), the human-only doors
// (publish, award), the money gate on lanes/comparison, the award guard
// (closed or all responded) and 404-for-strangers existence hiding.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerTendering } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2'; // participant, NOT issuer/bidder
const BIDDER_ORG = '01920000-0000-7000-8000-0000000000a3';
const BIDDER2_ORG = '01920000-0000-7000-8000-0000000000a4';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const TASK = '01920000-0000-7000-8000-0000000000d1';
const RFP = '01920000-0000-7000-8000-0000000000e1';
const LANE1 = '01920000-0000-7000-8000-0000000000f1'; // BIDDER_ORG, submitted
const LANE2 = '01920000-0000-7000-8000-0000000000f2'; // BIDDER2_ORG, invited
const REC1 = '01920000-0000-7000-8000-0000000000c1';
const REC2 = '01920000-0000-7000-8000-0000000000c2';
const ITEM = '01920000-0000-7000-8000-0000000000aa';
const CLAR_OPEN = '01920000-0000-7000-8000-0000000000cc';
const NEW_ID = '01920000-0000-7000-8000-0000000000ff';
const ME = '01920000-0000-7000-8000-0000000000e9';
const FUTURE = '2027-01-15T17:00:00Z';

const ALL_PERMS = ['org:tendering:issue', 'org:tendering:bid', 'org:money:view'];

function baseRfp(over = {}) {
  return {
    id: RFP, project_id: PROJECT, issuer_org_id: OWNER_ORG, level: 'owner',
    parent_contract_id: null, root_task_ids: [TASK], title: 'Canalização',
    scope_text: null, specialties: ['plumbing'], visibility: 'invite_only',
    questions_deadline: null, submission_deadline: FUTURE,
    package_version: 1, status: 'published', awarded_proposal_id: null, version: 3,
    ...over,
  };
}

function lane1(over = {}) {
  return {
    id: LANE1, rfp_id: RFP, recipient_id: REC1, bidder_org_id: BIDDER_ORG,
    channel: 'platform', current_revision: 1, status: 'submitted',
    summary_total_cents: 760000, summary_duration_wd: 9, summary_start: '2027-02-01',
    conditions: null, validity_until: null, recorded_by_person_id: null,
    document_ids: [], version: 4, email: 'norte@canal.pt', bidder_name: 'Canalizações Norte',
    missing_lines: 0, variant_lines: 0, has_plan: true,
    ...over,
  };
}

function lane2(over = {}) {
  return {
    id: LANE2, rfp_id: RFP, recipient_id: REC2, bidder_org_id: BIDDER2_ORG,
    channel: 'platform', current_revision: 0, status: 'invited',
    summary_total_cents: null, summary_duration_wd: null, summary_start: null,
    conditions: null, validity_until: null, recorded_by_person_id: null,
    document_ids: [], version: 1, email: 'maia@hidro.pt', bidder_name: 'Hidro Maia',
    missing_lines: 1, variant_lines: 0, has_plan: false,
    ...over,
  };
}

function fakeStore() {
  const rfps = new Map([[RFP, baseRfp()]]);
  const lanes = new Map([[LANE1, lane1()], [LANE2, lane2()]]);
  const clarifications = new Map([
    [CLAR_OPEN, { id: CLAR_OPEN, rfp_id: RFP, asked_by_org_id: BIDDER_ORG, question: 'PEX ou multicamada?', answer: null, answered_at: null, status: 'open' }],
  ]);
  const docs = new Map([[LANE1, { rows: [], links: [], lines: [] }], [LANE2, { rows: [], links: [], lines: [] }]]);
  const ledger = [];
  const events = [];
  const participants = new Set([OWNER_ORG, GC_ORG, BIDDER_ORG].map((o) => `${PROJECT}:${o}`));

  const withRfpFacts = (p) => {
    const r = rfps.get(p.rfp_id);
    return {
      ...p, issuer_org_id: r.issuer_org_id, rfp_status: r.status, project_id: r.project_id,
      submission_deadline: r.submission_deadline, package_version: r.package_version,
      level: r.level, parent_contract_id: r.parent_contract_id,
    };
  };

  return {
    rfps, lanes, clarifications, ledger, events,
    async getPersonByClerkId(id) {
      return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'me@x.pt' } : null;
    },
    async getProject(id) {
      return id === PROJECT
        ? { id: PROJECT, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, status: 'tendering' }
        : null;
    },
    async isParticipant(projectId, orgId) { return participants.has(`${projectId}:${orgId}`); },
    async isStaffed() { return false; },
    async getContract() { return null; },
    async getOrganization(id) {
      if (id === BIDDER2_ORG) return { id, kind: 'contractor', legal_name: 'Hidro Maia', billing_email: 'maia@hidro.pt' };
      if (id === BIDDER_ORG) return { id, kind: 'contractor', legal_name: 'Canalizações Norte', billing_email: 'norte@canal.pt' };
      return null;
    },
    async getTask(id) {
      return id === TASK ? { id: TASK, project_id: PROJECT, name: 'Canalização' } : null;
    },
    async tasksOfProject(projectId, ids) { return new Set(ids.filter((t) => t === TASK)); },
    async branchContractsOf() { return []; },
    async snapshotPackage() {
      return {
        rows: [{ task_id: TASK, parent_task_id: null, name: 'Canalização', scope_text: null, specialty: 'plumbing', position: 'aa' }],
        items: [{ task_id: TASK, code: 'C1', description: 'Tubagem PEX', unit: 'm', quantity: '120.000', material_spec: null, specialty: 'plumbing' }],
      };
    },
    async getRfp(id) { return rfps.get(id) ?? null; },
    async packageOf() {
      return {
        rows: [{ task_id: TASK, parent_task_id: null, name: 'Canalização', scope_text: null, specialty: 'plumbing', position: 'aa' }],
        items: [{ id: ITEM, task_id: TASK, code: 'C1', description: 'Tubagem PEX', unit: 'm', quantity: '120.000', material_spec: null, specialty: 'plumbing' }],
      };
    },
    async clarificationsOf(rfpId) {
      return [...clarifications.values()].filter((c) => c.rfp_id === rfpId);
    },
    async getClarification(id) { return clarifications.get(id) ?? null; },
    async isRecipient(rfpId, orgId) {
      return rfpId === RFP && [BIDDER_ORG, BIDDER2_ORG].includes(orgId);
    },
    async recipientCount() { return 2; },
    async listRecipients() {
      return {
        items: [
          { id: REC1, org_id: BIDDER_ORG, email: 'norte@canal.pt', status: 'proposal_submitted', sent_at: null, opened_at: null },
          { id: REC2, org_id: BIDDER2_ORG, email: 'maia@hidro.pt', status: 'queued', sent_at: null, opened_at: null },
        ],
        nextCursor: null,
      };
    },
    async addRecipients({ recipients }) {
      return recipients.map((r, i) => ({
        recipient: { id: NEW_ID, org_id: r.orgId, email: r.email, status: 'queued', sent_at: null, opened_at: null },
        token: `raw-token-${i}`,
      }));
    },
    async createRfp(cmd) {
      const row = baseRfp({
        id: cmd.id, issuer_org_id: cmd.issuerOrgId, level: cmd.level,
        parent_contract_id: cmd.parentContractId, title: cmd.title, status: 'draft',
        visibility: cmd.visibility, submission_deadline: cmd.submissionDeadline, version: 1,
      });
      rfps.set(cmd.id, row);
      ledger.push('tendering.rfp.created');
      return row;
    },
    async updateRfp({ rfpId, expectedVersion, set }) {
      const r = rfps.get(rfpId);
      if (!r || r.version !== expectedVersion || r.status !== 'draft') return null;
      const next = { ...r, title: set.title ?? r.title, version: r.version + 1 };
      rfps.set(rfpId, next);
      ledger.push('tendering.rfp.updated');
      return next;
    },
    async transitionRfp({ rfpId, from, to, eventType }) {
      const r = rfps.get(rfpId);
      if (!r || r.status !== from) return null;
      const next = { ...r, status: to, version: r.version + 1 };
      rfps.set(rfpId, next);
      ledger.push(eventType);
      events.push(eventType);
      return next;
    },
    async addAddendum({ rfpId, packageVersion }) {
      const r = rfps.get(rfpId);
      const next = { ...r, package_version: packageVersion, version: r.version + 1 };
      rfps.set(rfpId, next);
      ledger.push('tendering.rfp.addendum_issued');
      events.push('tendering.rfp.addendum_issued');
      return next;
    },
    async askClarification(cmd) {
      const row = { id: cmd.id, rfp_id: cmd.rfpId, asked_by_org_id: cmd.askedByOrgId, question: cmd.question, answer: null, answered_at: null, status: 'open' };
      clarifications.set(cmd.id, row);
      ledger.push('tendering.clarification.asked');
      return row;
    },
    async answerClarification({ clarificationId, answer }) {
      const c = clarifications.get(clarificationId);
      if (!c || c.status !== 'open') return null;
      const next = { ...c, answer, status: 'answered', answered_at: '2026-09-26T10:00:00Z' };
      clarifications.set(clarificationId, next);
      ledger.push('tendering.clarification.answered');
      events.push('tendering.clarification.answered');
      return next;
    },
    async lanesForTask(taskId, { viewerOrgId }) {
      // The V8 filter EXACTLY as pg-store's SQL applies it.
      const items = [...lanes.values()].filter((p) => {
        const r = rfps.get(p.rfp_id);
        return r.root_task_ids.includes(taskId)
          && (r.issuer_org_id === viewerOrgId || p.bidder_org_id === viewerOrgId);
      });
      return { items, nextCursor: null };
    },
    async lanesOfRfp(rfpId) {
      return [...lanes.values()].filter((p) => p.rfp_id === rfpId);
    },
    async linesOfProposals(ids) {
      return ids.includes(LANE1)
        ? [{ proposal_id: LANE1, rfp_item_id: ITEM, proposal_row_id: null, is_variant: false, description: 'Tubagem PEX', unit: 'm', quantity: '120.000', unit_price_cents: 500 }]
        : [];
    },
    async rowsOfProposals(ids) {
      return ids.includes(LANE1)
        ? [{ proposal_id: LANE1, packaged_task_id: TASK, duration_wd: 9 }]
        : [];
    },
    async browseOpenRfps() { return { items: [], nextCursor: null }; },
    async listMyRfps(orgId) {
      return {
        items: [BIDDER_ORG, BIDDER2_ORG].includes(orgId) ? [rfps.get(RFP)] : [],
        nextCursor: null,
      };
    },
    async getProposal(id) {
      const p = lanes.get(id);
      return p ? withRfpFacts(p) : null;
    },
    async proposalDoc(id) { return docs.get(id) ?? { rows: [], links: [], lines: [] }; },
    async itemsOfRfp(rfpId, ids) { return new Set(ids.filter((i) => i === ITEM)); },
    async replaceProposalDoc(cmd) {
      const p = lanes.get(cmd.proposalId);
      if (!p || p.version !== cmd.expectedVersion) return null;
      const next = {
        ...p, status: cmd.status, version: p.version + 1,
        summary_total_cents: cmd.totalCents, summary_duration_wd: cmd.durationWd,
        summary_start: cmd.start, conditions: cmd.conditions,
        validity_until: cmd.validityUntil, document_ids: cmd.documentIds,
      };
      lanes.set(cmd.proposalId, next);
      docs.set(cmd.proposalId, {
        rows: cmd.rows.map((r) => ({ id: r.id, packaged_task_id: r.packagedTaskId, parent_row_id: r.parentRowId, kind: r.kind, name: r.name, duration_wd: r.durationWd, start: r.start, finish: r.finish, position: r.position })),
        links: cmd.links.map((l) => ({ predecessor_row: l.predecessorRow, successor_row: l.successorRow, from_anchor: l.fromAnchor, to_anchor: l.toAnchor, lag_wd: l.lagWd })),
        lines: cmd.lines.map((l) => ({ rfp_item_id: l.rfpItemId, proposal_row_id: l.proposalRowId, is_variant: l.isVariant, description: l.description, unit: l.unit, quantity: l.quantity, unit_price_cents: l.unitPriceCents })),
      });
      ledger.push('tendering.proposal.drafted');
      return withRfpFacts(next);
    },
    async submitProposal({ proposalId, from, revision }) {
      const p = lanes.get(proposalId);
      if (!p || p.status !== from) return null;
      const next = { ...p, status: 'submitted', current_revision: revision, version: p.version + 1 };
      lanes.set(proposalId, next);
      ledger.push('tendering.proposal.submitted');
      events.push('tendering.proposal.submitted');
      return withRfpFacts(next);
    },
    async transitionProposal({ proposalId, from, to, eventType }) {
      const p = lanes.get(proposalId);
      if (!p || p.status !== from) return null;
      const next = { ...p, status: to, version: p.version + 1 };
      lanes.set(proposalId, next);
      ledger.push(`tendering.proposal.${to}`);
      if (eventType) events.push(eventType);
      return withRfpFacts(next);
    },
    async recordOfflineProposal(cmd) {
      const p = lanes.get(cmd.proposalId);
      if (!p || p.status !== cmd.from) return null;
      const next = {
        ...p, status: 'submitted', channel: 'email', current_revision: cmd.revision,
        summary_total_cents: cmd.totalCents, summary_duration_wd: cmd.durationWd,
        summary_start: cmd.start, document_ids: cmd.documentIds,
        recorded_by_person_id: cmd.recordedByPersonId, version: p.version + 1,
      };
      lanes.set(cmd.proposalId, next);
      ledger.push('tendering.proposal.submitted');
      events.push('tendering.proposal.submitted');
      return withRfpFacts(next);
    },
    async awardRfp({ rfpId, from, winnerProposalId, declineProposalIds, createContract }) {
      const r = rfps.get(rfpId);
      if (!r || r.status !== from) return null;
      rfps.set(rfpId, { ...r, status: 'awarded', awarded_proposal_id: winnerProposalId });
      const w = lanes.get(winnerProposalId);
      lanes.set(winnerProposalId, { ...w, status: 'awarded' });
      for (const id of declineProposalIds) {
        lanes.set(id, { ...lanes.get(id), status: 'declined' });
      }
      ledger.push('tendering.rfp.awarded');
      events.push('tendering.rfp.awarded');
      return createContract({ fake: 'client' });
    },
    async idempotent(meta, fn) { return fn(); },
  };
}

function fakeContractingAward(client, { rfp, winner }) {
  return {
    contract: {
      id: '01920000-0000-7000-8000-00000000cccc', project_id: rfp.project_id,
      kind: 'direct', parent_contract_id: null, client_org_id: rfp.issuer_org_id,
      supplier_org_id: winner.bidder_org_id, reference: 'CTR-TEST', specialties: rfp.specialties,
      payment_terms: 'measurement_monthly', retention_bp: 500, payment_days: 30,
      contractual_start: null, contractual_end: null, revision: 1,
      origin: 'award', origin_proposal_id: winner.id, status: 'draft',
      sponsored_by_org_id: null, version: 1,
    },
    client: { id: rfp.issuer_org_id, kind: 'household', legal_name: 'Família Silva' },
    supplier: { id: winner.bidder_org_id, kind: 'contractor', legal_name: 'Canalizações Norte' },
    roots: rfp.root_task_ids,
    valueCents: 760000,
  };
}

function viewer(orgId, { role = 'manager', perms = ALL_PERMS, channel = 'ui' } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: orgId ? role : null,
    permissions: perms, channel,
  });
}

describe('tendering over the /api/v2 router', () => {
  let router, store;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerTendering(router, { store, contractingAward: fakeContractingAward });
  });

  const dispatch = (method, path, viewerCtx, body = null, query = {}, headers = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, query, headers });

  describe('createRfp', () => {
    const create = { id: NEW_ID, root_task_ids: [TASK], title: 'Eletricidade', submission_deadline: FUTURE };

    test('the owner creates at owner level → 201 draft', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/rfps`, viewer(OWNER_ORG), create);
      assert.equal(res.status, 201);
      assert.equal(res.body.level, 'owner');
      assert.equal(res.body.status, 'draft');
      assert.ok(store.ledger.includes('tendering.rfp.created'));
    });

    test('without org:tendering:issue → 403', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/rfps`, viewer(OWNER_ORG, { perms: [] }), create);
      assert.equal(res.status, 403);
    });

    test('a participant whose rows are not in its branch → 403', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/rfps`, viewer(GC_ORG), create);
      assert.equal(res.status, 403);
    });

    test('a stranger → 404 (never learns the project exists)', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/rfps`, viewer(STRANGER_ORG), create);
      assert.equal(res.status, 404);
    });
  });

  describe('getRfp (issuer | recipient; V8 on clarifications)', () => {
    test('the issuer sees the package and OPEN questions', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.package.items.length, 1);
      assert.equal(res.body.clarifications.length, 1);
      // the asker is NEVER on the wire, even for the issuer
      assert.equal(res.body.clarifications[0].asked_by_org_id, undefined);
    });

    test('a bidder does NOT see another bidder’s open question', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}`, viewer(BIDDER2_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.clarifications.length, 0);
    });

    test('a participant that was not invited → 404', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}`, viewer(GC_ORG));
      assert.equal(res.status, 404);
    });
  });

  describe('publish / close / cancel', () => {
    test('publish is human-only: MCP channel → 403', async () => {
      store.rfps.set(RFP, baseRfp({ status: 'draft' }));
      const res = await dispatch('POST', `/rfps/${RFP}:publish`, viewer(OWNER_ORG, { channel: 'mcp' }));
      assert.equal(res.status, 403);
    });

    test('publish a draft → 200 published + event', async () => {
      store.rfps.set(RFP, baseRfp({ status: 'draft' }));
      const res = await dispatch('POST', `/rfps/${RFP}:publish`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'published');
      assert.ok(store.events.includes('tendering.rfp.published'));
    });

    test('close a published RFP → 200 closed', async () => {
      const res = await dispatch('POST', `/rfps/${RFP}:close`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'closed');
    });

    test('cancel an awarded RFP → 409', async () => {
      store.rfps.set(RFP, baseRfp({ status: 'awarded' }));
      const res = await dispatch('POST', `/rfps/${RFP}:cancel`, viewer(OWNER_ORG));
      assert.equal(res.status, 409);
    });
  });

  describe('recipients', () => {
    test('addRecipients returns the personal token ONCE', async () => {
      const res = await dispatch('POST', `/rfps/${RFP}/recipients`, viewer(OWNER_ORG), {
        recipients: [{ email: 'novo@sub.pt' }],
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.items[0].token, 'raw-token-0');
    });

    test('listRecipients is issuer-only: a bidder → 404', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}/recipients`, viewer(BIDDER_ORG));
      assert.equal(res.status, 404);
    });
  });

  describe('clarifications', () => {
    test('a recipient asks → 201; a non-recipient → 404', async () => {
      const ok = await dispatch('POST', `/rfps/${RFP}/clarifications`, viewer(BIDDER2_ORG), {
        id: NEW_ID, question: 'Contadores incluídos?',
      });
      assert.equal(ok.status, 201);
      const no = await dispatch('POST', `/rfps/${RFP}/clarifications`, viewer(GC_ORG), {
        id: NEW_ID, question: 'posso?',
      });
      assert.equal(no.status, 404);
    });

    test('the issuer answers → 200, published to all, asker still hidden', async () => {
      const res = await dispatch('POST', `/clarifications/${CLAR_OPEN}:answer`, viewer(OWNER_ORG), { answer: 'PEX.' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'answered');
      assert.equal(res.body.asked_by_org_id, undefined);
      assert.ok(store.events.includes('tendering.clarification.answered'));
    });
  });

  describe('lanes (V8) + money gate', () => {
    test('the issuer sees every lane', async () => {
      const res = await dispatch('GET', `/tasks/${TASK}/proposal-lanes`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 2);
    });

    test('a bidder sees ONLY its own lane', async () => {
      const res = await dispatch('GET', `/tasks/${TASK}/proposal-lanes`, viewer(BIDDER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].proposal_id, LANE1);
    });

    test('a participant that is neither sees NONE', async () => {
      const res = await dispatch('GET', `/tasks/${TASK}/proposal-lanes`, viewer(GC_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 0);
    });

    test('without org:money:view the lane total is ABSENT, not null', async () => {
      const res = await dispatch('GET', `/tasks/${TASK}/proposal-lanes`,
        viewer(OWNER_ORG, { perms: ['org:tendering:issue'] }));
      assert.equal(res.status, 200);
      assert.ok(!('total' in res.body.items.find((l) => l.proposal_id === LANE1)));
    });

    test('getProposal: another bidder’s lane → 404', async () => {
      const res = await dispatch('GET', `/proposals/${LANE1}`, viewer(BIDDER2_ORG));
      assert.equal(res.status, 404);
    });
  });

  describe('putProposal / submit / withdraw', () => {
    const doc = {
      rows: [{ id: NEW_ID, packaged_task_id: TASK, name: 'Canalização', duration_wd: 9, start: '2027-02-01', finish: '2027-02-12' }],
      links: [],
      lines: [{ rfp_item_id: ITEM, description: 'Tubagem PEX', unit: 'm', quantity: '120', unit_price: { amount_cents: 500, currency: 'EUR' } }],
    };

    test('the author replaces its plan (If-Match) → 200, total derived', async () => {
      store.lanes.set(LANE2, lane2({ status: 'invited' }));
      const res = await dispatch('PUT', `/proposals/${LANE2}`, viewer(BIDDER2_ORG), doc, {}, { 'if-match': '1' });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'draft');
      assert.equal(res.body.summary.total.amount_cents, 60000);
    });

    test('without If-Match → 422; stale If-Match → 409', async () => {
      const missing = await dispatch('PUT', `/proposals/${LANE2}`, viewer(BIDDER2_ORG), doc);
      assert.equal(missing.status, 422);
      const stale = await dispatch('PUT', `/proposals/${LANE2}`, viewer(BIDDER2_ORG), doc, {}, { 'if-match': '9' });
      assert.equal(stale.status, 409);
    });

    test('the ISSUER cannot write in a lane → 403', async () => {
      const res = await dispatch('PUT', `/proposals/${LANE2}`, viewer(OWNER_ORG), doc, {}, { 'if-match': '1' });
      assert.equal(res.status, 403);
    });

    test('submit bumps the revision and notifies the issuer', async () => {
      store.lanes.set(LANE2, lane2({ status: 'draft', summary_total_cents: 60000 }));
      const res = await dispatch('POST', `/proposals/${LANE2}:submit`, viewer(BIDDER2_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'submitted');
      assert.equal(res.body.revision, 1);
      assert.ok(store.events.includes('tendering.proposal.submitted'));
    });

    test('an unpriced platform proposal cannot submit → 422', async () => {
      store.lanes.set(LANE2, lane2({ status: 'draft', summary_total_cents: null }));
      const res = await dispatch('POST', `/proposals/${LANE2}:submit`, viewer(BIDDER2_ORG));
      assert.equal(res.status, 422);
    });

    test('withdraw before award → 200', async () => {
      const res = await dispatch('POST', `/proposals/${LANE1}:withdraw`, viewer(BIDDER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'withdrawn');
    });
  });

  describe('recordOfflineProposal', () => {
    const offline = { document_ids: [NEW_ID], total: { amount_cents: 890000, currency: 'EUR' }, duration_wd: 12 };

    test('the issuer records an emailed answer → 200, channel email', async () => {
      const res = await dispatch('POST', `/proposals/${LANE2}:record-offline`, viewer(OWNER_ORG), offline);
      assert.equal(res.status, 200);
      assert.equal(res.body.channel, 'email');
      assert.equal(res.body.status, 'submitted');
    });

    test('a bidder cannot record-offline → 403', async () => {
      const res = await dispatch('POST', `/proposals/${LANE2}:record-offline`, viewer(BIDDER2_ORG), offline);
      assert.equal(res.status, 403);
    });
  });

  describe('comparison (money gate) + shortlist', () => {
    test('the issuer with org:money:view gets the matrix', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}/comparison`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items[0].prices[LANE1].amount_cents, 500);
      assert.equal(res.body.items[0].median.amount_cents, 500);
      assert.equal(res.body.proposals.length, 1); // only submitted+ lanes
    });

    test('without org:money:view → 403 even for the issuer', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}/comparison`,
        viewer(OWNER_ORG, { perms: ['org:tendering:issue'] }));
      assert.equal(res.status, 403);
    });

    test('shortlist a submitted lane → 200', async () => {
      const res = await dispatch('POST', `/proposals/${LANE1}:shortlist`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'shortlisted');
    });
  });

  describe('awardRfp (human-only; guard: closed or all responded)', () => {
    test('published with an unanswered invite → 409', async () => {
      const res = await dispatch('POST', `/rfps/${RFP}:award`, viewer(OWNER_ORG), { proposal_id: LANE1 });
      assert.equal(res.status, 409);
    });

    test('closed → 201 Contract; losers declined; winner awarded', async () => {
      store.rfps.set(RFP, baseRfp({ status: 'closed' }));
      store.lanes.set(LANE2, lane2({ status: 'submitted', summary_total_cents: 890000 }));
      const res = await dispatch('POST', `/rfps/${RFP}:award`, viewer(OWNER_ORG), { proposal_id: LANE1 });
      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'draft');
      assert.equal(res.body.supplier.id, BIDDER_ORG);
      assert.equal(res.body.value.amount_cents, 760000);
      assert.equal(store.lanes.get(LANE1).status, 'awarded');
      assert.equal(store.lanes.get(LANE2).status, 'declined');
      assert.ok(store.events.includes('tendering.rfp.awarded'));
    });

    test('published but every invitee responded → allowed', async () => {
      store.lanes.set(LANE2, lane2({ status: 'declined' }));
      const res = await dispatch('POST', `/rfps/${RFP}:award`, viewer(OWNER_ORG), { proposal_id: LANE1 });
      assert.equal(res.status, 201);
    });

    test('MCP channel → 403 (human-only)', async () => {
      store.rfps.set(RFP, baseRfp({ status: 'closed' }));
      const res = await dispatch('POST', `/rfps/${RFP}:award`, viewer(OWNER_ORG, { channel: 'mcp' }), { proposal_id: LANE1 });
      assert.equal(res.status, 403);
    });

    test('awarding an invited (no answer) lane → 409', async () => {
      store.rfps.set(RFP, baseRfp({ status: 'closed' }));
      const res = await dispatch('POST', `/rfps/${RFP}:award`, viewer(OWNER_ORG), { proposal_id: LANE2 });
      assert.equal(res.status, 409);
    });

    test('without org:money:view the 201 has no value field', async () => {
      store.rfps.set(RFP, baseRfp({ status: 'closed' }));
      store.lanes.set(LANE2, lane2({ status: 'declined' }));
      const res = await dispatch('POST', `/rfps/${RFP}:award`,
        viewer(OWNER_ORG, { perms: ['org:tendering:issue'] }), { proposal_id: LANE1 });
      assert.equal(res.status, 201);
      assert.ok(!('value' in res.body));
    });
  });

  describe('discovery', () => {
    test('listMyRfps shows the bidder its invitations', async () => {
      const res = await dispatch('GET', '/me/rfps', viewer(BIDDER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 1);
    });

    test('browseOpenRfps needs org:tendering:bid', async () => {
      const res = await dispatch('GET', '/marketplace/rfps', viewer(GC_ORG, { perms: [] }));
      assert.equal(res.status, 403);
    });
  });
});
