// Directory operations end to end through the /api/v2 router, DB-free: an
// in-memory store answers what pg-store would. Proves the public reads with a
// null viewer, the D-46 order at the API, impressions/views never counted for
// the viewer's own org, the company-side gate (own org ∧ org:profile:manage,
// households refused), If-Match on profile edits, the claim path (e-mail
// control, single use, same org), and the owner-only consent through the
// project build port.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { ProblemError } from '../../../platform/errors.mjs';
import { registerDirectory } from './register.mjs';

const ROOFER = '01920000-0000-7000-8000-0000000000a1';
const OWNER = '01920000-0000-7000-8000-0000000000a2';
const UNCLAIMED = '01920000-0000-7000-8000-0000000000a3';
const NEWCO = '01920000-0000-7000-8000-0000000000a4';
const PROJECT = '01920000-0000-7000-8000-0000000000c1';
const ME = '01920000-0000-7000-8000-0000000000e1';

const TAXONOMY = [
  { code: 'roofing', name_pt: 'Coberturas', name_en: 'Roofing', parent_code: null, position: 400, impic_ref: '1.ª cat.' },
  { code: 'roofing-tiled', name_pt: 'Coberturas em telha', name_en: 'Tiled roofs', parent_code: 'roofing', position: 401, impic_ref: null },
];

function profile(orgId, o = {}) {
  return {
    org_id: orgId, slug: o.slug ?? orgId.slice(-2), display_name: o.name ?? 'Co', kind: 'contractor',
    claimed: o.claimed ?? true, contact_email: o.email ?? null, specialties: ['roofing-tiled'], tags: [],
    service_areas: [], listed: o.listed ?? true, completeness: 0, version: 1, created_at: '2026-03-01T00:00:00Z',
    verified_clients: o.vc ?? 0, builds: o.vc ?? 0, distance_km: o.km ?? null, service_radius_km: 40,
  };
}

function memoryStore() {
  const profiles = new Map([
    [ROOFER, profile(ROOFER, { slug: 'telhados', name: 'Telhados', km: 30, vc: 1 })],
    [UNCLAIMED, profile(UNCLAIMED, { slug: 'silva-roofing', name: 'Silva Roofing', claimed: false, email: 'geral@silva.pt', km: 2 })],
    ['hidden', profile('hidden', { slug: 'hidden', listed: false })],
  ]);
  const stats = [];
  const claims = [];
  const consents = new Map();
  const portfolio = new Map();
  return {
    profiles, stats, claims, consents, portfolio,
    async listSpecialties() { return TAXONOMY; },
    async searchCandidates(args) { this.lastSearch = args; return [...profiles.values()].filter((p) => p.listed); },
    async getPublicProfile({ slug, orgId }) {
      return [...profiles.values()].find((p) => (slug ? p.slug === slug : p.org_id === orgId)) ?? null;
    },
    async buildsOnRecord() { return []; },
    async listPortfolio(orgId) { return [...portfolio.values()].filter((e) => e.org_id === orgId); },
    async countPortfolio(orgId) { return (await this.listPortfolio(orgId)).length; },
    async getPortfolioEntry(id) { return portfolio.get(id) ?? null; },
    async insertPortfolioEntry({ id, orgId, title, specialties }) {
      const e = { id, org_id: orgId, source: 'declared', title, specialties };
      portfolio.set(id, e);
      return e;
    },
    async deletePortfolioEntry(id) { portfolio.delete(id); },
    async recordStat({ orgIds, kind }) { stats.push(...orgIds.map((o) => `${kind}:${o}`)); },
    async getProfileByOrg(orgId) { return profiles.get(orgId) ?? null; },
    async insertProfile({ orgId, kind, slugBase, value, completeness }) {
      const row = { ...profile(orgId, { slug: slugBase, name: value.displayName }), kind, completeness, listed: value.listed, description: value.description };
      profiles.set(orgId, row);
      return row;
    },
    async updateProfile({ orgId, expectedVersion, value, completeness }) {
      const row = profiles.get(orgId);
      if (row.version !== expectedVersion) return null;
      const next = { ...row, display_name: value.displayName, completeness, version: row.version + 1 };
      profiles.set(orgId, next);
      return next;
    },
    async setCompleteness({ orgId, completeness }) { profiles.get(orgId).completeness = completeness; },
    async listingStats() { return { shown_in_searches: 3, profile_views: 1, proposals_sent: 2, proposals_awarded: 1 }; },
    async createClaim(c) { claims.push({ ...c, id: c.id, profile_org_id: c.profileOrgId, claimant_org_id: c.claimantOrgId, token_hash: c.tokenHash, expires_at: c.expiresAt, accepted_at: null }); },
    async findClaimByHash(h) { return claims.find((c) => c.token_hash === h) ?? null; },
    async acceptClaim({ claimId, profileOrgId, claimantOrgId, kind }) {
      const c = claims.find((x) => x.id === claimId);
      c.accepted_at = new Date();
      const row = profiles.get(profileOrgId);
      profiles.delete(profileOrgId);
      const next = { ...row, org_id: claimantOrgId, claimed: true, contact_email: null, kind, version: row.version + 1 };
      profiles.set(claimantOrgId, next);
      return next;
    },
    async getConsent(projectId) { return consents.get(projectId) ?? null; },
    async putConsent({ projectId, showOnProfiles, buildName }) {
      const row = { show_on_profiles: showOnProfiles, build_name: buildName, decided_at: '2026-10-10T10:00:00Z' };
      consents.set(projectId, row);
      return row;
    },
    async idempotent(meta, fn) { return fn(); },
  };
}

