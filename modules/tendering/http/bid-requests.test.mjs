// PRD-04 through the /api/v2 router, DB-free: ask to bid (D-47), the issuer's
// decisions, the company inbox, and adding a directory company to an RFP. The
// fake store answers what pg-bid-requests.mjs would; the directory and build
// ports are fakes of their published shapes.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerTendering } from './register.mjs';
import { createInMemoryIdempotency } from '../../../platform/idempotency.mjs';
import { matchOpenRequest } from '../domain/bid-requests.mjs';

const OWNER = '01920000-0000-7000-8000-0000000000a1';
const ROOFER = '01920000-0000-7000-8000-0000000000a2';
const OTHER = '01920000-0000-7000-8000-0000000000a3';
const UNCLAIMED = '01920000-0000-7000-8000-0000000000a4';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const FAR_PROJECT = '01920000-0000-7000-8000-0000000000b2';
const RFP = '01920000-0000-7000-8000-0000000000e1';
const FAR_RFP = '01920000-0000-7000-8000-0000000000e2';
const ME = '01920000-0000-7000-8000-0000000000e9';
const FUTURE = '2099-01-15T17:00:00Z';
// The build's point recorded on each RFP when it was published (0030).
const LISTING = {
  [RFP]: { municipality_code: '1111', lat: 38.8029, lng: -9.3817 },
  [FAR_RFP]: { municipality_code: '1312', lat: 41.1579, lng: -8.6291 },
};

function viewer(orgId, { perms = ['org:tendering:issue', 'org:tendering:bid'] } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions: perms, channel: 'ui',
  });
}

