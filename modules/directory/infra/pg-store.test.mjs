// Directory store over the REAL v2 migrations (throwaway DB). Skipped
// without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
//
// Proves at the database level (PRD-03):
//   - the 0022 taxonomy seed: two levels, parents first, codes are slugs;
//   - slugs are minted with a numeric suffix on collision;
//   - search near a point: haversine distance in SQL, only companies within
//     the search radius AND whose own service radius reaches the point; the
//     municipality fallback without a point; specialty family matching;
//   - the "On the record" read model fed through the real consumer: replays
//     are absorbed (event_id dedupe), counts equal a direct count over the
//     record tables (acceptance 2), a re-opened task leaves the count;
//   - the D-46 order end to end through the search use case;
//   - build names only with the owner's consent; no amount anywhere;
//   - a claim re-keys the profile, its portfolio and its stats;
//   - listing stats over 30 days.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createDirectoryStore } from './pg-store.mjs';
import { directoryConsumers } from '../application/consumers.mjs';
import { searchOrganizations, getDirectoryProfileBySlug } from '../application/search.mjs';
import { validateProfileWrite } from '../domain/profile.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the directory Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_directory_test';

const SINTRA = { lat: 38.8029, lng: -9.3817 };
const ORG = {
  telhados: randomUUID(), vale: randomUUID(), porto: randomUUID(), short: randomUUID(),
  canos: randomUUID(), owner: randomUUID(), owner2: randomUUID(), claimant: randomUUID(),
};
const PROJECT = randomUUID();
const PROJECT2 = randomUUID();
const CONTRACT = randomUUID();
const CONTRACT2 = randomUUID();