const builds = {
  async locationFor({ projectId }) {
    if (projectId !== PROJECT) throw new ProblemError('not_found');
    return { lat: 38.8, lng: -9.38, municipality_code: '1111', name: 'Casa da Encosta' };
  },
  async ownedBuild({ viewer, projectId }) {
    if (projectId !== PROJECT || viewer.orgId !== OWNER) throw new ProblemError('not_found');
    return { name: 'Casa da Encosta' };
  },
};

function viewer({ orgId = ROOFER, orgKind = 'contractor', permissions = ['org:profile:manage', 'org:plan:edit'] } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`, orgKind,
    orgRole: 'admin', permissions,
  });
}

function setup() {
  const store = memoryStore();
  const sent = [];
  const mail = { sender: { send: async (m) => { sent.push(m); return { id: 'm1' }; } }, baseUrl: 'https://app.test' };
  const router = createRouter();
  registerDirectory(router, { store, builds, mail });
  const call = (method, path, { v = null, body = null, query = {}, headers = {} } = {}) =>
    router.dispatch({ method, path, viewer: v, body, query, headers });
  return { store, sent, call };
}

describe('public reads', () => {
  test('taxonomy is public; the IMPIC mapping is marked unverified', async () => {
    const { call } = setup();
    const res = await call('GET', '/specialties');
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].code, 'roofing');
    assert.ok(res.body.items.every((s) => s.impic_ref_verified === false));
  });

  test('search: anonymous, D-46 order, impressions counted', async () => {
    const { call, store } = setup();
    const res = await call('GET', '/directory/organizations', { query: { specialty: 'roofing-tiled' } });
    assert.equal(res.status, 200);
    // the far company with a verified client before the near one without
    assert.deepEqual(res.body.items.map((c) => c.slug), ['telhados', 'silva-roofing']);
    assert.equal(res.body.ranked_total, 1);
    assert.equal(res.body.items[1].record.ranked, false);
    assert.equal(res.body.items[1].stated, undefined);
    assert.deepEqual(store.stats.sort(), [`search_impression:${ROOFER}`, `search_impression:${UNCLAIMED}`].sort());
  });

  test('search: the viewer\'s own org is never counted; bad params are 422', async () => {
    const { call, store } = setup();
    await call('GET', '/directory/organizations', { v: viewer() });
    assert.ok(!store.stats.includes(`search_impression:${ROOFER}`));
    const bad = await call('GET', '/directory/organizations', { query: { specialty: 'nope', radius_km: '30', cursor: 'x' } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.specialty && bad.body.errors.radius_km && bad.body.errors.cursor);
  });

  test('near_project needs a session and a build the viewer takes part in', async () => {
    const { call, store } = setup();
    assert.equal((await call('GET', '/directory/organizations', { query: { near_project: PROJECT } })).status, 401);
    const other = '01920000-0000-7000-8000-0000000000c9';
    assert.equal((await call('GET', '/directory/organizations', { v: viewer({ orgId: OWNER }), query: { near_project: other } })).status, 404);
    const res = await call('GET', '/directory/organizations', { v: viewer({ orgId: OWNER }), query: { near_project: PROJECT, radius_km: '25' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.near, { source: 'project', lat: 38.8, lng: -9.38, radius_km: 25, label: 'Casa da Encosta' });
    assert.deepEqual(store.lastSearch.point, { lat: 38.8, lng: -9.38, radiusKm: 25 });
  });

  test('profile by slug: unlisted is 404; a view counts unless it is the company\'s own', async () => {
    const { call, store } = setup();
    assert.equal((await call('GET', '/directory/organizations/by-slug/hidden')).status, 404);
    const res = await call('GET', '/directory/organizations/by-slug/silva-roofing');
    assert.equal(res.status, 200);
    assert.equal(res.body.claim.available, true);
    await call('GET', `/directory/organizations/${ROOFER}`, { v: viewer() });
    assert.deepEqual(store.stats, [`profile_view:${UNCLAIMED}`]);
  });
});

describe('company side', () => {
  test('own org ∧ org:profile:manage; households are not listed', async () => {
    const { call } = setup();
    assert.equal((await call('GET', `/organizations/${OWNER}/profile`, { v: viewer() })).status, 403);
    assert.equal((await call('GET', `/organizations/${ROOFER}/profile`, { v: viewer({ permissions: [] }) })).status, 403);
    const house = await call('PUT', `/organizations/${OWNER}/profile`, {
      v: viewer({ orgId: OWNER, orgKind: 'household' }), body: { display_name: 'Casa' },
    });
    assert.equal(house.status, 403);
  });

  test('first save creates (201, slug), later saves need If-Match', async () => {
    const { call } = setup();
    const v = viewer({ orgId: NEWCO });
    const created = await call('PUT', `/organizations/${NEWCO}/profile`, {
      v, body: { display_name: 'Águas & Companhia', specialties: ['roofing'], listed: true },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.slug, 'aguas-companhia');
    assert.equal(created.body.completeness, 20);
    const noMatch = await call('PUT', `/organizations/${NEWCO}/profile`, { v, body: { display_name: 'X' } });
    assert.equal(noMatch.status, 409);
    const stale = await call('PUT', `/organizations/${NEWCO}/profile`, { v, body: { display_name: 'X' }, headers: { 'if-match': '7' } });
    assert.equal(stale.status, 409);
    const ok = await call('PUT', `/organizations/${NEWCO}/profile`, { v, body: { display_name: 'X' }, headers: { 'if-match': '1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.version, 2);
    const bad = await call('PUT', `/organizations/${NEWCO}/profile`, { v, body: { display_name: 'X', specialties: ['nope'] }, headers: { 'if-match': '2' } });
    assert.equal(bad.status, 422);
  });

  test('completeness, listing stats and stated portfolio', async () => {
    const { call } = setup();
    const v = viewer();
    const c = await call('GET', `/organizations/${ROOFER}/profile/completeness`, { v });
    assert.equal(c.status, 200);
    assert.ok(c.body.missing.some((m) => m.item === 'portfolio'));
    const s = await call('GET', `/organizations/${ROOFER}/listing-stats`, { v });
    assert.deepEqual(s.body, { days: 30, shown_in_searches: 3, profile_views: 1, proposals_sent: 2, proposals_awarded: 1 });
    const id = '01920000-0000-7000-8000-0000000000f1';
    const add = await call('POST', `/organizations/${ROOFER}/portfolio`, { v, body: { id, title: 'Moradia T4' } });
    assert.equal(add.status, 201);
    assert.equal(add.body.source, 'declared');
    const photos = await call('POST', `/organizations/${ROOFER}/portfolio`, { v, body: { id, title: 'x', photo_document_ids: [id] } });
    assert.equal(photos.status, 422);
    assert.equal((await call('DELETE', `/organizations/${ROOFER}/portfolio/${id}`, { v })).status, 204);
  });
});

describe('claim (R-16)', () => {
  test('a link goes to the profile e-mail; only that token, from the same org, claims it — once', async () => {
    const { call, sent, store } = setup();
    const v = viewer({ orgId: NEWCO });
    assert.equal((await call('POST', `/directory/organizations/${ROOFER}:claim`, { v })).status, 409);
    const started = await call('POST', `/directory/organizations/${UNCLAIMED}:claim`, { v });
    assert.equal(started.status, 202);
    assert.equal(started.body.sent_to, 'g***@s***.pt');
    assert.equal(sent[0].to, 'geral@silva.pt');
    const token = /\/claim\/([A-Za-z0-9_-]+)/.exec(sent[0].text)[1];
    assert.ok(!JSON.stringify(started.body).includes(token));

    const otherOrg = await call('POST', `/directory/claims/${token}:accept`, { v: viewer({ orgId: OWNER }) });
    assert.equal(otherOrg.status, 403);
    const ok = await call('POST', `/directory/claims/${token}:accept`, { v });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.org_id, NEWCO);
    assert.equal(ok.body.claimed, true);
    assert.ok(store.profiles.get(NEWCO));
    assert.equal((await call('POST', `/directory/claims/${token}:accept`, { v })).status, 410);
    assert.equal((await call('POST', '/directory/claims/not-a-real-token-at-all:accept', { v })).status, 410);
  });
});

describe('owner consent (R-12)', () => {
  test('only the build owner; the name is kept only while shown', async () => {
    const { call } = setup();
    const owner = viewer({ orgId: OWNER, orgKind: 'household' });
    assert.equal((await call('GET', `/projects/${PROJECT}/portfolio-consent`, { v: viewer() })).status, 404);
    const before = await call('GET', `/projects/${PROJECT}/portfolio-consent`, { v: owner });
    assert.deepEqual(before.body, { project_id: PROJECT, show_on_profiles: false });
    const on = await call('PUT', `/projects/${PROJECT}/portfolio-consent`, { v: owner, body: { show_on_profiles: true } });
    assert.equal(on.status, 200);
    assert.equal(on.body.name, 'Casa da Encosta');
    const off = await call('PUT', `/projects/${PROJECT}/portfolio-consent`, { v: owner, body: { show_on_profiles: false } });
    assert.equal(off.body.name, undefined);
    assert.equal((await call('PUT', `/projects/${PROJECT}/portfolio-consent`, { v: owner, body: {} })).status, 422);
  });
});