function fakeStore() {
  const rfps = new Map([
    [RFP, { id: RFP, project_id: PROJECT, issuer_org_id: OWNER, level: 'owner', title: 'Roofing', listed: true,
      visibility: 'open', status: 'published', submission_deadline: FUTURE, specialty_codes: ['roofing-tiled'],
      root_task_ids: [], package_version: 1, version: 2, task_count: 10 }],
    [FAR_RFP, { id: FAR_RFP, project_id: FAR_PROJECT, issuer_org_id: OWNER, level: 'sub', title: 'Far roofing', listed: true,
      visibility: 'open', status: 'published', submission_deadline: FUTURE, specialty_codes: ['roofing'],
      root_task_ids: [], package_version: 1, version: 2, task_count: 2 }],
  ]);
  const requests = new Map();
  const recipients = [];
  const sent = [];
  const events = [];
  return {
    idempotent: createInMemoryIdempotency(),
    rfps, requests, recipients, sent, events,
    async getPersonByClerkId() { return { id: ME }; },
    async isStaffed() { return true; },
    async getRfp(id) { return rfps.get(id) ?? null; },
    async isRecipient(rfpId, orgId) { return recipients.some((r) => r.rfp_id === rfpId && r.org_id === orgId); },
    async getOrganization(id) {
      if (id === ROOFER) return { id, legal_name: 'Telhados do Norte', billing_email: 'Geral@Telhados.pt' };
      if (id === OTHER) return { id, legal_name: 'Coberturas Vale', contact_email: 'vale@coberturas.pt' };
      return null;
    },
    async createBidRequest({ id, rfpId, orgId }) {
      const existing = [...requests.values()].find((r) => r.rfp_id === rfpId && r.org_id === orgId);
      if (existing) return { request: existing, created: false };
      const row = { id, rfp_id: rfpId, org_id: orgId, status: 'pending', requested_at: '2026-12-01T10:00:00Z', decided_at: null };
      requests.set(id, row);
      events.push('tendering.bid_request.requested');
      return { request: row, created: true };
    },
    async getBidRequest(id) {
      const r = requests.get(id);
      if (!r) return null;
      const rfp = rfps.get(r.rfp_id);
      return { ...r, project_id: rfp.project_id, issuer_org_id: rfp.issuer_org_id, rfp_status: rfp.status };
    },
    async listBidRequests(rfpId) { return { items: [...requests.values()].filter((r) => r.rfp_id === rfpId), nextCursor: null }; },
    async approveBidRequest({ requestId, rfpId, orgId, email }) {
      const r = requests.get(requestId);
      if (r.status !== 'pending') return null;
      const recipient = { id: `rec-${orgId}`, rfp_id: rfpId, org_id: orgId, email, source: 'asked_to_bid', status: 'queued' };
      recipients.push(recipient);
      Object.assign(r, { status: 'approved', decided_at: '2026-12-02T10:00:00Z', decided_by_person_id: ME, recipient_id: recipient.id });
      events.push('tendering.bid_request.approved');
      return { request: r, recipient, token: 't'.repeat(64) };
    },
    async declineBidRequest({ requestId }) {
      const r = requests.get(requestId);
      if (r.status !== 'pending') return null;
      Object.assign(r, { status: 'declined', decided_at: '2026-12-02T10:00:00Z', decided_by_person_id: ME });
      events.push('tendering.bid_request.declined');
      return r;
    },
    async markRecipientSent({ recipientId }) {
      const rec = recipients.find((r) => r.id === recipientId);
      rec.status = 'sent';
      return rec;
    },
    // What pg-bid-requests.mjs openRequestsFor answers, emulated with the
    // domain's rule over the point recorded on the RFP at publication (0030).
    async openRequestsFor({ orgId, family, base, radiusKm, areas, cursor, limit }) {
      const profile = { specialty_family: family, base, radius_km: radiusKm, service_areas: areas };
      const all = [...rfps.values()]
        .filter((r) => r.listed && r.issuer_org_id !== orgId && !recipients.some((x) => x.rfp_id === r.id && x.org_id === orgId))
        .map((r) => ({ r, m: matchOpenRequest({ specialtyCodes: r.specialty_codes }, LISTING[r.id], profile) }))
        .filter(({ m }) => m.match)
        .map(({ r, m }) => ({ ...r, distance_km: m.distance_km }))
        .sort((a, b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9) || a.id.localeCompare(b.id));
      const from = cursor ? all.findIndex((r) => r.id === cursor.id) + 1 : 0;
      const items = all.slice(from, from + limit);
      return { items, nextCursor: all.length > from + limit ? { k: '0', d: FUTURE, id: items.at(-1).id } : null };
    },
    async bidRequestsOfOrg(orgId, ids) { return [...requests.values()].filter((r) => r.org_id === orgId && ids.includes(r.rfp_id)); },
    async requestsForOrg(orgId) {
      const items = recipients.filter((r) => r.org_id === orgId).map((rec) => {
        const rfp = rfps.get(rec.rfp_id);
        return {
          recipient_id: rec.id, rfp_id: rfp.id, source: rec.source, recipient_status: rec.status, title: rfp.title,
          level: rfp.level, project_id: rfp.project_id, rfp_status: rfp.status, submission_deadline: rfp.submission_deadline,
          task_count: rfp.task_count, file_count: 0, proposal_id: 'lane', proposal_status: rec.lane_status ?? 'invited',
          created_at: '2026-12-02T10:00:00Z', received_at: '2026-12-02T10:00:00Z',
        };
      });
      return { items, nextCursor: null };
    },
    async invitationOf(rfpId, orgId) {
      const rec = recipients.find((r) => r.rfp_id === rfpId && r.org_id === orgId);
      return rec ? { ...rec, lane_status: rec.lane_status ?? 'invited' } : null;
    },
    async declineInvitation({ recipientId }) {
      recipients.find((r) => r.id === recipientId).status = 'declined';
      return true;
    },
    async requestForOrg(rfpId, orgId) {
      return (await this.requestsForOrg(orgId)).items.find((i) => i.rfp_id === rfpId) ?? null;
    },
    async addRecipients({ rfpId, recipients: list }) {
      return list.map((r, i) => {
        const recipient = { id: `new-${i}`, rfp_id: rfpId, org_id: r.orgId, email: r.email, source: r.source, company_name: r.companyName, status: 'queued' };
        recipients.push(recipient);
        return { recipient, token: null };
      });
    },
  };
}

const directory = {
  async contactOf(id) {
    if (id === ROOFER) return { org_id: ROOFER, claimed: true, display_name: 'Telhados do Norte' };
    if (id === UNCLAIMED) return { org_id: UNCLAIMED, claimed: false, display_name: 'Silva Roofing', email: 'obra@silva-roofing.pt' };
    return null;
  },
  async proofsOf(ids, { near }) {
    return ids.map((id) => ({ org_id: id, display_name: `Co ${id.slice(-2)}`, slug: 'co', claimed: true,
      verified_clients: 3, builds: 3, tasks_finished: 5, tasks_on_time: 5, ...(near ? { distance_km: 6 } : {}) }));
  },
  async biddingProfileOf(orgId) {
    if (orgId === OTHER) return null;
    return { listed: true, specialty_family: ['roofing', 'roofing-tiled'], base: { lat: 38.7569, lng: -9.2745 }, radius_km: 40, service_areas: [] };
  },
};
const builds = {
  async factsOf(ids) {
    const all = {
      [PROJECT]: { project_id: PROJECT, name: 'Casa da Encosta', municipality_code: '1111', lat: 38.8029, lng: -9.3817 },
      [FAR_PROJECT]: { project_id: FAR_PROJECT, name: 'Casa no Porto', municipality_code: '1312', lat: 41.1579, lng: -8.6291 },
    };
    return ids.map((id) => all[id]).filter(Boolean);
  },
};

