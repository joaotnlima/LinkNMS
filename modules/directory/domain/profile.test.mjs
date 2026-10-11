import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  slugify, slugCandidate, validateProfileWrite, completeness, ownerProfileBody, maskEmail,
} from './profile.mjs';

const CODES = new Set(['roofing', 'roofing-tiled', 'plumbing']);
const ctx = { codes: CODES, today: '2026-10-10' };

test('slugify: diacritics stripped, punctuation folded, capped at 60', () => {
  assert.equal(slugify('Telhados do Norte, Lda.'), 'telhados-do-norte-lda');
  assert.equal(slugify('Construções Ç&Ã — Évora'), 'construcoes-c-a-evora');
  assert.equal(slugify('  ***  '), 'company');
  assert.ok(slugify('a'.repeat(80)).length <= 60);
  assert.ok(!slugify(`${'a'.repeat(59)} b`).endsWith('-'));
});

test('slugCandidate: base, then -2, -3; reserved words never alone', () => {
  assert.equal(slugCandidate('douro', 1), 'douro');
  assert.equal(slugCandidate('douro', 2), 'douro-2');
  assert.equal(slugCandidate('claim', 1), 'claim-2');
  assert.equal(slugCandidate('by-slug', 1), 'by-slug-2');
});

test('validateProfileWrite: a full valid body', () => {
  const { errors, value } = validateProfileWrite({
    display_name: ' Telhados do Norte ',
    specialties: ['roofing-tiled', 'roofing-tiled'],
    service_areas: ['11', '1111'],
    base: { municipality_code: '1111', lat: 38.79876543, lng: -9.3 },
    service_radius_km: 40,
    team_size_band: '6-20',
    founded_year: 2009,
    available_from: '2027-02-01',
    declared: { impic_number: '00000-PUB', impic_class: '3' },
    listed: true,
  }, ctx);
  assert.deepEqual(errors, {});
  assert.equal(value.displayName, 'Telhados do Norte');
  assert.deepEqual(value.specialties, ['roofing-tiled']);
  assert.equal(value.base.lat, 38.79877);
  assert.equal(value.listed, true);
  assert.equal(value.declared.impicNumber, '00000-PUB');
});

test('validateProfileWrite: field errors', () => {
  const { errors } = validateProfileWrite({
    display_name: '',
    specialties: ['made-up'],
    service_areas: ['Porto'],
    base: { lat: 41 },
    service_radius_km: 0,
    team_size_band: 'huge',
    founded_year: 2030,
    available_from: 'soon',
    listed: 'yes',
  }, ctx);
  for (const k of ['display_name', 'specialties', 'service_areas', 'base', 'service_radius_km',
    'team_size_band', 'founded_year', 'available_from', 'listed']) {
    assert.ok(errors[k], `expected an error on ${k}`);
  }
});

test('completeness: the R-19 checklist adds to 100 and lists what is missing', () => {
  const empty = completeness({}, 0);
  assert.equal(empty.score, 0);
  assert.equal(empty.items.reduce((n, i) => n + i.points, 0), 100);
  assert.deepEqual(empty.missing.map((m) => m.item),
    ['specialties', 'base', 'description', 'licence', 'insurance', 'portfolio', 'availability']);
  const full = completeness({
    specialties: ['roofing'], base_lat: 38.8, service_radius_km: 40, description: 'x',
    declared_impic_number: '1', declared_insurance: 'y', available_from: '2027-01-01',
  }, 1);
  assert.equal(full.score, 100);
  assert.deepEqual(full.missing, []);
});

test('ownerProfileBody: stated credentials under declared, base as a point', () => {
  const body = ownerProfileBody({
    org_id: 'o1', slug: 's', display_name: 'D', kind: 'contractor', claimed: true, specialties: ['roofing'],
    tags: [], service_areas: [], base_municipality_code: '1111', base_lat: '38.80000', base_lng: '-9.30000',
    service_radius_km: 40, declared_impic_number: 'N', listed: true, completeness: 35,
    created_at: new Date('2026-03-01T00:00:00Z'), version: 2,
  });
  assert.deepEqual(body.base, { municipality_code: '1111', lat: 38.8, lng: -9.3 });
  assert.deepEqual(body.declared, { impic_number: 'N' });
  assert.equal(body.version, 2);
});

test('maskEmail never shows the address', () => {
  assert.equal(maskEmail('joao@douro.pt'), 'j***@d***.pt');
});