describe('directory store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store, consume;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 3 });
    const migrations = readdirSync(join(ROOT, 'db', 'v2')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const f of migrations) await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    store = createDirectoryStore(pool);
    const handlers = directoryConsumers(store);
    consume = (evt) => handlers[evt.type]?.({ event_id: randomUUID(), occurred_at: new Date().toISOString(), ...evt });

    const codes = new Set((await store.listSpecialties()).map((s) => s.code));
    const save = (orgId, body) => {
      const { errors, value } = validateProfileWrite({ listed: true, ...body }, { codes, today: '2026-10-10' });
      assert.deepEqual(errors, {});
      return store.insertProfile({ orgId, kind: 'contractor', slugBase: body.slug, value, completeness: body.completeness ?? 0 });
    };
    await save(ORG.telhados, { slug: 'telhados', display_name: 'Telhados do Norte', specialties: ['roofing-tiled'],
      base: { municipality_code: '1111', lat: 38.7907, lng: -9.3383 }, service_radius_km: 40 });
    await save(ORG.vale, { slug: 'vale', display_name: 'Coberturas Vale', specialties: ['roofing'],
      base: { municipality_code: '1111', lat: 38.7745, lng: -9.3272 }, service_radius_km: 30,
      description: 'Everything stated', declared: { impic_number: '1', insurance: 'x' }, available_from: '2026-11-01',
      completeness: 100 });
    await save(ORG.porto, { slug: 'porto', display_name: 'Telhados do Porto', specialties: ['roofing-tiled'],
      base: { municipality_code: '1312', lat: 41.1579, lng: -8.6291 }, service_radius_km: 300 });
    await save(ORG.short, { slug: 'short', display_name: 'Curto Alcance', specialties: ['roofing-tiled'],
      base: { lat: 38.95, lng: -9.33 }, service_radius_km: 5 });
    await save(ORG.canos, { slug: 'canos', display_name: 'Canos Sintra', specialties: ['plumbing'],
      base: { lat: 38.80, lng: -9.38 }, service_radius_km: 50, service_areas: ['11'] });
  });

  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
      await admin.end();
    }
  });

  test('taxonomy seed: two levels, parents before children, codes are slugs', async () => {
    const all = await store.listSpecialties();
    assert.ok(all.length >= 60);
    const seen = new Set();
    for (const s of all) {
      assert.match(s.code, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      if (s.parent_code) {
        assert.ok(seen.has(s.parent_code), `${s.code} after its parent`);
        assert.equal(all.find((p) => p.code === s.parent_code).parent_code, null, 'two levels only');
      }
      seen.add(s.code);
    }
    assert.ok(all.find((s) => s.code === 'roofing-tiled' && s.name_pt === 'Coberturas em telha'));
  });

  test('slug collision takes a numeric suffix', async () => {
    const codes = new Set(['roofing']);
    const { value } = validateProfileWrite({ display_name: 'Telhados do Norte' }, { codes, today: '2026-10-10' });
    const a = await store.insertProfile({ orgId: randomUUID(), kind: 'contractor', slugBase: 'telhados', value, completeness: 0 });
    const b = await store.insertProfile({ orgId: randomUUID(), kind: 'contractor', slugBase: 'telhados', value, completeness: 0 });
    assert.equal(a.slug, 'telhados-2');
    assert.equal(b.slug, 'telhados-3');
    await pool.query('DELETE FROM directory.organization_profile WHERE slug IN ($1, $2)', [a.slug, b.slug]);
  });

  test('distance_km is haversine (Lisbon–Porto ≈ 274 km)', async () => {
    const { rows } = await pool.query('SELECT directory.distance_km(38.7223, -9.1393, 41.1579, -8.6291) AS km');
    assert.ok(Math.abs(rows[0].km - 274.3) < 1);
  });

  test('near a point: within the search radius AND within the company\'s own radius; specialty family', async () => {
    const rows = await store.searchCandidates({
      specialtyCodes: ['roofing-tiled', 'roofing'], point: { ...SINTRA, radiusKm: 25 }, limit: 50,
    });
    const slugs = rows.map((r) => r.slug).sort();
    assert.deepEqual(slugs, ['telhados', 'vale']); // porto too far, short's radius 5 km, canos plumbing
    for (const r of rows) assert.ok(r.distance_km > 0 && r.distance_km < 25);
  });

  test('municipality fallback: base municipality or service area (district code)', async () => {
    const rows = await store.searchCandidates({ specialtyCodes: null, municipality: '1111', limit: 50 });
    assert.deepEqual(rows.map((r) => r.slug).sort(), ['canos', 'telhados', 'vale']);
    const byDistrict = await store.searchCandidates({ specialtyCodes: null, district: '13', limit: 50 });
    assert.deepEqual(byDistrict.map((r) => r.slug), ['porto']);
  });

  test('read model: events in, replays absorbed, counts equal the record tables', async () => {
    const signed = {
      type: 'contracting.contract.signed', project_id: PROJECT, scope: { type: 'contract', id: CONTRACT },
      data: { kind: 'direct', client_org_id: ORG.owner, supplier_org_id: ORG.telhados },
    };
    const evt = { event_id: randomUUID(), occurred_at: new Date().toISOString(), ...signed };
    const handlers = directoryConsumers(store);
    await handlers[evt.type](evt);
    await handlers[evt.type](evt); // at-least-once replay
    await consume({ type: 'contracting.contract.signed', project_id: PROJECT2, scope: { type: 'contract', id: CONTRACT2 },
      data: { kind: 'direct', client_org_id: ORG.owner2, supplier_org_id: ORG.telhados } });
    await consume({ type: 'contracting.contract.closed', scope: { type: 'contract', id: CONTRACT2 }, data: { from: 'active', to: 'closed' } });
    const task = (id, baseline, actual, assignee = ORG.telhados) => consume({
      type: 'planning.progress.reported', project_id: PROJECT,
      data: { task_id: id, project_id: PROJECT, status: 'done', assignee_org_id: assignee, contract_id: CONTRACT,
        baseline_finish: baseline, actual_finish: actual },
    });
    const t1 = randomUUID();
    const t2 = randomUUID();
    const t3 = randomUUID();
    await task(t1, '2026-09-10', '2026-09-10'); // on time
    await task(t2, '2026-09-10', '2026-09-12'); // late
    await task(t3, '2026-09-10', '2026-09-01'); // early, then re-opened
    await consume({ type: 'planning.progress.reported', data: { task_id: t3, status: 'in_progress' } });
    await task(randomUUID(), '2026-09-10', '2026-09-10', ORG.vale); // not vale's contract: no verified client
    const co = randomUUID();
    await consume({ type: 'contracting.change_order.submitted', data: { change_order_id: co, contract_id: CONTRACT, to: 'submitted' } });
    await consume({ type: 'contracting.change_order.approved', data: { change_order_id: co, contract_id: CONTRACT, amount_delta_cents: 99900 } });

    const p = await store.getPublicProfile({ slug: 'telhados' });
    const direct = await pool.query(
      `SELECT (SELECT count(DISTINCT client_org_id) FROM directory.record_contract WHERE supplier_org_id = $1) AS vc,
              (SELECT count(*) FROM directory.record_task WHERE assignee_org_id = $1) AS tf,
              (SELECT count(*) FROM directory.record_task WHERE assignee_org_id = $1 AND actual_finish <= baseline_finish) AS tot`,
      [ORG.telhados],
    );
    assert.equal(Number(p.verified_clients), 2);
    assert.equal(Number(p.verified_clients), Number(direct.rows[0].vc));
    assert.equal(Number(p.tasks_finished), Number(direct.rows[0].tf));
    assert.equal(Number(p.tasks_on_time), Number(direct.rows[0].tot));
    assert.deepEqual([Number(p.tasks_finished), Number(p.tasks_on_time)], [2, 1]);
    assert.deepEqual([Number(p.change_orders_raised), Number(p.change_orders_approved)], [1, 1]);
    const vale = await store.getPublicProfile({ slug: 'vale' });
    assert.equal(Number(vale.tasks_finished), 0);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM directory.consumed_event');
    assert.equal(n, 10); // the replayed signature was absorbed
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'directory' AND column_name LIKE '%cents%'`,
    );
    assert.equal(cols.rows.length, 0, 'no amount column in the directory');
  });

  test('D-46 through the search use case: verified clients first, completeness irrelevant', async () => {
    const res = await searchOrganizations({
      viewer: null, store, builds: null,
      query: { specialty: 'roofing-tiled', lat: String(SINTRA.lat), lng: String(SINTRA.lng), radius_km: '25' },
    });
    assert.deepEqual(res.body.items.map((c) => c.slug), ['telhados', 'vale']);
    assert.equal(res.body.items[0].record.ranked, true);
    assert.equal(res.body.items[1].record.ranked, false);
    assert.equal(res.body.items[1].specialty_match, 'related');
    assert.ok(!JSON.stringify(res.body).includes('99900'));
    const late = await searchOrganizations({ viewer: null, store, builds: null, query: { can_start_by: '2026-10-15', municipality: '1111' } });
    assert.ok(!late.body.items.some((c) => c.slug === 'vale'), 'available only from November');
  });

  test('build names only with the owner\'s consent', async () => {
    let builds = await store.buildsOnRecord(ORG.telhados);
    assert.equal(builds.length, 2);
    assert.ok(builds.every((b) => b.consent_name == null));
    await store.putConsent({ projectId: PROJECT, ownerOrgId: ORG.owner, showOnProfiles: true, buildName: 'Casa da Encosta', note: null, personId: randomUUID() });
    builds = await store.buildsOnRecord(ORG.telhados);
    const b = builds.find((x) => x.project_id === PROJECT);
    assert.equal(b.consent_name, 'Casa da Encosta');
    assert.deepEqual([Number(b.tasks_finished), Number(b.tasks_on_time)], [2, 1]);
    assert.ok(builds.find((x) => x.project_id === PROJECT2).statuses.includes('closed'));
    const page = await getDirectoryProfileBySlug({ viewer: null, store, slug: 'telhados' });
    assert.deepEqual(page.body.builds.map((x) => x.name ?? null).sort(), ['Casa da Encosta', null].sort());
    await store.putConsent({ projectId: PROJECT, ownerOrgId: ORG.owner, showOnProfiles: false, buildName: null, note: null, personId: randomUUID() });
    assert.ok((await store.buildsOnRecord(ORG.telhados)).every((x) => x.consent_name == null));
  });

  test('claim: the unclaimed profile, its portfolio and stats move to the claimant', async () => {
    const row = await store.insertUnclaimedProfile({
      orgId: randomUUID(), displayName: 'Silva Roofing', contactEmail: 'geral@silva.pt', slugBase: 'silva-roofing', specialties: ['roofing-tiled'],
    });
    const again = await store.insertUnclaimedProfile({
      orgId: randomUUID(), displayName: 'Silva Roofing', contactEmail: 'geral@silva.pt', slugBase: 'silva-roofing', specialties: [],
    });
    assert.equal(again.org_id, row.org_id, 'one unclaimed profile per e-mail');
    await store.insertPortfolioEntry({ id: randomUUID(), orgId: row.org_id, title: 'Old roof', municipalityCode: null, typology: null, specialties: [], startDate: null, endDate: null });
    await store.recordStat({ orgIds: [row.org_id], kind: 'profile_view' });
    const claimId = randomUUID();
    await store.createClaim({ id: claimId, profileOrgId: row.org_id, claimantOrgId: ORG.claimant, claimantPersonId: randomUUID(),
      tokenHash: 'a'.repeat(64), sentTo: 'geral@silva.pt', expiresAt: new Date(Date.now() + 86400000) });
    const claimed = await store.acceptClaim({ claimId, profileOrgId: row.org_id, claimantOrgId: ORG.claimant, kind: 'contractor' });
    assert.equal(claimed.org_id, ORG.claimant);
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.contact_email, null);
    assert.equal(await store.countPortfolio(ORG.claimant), 1);
    assert.equal((await store.findClaimByHash('a'.repeat(64))).profile_org_id, ORG.claimant);
    assert.equal(await store.acceptClaim({ claimId, profileOrgId: ORG.claimant, claimantOrgId: ORG.claimant, kind: 'contractor' }), null);
    const stats = await store.listingStats({ orgId: ORG.claimant, days: 30 });
    assert.equal(Number(stats.profile_views), 1);
  });

  test('listing stats: impressions and proposals over the window', async () => {
    const before = Number((await store.listingStats({ orgId: ORG.vale, days: 30 })).shown_in_searches);
    await store.recordStat({ orgIds: [ORG.vale, ORG.vale], kind: 'search_impression' });
    const rfp = randomUUID();
    const proposal = randomUUID();
    await consume({ type: 'tendering.proposal.submitted', data: { rfp_id: rfp, proposal_id: proposal, bidder_org_id: ORG.vale } });
    await consume({ type: 'tendering.rfp.awarded', data: { rfp_id: rfp, proposal_id: proposal, contract_id: randomUUID() } });
    const s = await store.listingStats({ orgId: ORG.vale, days: 30 });
    assert.deepEqual([Number(s.shown_in_searches) - before, Number(s.proposals_sent), Number(s.proposals_awarded)], [2, 1, 1]);
  });
});