describe('PRD-04 over the /api/v2 router', () => {
  let router, store, mails;
  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    mails = [];
    registerTendering(router, {
      store, directory, builds, linkBaseUrl: 'https://portal.test',
      mailSender: { async send(m) { mails.push(m); return { id: 'msg-1' }; } },
    });
  });
  const call = (method, path, v, body = null, query = {}) => router.dispatch({ method, path, viewer: v, body, query, headers: {} });

  test('ask → pending, no lane; the issuer lists it with proof lines measured from the build', async () => {
    const asked = await call('POST', `/rfps/${RFP}:apply`, viewer(ROOFER));
    assert.equal(asked.status, 201);
    assert.equal(store.recipients.length, 0);
    const list = await call('GET', `/rfps/${RFP}/bid-requests`, viewer(OWNER));
    assert.equal(list.status, 200);
    assert.equal(list.body.items[0].status, 'pending');
    assert.equal(list.body.items[0].company.verified_clients, 3);
    assert.equal(list.body.items[0].company.distance_km, 6);
    // V8: the asking company is not the issuer.
    assert.equal((await call('GET', `/rfps/${RFP}/bid-requests`, viewer(ROOFER))).status, 404);
  });

  test('approve → the lane exists (asked_to_bid) and its link is e-mailed; deciding twice → 409', async () => {
    const { body: req } = await call('POST', `/rfps/${RFP}:apply`, viewer(ROOFER));
    const res = await call('POST', `/bid-requests/${req.id}:approve`, viewer(OWNER));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'approved');
    assert.ok(res.body.recipient_id);
    assert.equal(store.recipients[0].source, 'asked_to_bid');
    assert.equal(store.recipients[0].email, 'geral@telhados.pt');
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'geral@telhados.pt');
    assert.ok(store.events.includes('tendering.bid_request.approved'));
    assert.equal((await call('POST', `/bid-requests/${req.id}:decline`, viewer(OWNER))).status, 409);
  });

  test('Idempotency-Key: ask, approve and decline replay their first answer (audit B1)', async () => {
    const keyed = (method, path, v, key) => router.dispatch({ method, path, viewer: v, body: null, query: {}, headers: { 'idempotency-key': key } });
    const asked = await keyed('POST', `/rfps/${RFP}:apply`, viewer(ROOFER), 'k-ask');
    const askedAgain = await keyed('POST', `/rfps/${RFP}:apply`, viewer(ROOFER), 'k-ask');
    assert.deepEqual([asked.status, askedAgain.status], [201, 201]); // the replay answers 201, not "already asked" 200
    assert.deepEqual(askedAgain.body, asked.body);
    const approved = await keyed('POST', `/bid-requests/${asked.body.id}:approve`, viewer(OWNER), 'k-approve');
    const approvedAgain = await keyed('POST', `/bid-requests/${asked.body.id}:approve`, viewer(OWNER), 'k-approve');
    assert.deepEqual([approved.status, approvedAgain.status], [200, 200]); // not 409 "already decided"
    assert.deepEqual(approvedAgain.body, approved.body);
    assert.equal(mails.length, 1, 'one link e-mailed');
    assert.equal(store.recipients.length, 1);
    const declined = await keyed('POST', `/rfps/${RFP}/invitation:decline`, viewer(ROOFER), 'k-decl');
    const declinedAgain = await keyed('POST', `/rfps/${RFP}/invitation:decline`, viewer(ROOFER), 'k-decl');
    assert.deepEqual(declinedAgain.body, declined.body);
  });

  test('decline → declined, no lane, no mail; only the issuer decides', async () => {
    const { body: req } = await call('POST', `/rfps/${RFP}:apply`, viewer(ROOFER));
    assert.equal((await call('POST', `/bid-requests/${req.id}:decline`, viewer(ROOFER))).status, 404);
    const res = await call('POST', `/bid-requests/${req.id}:decline`, viewer(OWNER));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'declined');
    assert.equal(store.recipients.length, 0);
    assert.equal(mails.length, 0);
  });

  test('open requests near you: matched on specialty + area, nearest first, with my request', async () => {
    await call('POST', `/rfps/${RFP}:apply`, viewer(ROOFER));
    const res = await call('GET', '/me/open-requests', viewer(ROOFER));
    assert.equal(res.status, 200);
    assert.equal(res.body.profile_missing, false);
    assert.deepEqual(res.body.items.map((i) => i.rfp_id), [RFP]); // the Porto build is beyond 40 km
    assert.equal(res.body.items[0].build.name, 'Casa da Encosta');
    assert.equal(res.body.items[0].my_request.status, 'pending');
    assert.equal(res.body.items[0].build.lat, undefined);
    const none = await call('GET', '/me/open-requests', viewer(OTHER));
    assert.deepEqual(none.body, { items: [], next_cursor: null, profile_missing: true });
    assert.equal(res.body.next_cursor, null);
    assert.equal((await call('GET', '/me/open-requests', viewer(ROOFER), null, { cursor: 'nope' })).status, 422);
  });

  test('requests for you: origin and counts; decline the invitation', async () => {
    const { body: req } = await call('POST', `/rfps/${RFP}:apply`, viewer(ROOFER));
    await call('POST', `/bid-requests/${req.id}:approve`, viewer(OWNER));
    const res = await call('GET', '/me/rfp-requests', viewer(ROOFER));
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].origin, 'asked_to_bid');
    assert.equal(res.body.items[0].task_count, 10);
    assert.equal(res.body.items[0].build.name, 'Casa da Encosta');
    const declined = await call('POST', `/rfps/${RFP}/invitation:decline`, viewer(ROOFER));
    assert.equal(declined.status, 200);
    assert.equal(declined.body.invitation_status, 'declined');
    assert.equal((await call('POST', `/rfps/${FAR_RFP}/invitation:decline`, viewer(ROOFER))).status, 404);
    assert.equal((await call('GET', '/me/rfp-requests', viewer(ROOFER, { perms: [] }))).status, 403);
  });

  test('add from the directory: a claimed profile is its org, an unclaimed one its e-mail; both source directory', async () => {
    store.rfps.set(RFP, { ...store.rfps.get(RFP), status: 'draft' });
    const res = await call('POST', `/rfps/${RFP}/recipients`, viewer(OWNER),
      { recipients: [{ company_id: ROOFER }, { company_id: UNCLAIMED }, { email: 'Obra@Amigo.pt' }] });
    assert.equal(res.status, 201);
    const [claimed, unclaimed, typed] = res.body.items;
    assert.deepEqual([claimed.source, claimed.org_id, claimed.company_name], ['directory', ROOFER, 'Telhados do Norte']);
    assert.deepEqual([unclaimed.source, unclaimed.org_id, unclaimed.email, unclaimed.company_name],
      ['directory', undefined, 'obra@silva-roofing.pt', 'Silva Roofing']);
    assert.deepEqual([typed.source, typed.email], ['email', 'obra@amigo.pt']);
    const bad = await call('POST', `/rfps/${RFP}/recipients`, viewer(OWNER), { recipients: [{ company_id: OTHER }] });
    assert.equal(bad.status, 422);
    const mixed = await call('POST', `/rfps/${RFP}/recipients`, viewer(OWNER), { recipients: [{ company_id: ROOFER, email: 'x@y.pt' }] });
    assert.equal(mixed.status, 422);
  });
});

