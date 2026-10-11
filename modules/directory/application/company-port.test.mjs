// The directory's company port (PRD-04) over an in-memory store.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCompanyPort } from './company-port.mjs';
import { directoryConsumers } from './consumers.mjs';

const TAXONOMY = [
  { code: 'roofing', parent_code: null }, { code: 'roofing-tiled', parent_code: 'roofing' },
  { code: 'roofing-flat', parent_code: 'roofing' }, { code: 'plumbing', parent_code: null },
];
const PROFILES = {
  claimed: { org_id: 'claimed', listed: true, claimed: true, display_name: 'Telhados do Norte', specialties: ['roofing-tiled'],
    base_lat: '38.79070', base_lng: '-9.33830', service_radius_km: 40, service_areas: ['1111'], contact_email: null },
  unclaimed: { org_id: 'unclaimed', listed: true, claimed: false, display_name: 'Silva Roofing', specialties: [],
    contact_email: 'obra@silva-roofing.pt' },
  hidden: { org_id: 'hidden', listed: false, claimed: true, display_name: 'Hidden', specialties: [] },
};

function store() {
  const seeded = [];
  return {
    seeded,
    async getProfileByOrg(id) { return PROFILES[id] ?? null; },
    async listSpecialties() { return TAXONOMY; },
    async profilesByOrgIds(ids, near) {
      return ids.map((id) => PROFILES[id]).filter(Boolean).map((p) => ({
        ...p, slug: p.org_id, verified_clients: '2', builds: '3', tasks_finished: '4', tasks_on_time: '3',
        distance_km: near ? '6.04' : null,
      }));
    },
    async insertUnclaimedProfile(x) { seeded.push(x); return { org_id: 'new', claimed: false }; },
    async applyRecordEvent() {},
  };
}

test('contactOf: a claimed profile is its org; an unclaimed one its e-mail; unlisted is nobody', async () => {
  const port = createCompanyPort(store());
  assert.deepEqual(await port.contactOf('claimed'), { org_id: 'claimed', claimed: true, display_name: 'Telhados do Norte' });
  assert.equal((await port.contactOf('unclaimed')).email, 'obra@silva-roofing.pt');
  assert.equal(await port.contactOf('hidden'), null);
  assert.equal(await port.contactOf('missing'), null);
});

test('proofsOf: on-record counts as numbers, distance rounded, never an amount', async () => {
  const [p] = await createCompanyPort(store()).proofsOf(['claimed', 'claimed'], { near: { lat: 1, lng: 2 } });
  assert.deepEqual(p, {
    org_id: 'claimed', display_name: 'Telhados do Norte', slug: 'claimed', claimed: true,
    verified_clients: 2, builds: 3, tasks_finished: 4, tasks_on_time: 3, distance_km: 6,
  });
});

test('biddingProfileOf: the specialty family, base point, radius and areas', async () => {
  const profile = await createCompanyPort(store()).biddingProfileOf('claimed');
  assert.deepEqual(profile.specialty_family, ['roofing', 'roofing-tiled']);
  assert.deepEqual(profile.base, { lat: 38.7907, lng: -9.3383 });
  assert.equal(profile.radius_km, 40);
  assert.equal(await createCompanyPort(store()).biddingProfileOf('missing'), null);
});

test('seeding: a sent RFP gives each company address an unclaimed profile, never a personal one', async () => {
  const s = store();
  const invitees = {
    async emailInviteesOf(rfpId) {
      return rfpId === 'r1' ? { emails: ['obra@empreiteiro-amigo.pt', 'joao@gmail.com'], specialty_codes: ['roofing'] } : { emails: [] };
    },
  };
  const consumers = directoryConsumers(s, { invitees });
  await consumers['tendering.rfp.published']({ event_id: 'e1', type: 'tendering.rfp.published', data: { rfp_id: 'r1' } });
  await consumers['tendering.rfp.recipients_added']({ event_id: 'e2', type: 'tendering.rfp.recipients_added', data: { rfp_id: 'r2' } });
  assert.equal(s.seeded.length, 1);
  assert.equal(s.seeded[0].displayName, 'Empreiteiro Amigo');
  assert.equal(s.seeded[0].contactEmail, 'obra@empreiteiro-amigo.pt');
  assert.deepEqual(s.seeded[0].specialties, ['roofing']);
  // Without the port the directory only keeps its record read model.
  assert.equal(directoryConsumers(s)['tendering.rfp.published'], undefined);
});
