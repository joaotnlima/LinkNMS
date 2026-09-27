// The RFP personal link (gap S1) end to end through the /api/v2 router, DB-free.
// The token IS the authority: these routes carry NO viewer (security: []). The
// fake store answers only what the two public use cases read/write. Proves:
//   - GET returns the narrow package view (no issuer, no other lane, V8);
//   - an unknown / revoked / expired token is a uniform not_found (no oracle);
//   - the submit is single-use (a spent lane → already_submitted);
//   - a closed RFP refuses the bid (rfp_closed) but still shows the view;
//   - the money on the bidder's OWN proposal is visible to them.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { registerTendering } from './register.mjs';

const RFP = '01930000-0000-7000-8000-000000000001';
const PROJECT = '01930000-0000-7000-8000-000000000002';
const REC = '01930000-0000-7000-8000-000000000003';
const PROPOSAL = '01930000-0000-7000-8000-000000000004';
const BIDDER_ORG = '01930000-0000-7000-8000-000000000005';
const TASK = '01930000-0000-7000-8000-000000000006';
const ITEM = '01930000-0000-7000-8000-000000000007';
const DOC = '01930000-0000-7000-8000-000000000008';

const LIVE = 'a'.repeat(64);   // a live personal token
const SPENT = 'b'.repeat(64);  // a token whose proposal was already submitted
const OPEN_STATUS = { rfp_status: 'published' };

function fakeStore(over = {}) {
  const proposals = new Map([
    [PROPOSAL, {
      id: PROPOSAL, rfp_id: RFP, recipient_id: REC, bidder_org_id: BIDDER_ORG,
      channel: 'platform', current_revision: 0, status: 'invited',
      summary_total_cents: null, summary_duration_wd: null, summary_start: null,
      conditions: null, validity_until: null, recorded_by_person_id: null,
      document_ids: [], version: 1,
      // rfp facts getProposal joins on:
      issuer_org_id: '01930000-0000-7000-8000-0000000000ff',
      rfp_status: 'published', project_id: PROJECT, submission_deadline: '2027-06-01T00:00:00Z',
      package_version: 1, level: 'owner', parent_contract_id: null,
    }],
  ]);
  const recipientByToken = {
    [LIVE]: {
      id: REC, rfp_id: RFP, org_id: BIDDER_ORG, email: 'norte@canal.pt', status: 'sent',
      expires_at: null, revoked_at: null, title: 'Canalização', scope_text: 'Tubagem PEX',
      specialties: ['plumbing'], submission_deadline: '2027-06-01T00:00:00Z',
      rfp_status: 'published', project_id: PROJECT, package_version: 1,
      project_name: 'Casa Silva', project_location: 'Lote 12', proposal_id: PROPOSAL,
    },
  };
  const opened = [];
  const submitted = [];
  return {
    opened, submitted,
    async findRecipientByToken(raw) {
      const r = recipientByToken[raw];
      if (!r) return null;
      return { ...r, rfp_status: over.rfp_status ?? r.rfp_status };
    },
    async markRecipientOpened(id) { opened.push(id); },
    async packageOf() {
      return {
        rows: [{ task_id: TASK, parent_task_id: null, name: 'Canalização', scope_text: null, specialty: 'plumbing', position: 'aa' }],
        items: [{ id: ITEM, task_id: TASK, code: 'C1', description: 'Tubagem PEX', unit: 'm', quantity: '120.000', material_spec: null, specialty: 'plumbing' }],
      };
    },
    async getProposal(id) {
      const p = proposals.get(id);
      if (!p) return null;
      if (id === PROPOSAL && over.proposalStatus) return { ...p, status: over.proposalStatus };
      return { ...p, rfp_status: over.rfp_status ?? p.rfp_status };
    },
    async proposalDoc() { return { rows: [], links: [], lines: [] }; },
    async submitPublicProposal(args) {
      submitted.push(args);
      if (over.submitRace) return null;
      const p = proposals.get(args.proposalId);
      return {
        ...p, status: 'submitted', current_revision: args.revision,
        summary_total_cents: args.totalCents, summary_duration_wd: args.durationWd,
        conditions: args.conditions, validity_until: args.validityUntil, document_ids: args.documentIds,
      };
    },
  };
}

