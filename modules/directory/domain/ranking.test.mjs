// D-46 ordering, facets and keyset paging — pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  specialtyFamily, specialtyMatch, cardBody, sortCards, applyFacetFilters, facetCounts, pageAfter, decodeCursor,
} from './ranking.mjs';

const TAXONOMY = [
  { code: 'roofing', parent_code: null },
  { code: 'roofing-tiled', parent_code: 'roofing' },
  { code: 'roofing-flat', parent_code: 'roofing' },
  { code: 'plumbing', parent_code: null },
  { code: 'plumbing-water', parent_code: 'plumbing' },
];

function row(id, o = {}) {
  return {
    org_id: id, slug: id, display_name: o.name ?? id, claimed: o.claimed ?? true,
    specialties: o.specialties ?? ['roofing-tiled'], distance_km: o.km ?? null, team_size_band: o.size ?? null,
    verified_clients: o.vc ?? 0, builds: o.builds ?? o.vc ?? 0, tasks_finished: o.tf ?? 0, tasks_on_time: o.tot ?? 0,
    declared_impic_number: o.licence ?? null, portfolio_count: o.portfolio ?? 0,
    completeness: o.completeness ?? 0, service_radius_km: 50,
  };
}

const family = specialtyFamily('roofing-tiled', TAXONOMY);
const order = (rows) => sortCards(rows.map((r) => cardBody(r, family))).map((x) => x.card.org_id);

test('specialtyFamily: itself, its parent, its children', () => {
  assert.deepEqual(specialtyFamily('roofing', TAXONOMY).codes.sort(), ['roofing', 'roofing-flat', 'roofing-tiled']);
  assert.deepEqual(family.codes.sort(), ['roofing', 'roofing-tiled']);
  assert.equal(specialtyFamily('nope', TAXONOMY), null);
  assert.equal(specialtyMatch(['roofing-tiled'], family), 'exact');
  assert.equal(specialtyMatch(['roofing'], family), 'related');
  assert.equal(specialtyMatch(['plumbing'], family), null);
});

test('D-46: every company with a verified client comes before every one without', () => {
  const ids = order([
    row('near-unranked', { km: 1 }),
    row('far-ranked', { km: 90, vc: 1 }),
  ]);
  assert.deepEqual(ids, ['far-ranked', 'near-unranked']);
});

test('D-46: ranked by verified clients, then smoothed on-time rate, then builds, then distance', () => {
  const ids = order([
    row('one-client', { vc: 1, tf: 10, tot: 10, km: 2 }),
    row('two-clients', { vc: 2, tf: 4, tot: 1, km: 40 }),
    row('two-clients-ontime', { vc: 2, tf: 4, tot: 4, km: 60 }),
  ]);
  assert.deepEqual(ids, ['two-clients-ontime', 'two-clients', 'one-client']);
  // smoothing: 45 of 50 beats 1 of 1
  const ids2 = order([row('lucky', { vc: 1, tf: 1, tot: 1 }), row('steady', { vc: 1, tf: 50, tot: 45 })]);
  assert.deepEqual(ids2, ['steady', 'lucky']);
});

test('D-46: completeness, licence, portfolio and size never change the order', () => {
  const plain = row('plain', { km: 10 });
  const polished = row('polished', { km: 11, completeness: 100, licence: 'X', portfolio: 9, size: '50+' });
  assert.deepEqual(order([polished, plain]), ['plain', 'polished']);
  assert.deepEqual(order([plain, polished]), ['plain', 'polished']);
});

test('unranked: distance, then specialty match; unknown distance last', () => {
  const ids = order([
    row('related-near', { km: 5, specialties: ['roofing'] }),
    row('exact-near', { km: 5 }),
    row('nowhere'),
    row('exact-far', { km: 30 }),
  ]);
  assert.deepEqual(ids, ['exact-near', 'related-near', 'exact-far', 'nowhere']);
});

test('cards: unclaimed profiles carry no stated data; never an amount', () => {
  const card = cardBody(row('u', { claimed: false, licence: 'X', size: '2-5' }), family);
  assert.equal(card.stated, undefined);
  assert.equal(card.team_size_band, undefined);
  assert.equal(card.record.ranked, false);
  assert.ok(!JSON.stringify(card).includes('cents'));
});

test('facets count before facet filters; filters narrow', () => {
  const cards = [
    row('a', { vc: 1, licence: 'L', size: '2-5' }),
    row('b', { specialties: ['roofing-flat', 'roofing'], portfolio: 2 }),
    row('c', { claimed: false }),
  ].map((r) => cardBody(r, specialtyFamily('roofing', TAXONOMY)));
  const f = facetCounts(cards, TAXONOMY, specialtyFamily('roofing', TAXONOMY));
  assert.deepEqual(f.work_types, [{ code: 'roofing-tiled', count: 2 }, { code: 'roofing-flat', count: 1 }]);
  assert.deepEqual(f.proof, { on_record: 1, licence: 1, portfolio: 1 });
  assert.equal(f.claimed, 2);
  assert.deepEqual(applyFacetFilters(cards, { proof: ['on_record'] }).map((c) => c.org_id), ['a']);
  assert.deepEqual(applyFacetFilters(cards, { workTypes: ['roofing-flat'] }).map((c) => c.org_id), ['b']);
  assert.deepEqual(applyFacetFilters(cards, { claimed: false }).map((c) => c.org_id), ['c']);
});

test('keyset paging walks the ranked list without gaps or repeats', () => {
  const sorted = sortCards(['a', 'b', 'c', 'd', 'e'].map((id, i) => cardBody(row(id, { km: i }), family)));
  const p1 = pageAfter(sorted, null, 2);
  const p2 = pageAfter(sorted, p1.nextCursor, 2);
  const p3 = pageAfter(sorted, p2.nextCursor, 2);
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((c) => c.org_id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(p3.nextCursor, null);
  assert.equal(decodeCursor('garbage'), null);
});
