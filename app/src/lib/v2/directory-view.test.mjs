// Unit tests for the directory view model (PRD-03).
// Run: node --test src/lib/v2/directory-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cardProofLines, whereLine, formatDay, formatKm, cleanParams, toggleFacetHref, facetOn, hrefWith,
  resultHeading, specialtyGroups, buildStateLabel, listingStatTiles,
} from './directory-view.ts';

const record = (o = {}) => ({
  ranked: false, verified_clients: 0, builds: 0, tasks_finished: 0, tasks_on_time: 0,
  change_orders_raised: 0, change_orders_approved: 0, ...o,
});

test('proof lines: every claim labelled On the record or Stated — never Checked', () => {
  const ranked = cardProofLines({
    claimed: true, record: record({ ranked: true, verified_clients: 2, builds: 4, tasks_finished: 7, tasks_on_time: 6 }),
    stated: { licence_number_given: true, impic_class: '3', insurance_given: false, available_from: '2027-02-01', portfolio_count: 0 },
  });
  assert.deepEqual(ranked.map((l) => l.label), ['On the record', 'Stated', 'Stated']);
  assert.match(ranked[0].text, /2 verified clients · 4 builds on LinkNMS · 6 of 7 tasks finished on the planned date/);
  assert.match(ranked[1].text, /not checked/);
  assert.equal(ranked[2].text, 'Can start from 1 Feb 2027');
  const unclaimed = cardProofLines({ claimed: false, record: record() });
  assert.deepEqual(unclaimed.map((l) => l.text), ['No verified clients yet', 'Nothing yet — the company has not claimed this profile']);
  assert.ok(![...ranked, ...unclaimed].some((l) => /checked with|verified by IMPIC/i.test(l.text)));
});

test('where line and number formatting', () => {
  assert.equal(whereLine({ claimed: true, base_municipality_code: '1111', distance_km: 6.04, service_radius_km: 40, team_size_band: '6-20', record: record() }),
    'Municipality 1111 · 6 km away · serves up to 40 km · 6–20 people');
  assert.equal(formatKm(4.25), '4.3 km');
  assert.equal(formatKm(18.6), '19 km');
  assert.equal(formatDay('2026-09-12'), '12 Sep 2026');
});

test('search params: known keys only; facet toggles reset the cursor', () => {
  const p = cleanParams({ specialty: 'roofing', cursor: 'abc', proof: 'on_record', junk: 'x', q: '  ' });
  assert.deepEqual(p, { specialty: 'roofing', cursor: 'abc', proof: 'on_record' });
  assert.equal(toggleFacetHref(p, 'proof', 'licence'), '/companies?specialty=roofing&proof=on_record%2Clicence');
  assert.equal(toggleFacetHref(p, 'proof', 'on_record'), '/companies?specialty=roofing');
  assert.equal(facetOn(p, 'proof', 'on_record'), true);
  assert.equal(hrefWith({}, '/specialties/roofing'), '/specialties/roofing');
});

test('heading, taxonomy groups, build states, stat tiles', () => {
  assert.equal(resultHeading({ total: 12, ranked_total: 4, near: { source: 'project', label: 'Casa da Encosta' } }, 'Roofing'),
    '12 roofing companies near Casa da Encosta · 4 with verified clients');
  assert.equal(resultHeading({ total: 1, ranked_total: 0, near: null }), '1 company · 0 with verified clients');
  const groups = specialtyGroups([
    { code: 'roofing', parent_code: null }, { code: 'roofing-tiled', parent_code: 'roofing' }, { code: 'hvac', parent_code: null },
  ]);
  assert.deepEqual(groups.map((g) => [g.parent.code, g.children.length]), [['roofing', 1], ['hvac', 0]]);
  assert.deepEqual(buildStateLabel('in_progress'), { text: 'In progress', tone: 'warn' });
  assert.equal(listingStatTiles(null).length, 0);
  assert.equal(listingStatTiles({ days: 30, shown_in_searches: 214, profile_views: 37, proposals_sent: 2, proposals_awarded: 1 })[0].value, '214');
});

test('editor form → OrganizationProfileWrite: shapes only, blanks dropped', async () => {
  const { profileWriteFromForm } = await import('./directory-view.ts');
  const form = {
    display_name: ' Telhados ', description: '', tags: 'telha, xisto ,', service_areas: '11 1111,13',
    base_municipality_code: '1111', base_lat: '38,79', base_lng: '-9.34', service_radius_km: '40',
    team_size_band: '6-20', founded_year: '', available_from: '', declared_impic_number: '00000', listed: 'on',
  };
  const body = profileWriteFromForm((k) => form[k] ?? '', (k) => (k === 'specialties' ? ['roofing-tiled', ''] : []));
  assert.equal(body.display_name, 'Telhados');
  assert.equal(body.description, undefined);
  assert.deepEqual(body.tags, ['telha', 'xisto']);
  assert.deepEqual(body.service_areas, ['11', '1111', '13']);
  assert.deepEqual(body.base, { municipality_code: '1111', lat: 38.79, lng: -9.34 });
  assert.equal(body.service_radius_km, 40);
  assert.equal(body.founded_year, undefined);
  assert.equal(body.available_from, null);
  assert.deepEqual(body.specialties, ['roofing-tiled']);
  assert.equal(body.declared.impic_number, '00000');
  assert.equal(body.listed, true);
});