describe('PRD-04 X-6: ask candidates over the /api/v2 router (audit S4a)', () => {
  test('one read: the build rows ranked on the company family, each with its target; 422 without a company', async () => {
    const router = createRouter();
    const store = {
      async getPersonByClerkId() { return { id: ME }; },
      async getProject(id) { return id === PROJECT ? { id, owner_org_id: OWNER } : null; },
      async isParticipant() { return false; },
      async isStaffed() { return true; },
      async taskProcurementOfProject() {
        return { items: [{ task_id: 'roof', id: RFP, title: 'Roof', status: 'draft', created_at: '2026-10-01T00:00:00Z', root_task_ids: ['roof'], lane_counts: { invited: 2 } }], nextTaskId: null };
      },
    };
    const planning = {
      async tasksOf() {
        return [
          { id: 'found', code: '1', name: 'Foundations', kind: 'task', specialty_code: 'structure' },
          { id: 'roof', code: '2', name: 'Roof', kind: 'task', specialty_code: 'roofing-tiled' },
        ];
      },
    };
    registerTendering(router, { store, directory, planning });
    const call = (query) => router.dispatch({ method: 'GET', path: `/projects/${PROJECT}/ask-candidates`, viewer: viewer(OWNER), body: null, query, headers: {} });
    const res = await call({ company_id: ROOFER });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((t) => [t.task_id, t.specialty_match, t.target.kind]), [['roof', true, 'draft'], ['found', false, 'new']]);
    assert.deepEqual(res.body.items[0].rfp, { id: RFP, title: 'Roof', status: 'draft', invited_count: 2 });
    assert.equal((await call({})).status, 422);
    assert.equal((await router.dispatch({ method: 'GET', path: `/projects/${FAR_PROJECT}/ask-candidates`, viewer: viewer(OWNER), body: null, query: { company_id: ROOFER }, headers: {} })).status, 404);
  });
});