function makeRouter(store) {
  const router = createRouter();
  registerTendering(router, { store, contractingAward: async () => {} });
  return router;
}

const dispatch = (router, method, path, body = null) =>
  router.dispatch({ method, path, viewer: null, query: {}, body, headers: {} });

describe('RFP personal link — GET /rfp-links/{token}', () => {
  test('a live token returns the narrow package view, no issuer or other lane', async () => {
    const store = fakeStore();
    const res = await dispatch(makeRouter(store), 'GET', `/rfp-links/${LIVE}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.project.name, 'Casa Silva');
    assert.equal(res.body.project.location, 'Lote 12');
    assert.equal(res.body.rfp.title, 'Canalização');
    assert.equal(res.body.recipient_email, 'norte@canal.pt');
    assert.equal(res.body.closed, false);
    assert.equal(res.body.proposal, null, 'no proposal echoed while still invited');
    assert.equal(res.body.rfp.package.items.length, 1);
    // The view never leaks tender internals.
    assert.ok(!('issuer_org_id' in res.body.rfp), 'issuer org must be absent');
    assert.deepEqual(store.opened, [REC], 'the open was recorded');
  });

  test('an unknown token is a uniform not_found (no existence oracle)', async () => {
    const res = await dispatch(makeRouter(fakeStore()), 'GET', `/rfp-links/${'c'.repeat(64)}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'not_found');
  });

  test('closed=true once the RFP is no longer published', async () => {
    const store = fakeStore({ rfp_status: 'closed' });
    const res = await dispatch(makeRouter(store), 'GET', `/rfp-links/${LIVE}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.closed, true);
  });
});

describe('RFP personal link — POST /rfp-links/{token}/proposal', () => {
  const goodBody = {
    total: { amount_cents: 890000, currency: 'EUR' },
    duration_wd: 60, conditions: 'IVA incluído', validity_until: '2027-07-01',
    document_ids: [DOC],
  };

  test('a fresh lane accepts the bid and echoes it back with money visible', async () => {
    const store = fakeStore();
    const res = await dispatch(makeRouter(store), 'POST', `/rfp-links/${LIVE}/proposal`, goodBody);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'submitted');
    assert.deepEqual(res.body.summary.total, { amount_cents: 890000, currency: 'EUR' });
    assert.equal(store.submitted.length, 1);
    assert.equal(store.submitted[0].recipientOrgId, BIDDER_ORG);
  });

  test('a spent link answers already_submitted (single-use)', async () => {
    const store = fakeStore({ proposalStatus: 'submitted' });
    const res = await dispatch(makeRouter(store), 'POST', `/rfp-links/${LIVE}/proposal`, goodBody);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'invalid_transition');
    assert.equal(store.submitted.length, 0, 'no write attempted');
  });

  test('a closed RFP refuses the bid', async () => {
    const store = fakeStore({ rfp_status: 'closed' });
    const res = await dispatch(makeRouter(store), 'POST', `/rfp-links/${LIVE}/proposal`, goodBody);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'invalid_transition');
  });

  test('an unknown token is not_found before any validation', async () => {
    const res = await dispatch(makeRouter(fakeStore()), 'POST', `/rfp-links/${'d'.repeat(64)}/proposal`, goodBody);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'not_found');
  });

  test('a missing total is a validation_failed', async () => {
    const res = await dispatch(makeRouter(fakeStore()), 'POST', `/rfp-links/${LIVE}/proposal`,
      { duration_wd: 60 });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'validation_failed');
    assert.ok(res.body.errors.total);
  });

  test('a lost race (from moved) collapses to already_submitted', async () => {
    const store = fakeStore({ submitRace: true });
    const res = await dispatch(makeRouter(store), 'POST', `/rfp-links/${LIVE}/proposal`, goodBody);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'invalid_transition');
  });
});
