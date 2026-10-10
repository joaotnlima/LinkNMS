// PRD-04 domain: who may ask, who may decide, how an open request matches a
// company, and the inbox wire shapes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  askable, decidable, haversineKm, matchOpenRequest, bidRequestBody, companyRequestBody, openRequestBody,
} from './bid-requests.mjs';

const NOW = new Date('2026-12-01T10:00:00Z');
const rfp = (over = {}) => ({
  id: 'r', issuer_org_id: 'issuer', listed: true, status: 'published',
  submission_deadline: '2027-01-15T17:00:00Z', ...over,
});

describe('askable (D-47)', () => {
  test('a listed, published RFP before its deadline', () => {
    assert.deepEqual(askable(rfp(), { orgId: 'co', now: NOW }), { ok: true });
  });
  test('unlisted, draft or unknown → not_found (no oracle)', () => {
    assert.equal(askable(rfp({ listed: false }), { orgId: 'co', now: NOW }).code, 'not_found');
    assert.equal(askable(rfp({ status: 'draft' }), { orgId: 'co', now: NOW }).code, 'not_found');
    assert.equal(askable(null, { orgId: 'co', now: NOW }).code, 'not_found');
  });
  test('the issuer itself → validation_failed; past the deadline → invalid_transition', () => {
    assert.equal(askable(rfp(), { orgId: 'issuer', now: NOW }).code, 'validation_failed');
    assert.equal(askable(rfp({ submission_deadline: '2026-11-30T10:00:00Z' }), { orgId: 'co', now: NOW }).code, 'invalid_transition');
  });
});

describe('decidable', () => {
  test('only a pending request; approval only while published', () => {
    assert.equal(decidable({ status: 'pending' }, rfp(), 'approve').ok, true);
    assert.equal(decidable({ status: 'approved' }, rfp(), 'decline').ok, false);
    assert.equal(decidable({ status: 'pending' }, rfp({ status: 'closed' }), 'approve').ok, false);
    assert.equal(decidable({ status: 'pending' }, rfp({ status: 'closed' }), 'decline').ok, true);
  });
});

describe('matchOpenRequest (X-10)', () => {
  const sintra = { lat: 38.8029, lng: -9.3817, municipality_code: '1111' };
  const profile = (over = {}) => ({
    listed: true, specialty_family: ['roofing', 'roofing-tiled', 'roofing-flat'],
    base: { lat: 38.7569, lng: -9.2745 }, radius_km: 40, service_areas: [], ...over,
  });

  test('haversine Sintra ↔ Lisboa is about 30 km', () => {
    const d = haversineKm({ lat: 38.8029, lng: -9.3817 }, { lat: 38.7223, lng: -9.1393 });
    assert.ok(d > 20 && d < 30, String(d));
  });

  test('specialty in the family and the build within the radius → match with distance', () => {
    const m = matchOpenRequest({ specialtyCodes: ['roofing-tiled'] }, sintra, profile());
    assert.equal(m.match, true);
    assert.ok(m.distance_km > 5 && m.distance_km < 15);
  });

  test('no specialty overlap → no match, whatever the distance', () => {
    assert.equal(matchOpenRequest({ specialtyCodes: ['plumbing'] }, sintra, profile()).match, false);
    assert.equal(matchOpenRequest({ specialtyCodes: [] }, sintra, profile()).match, false);
  });

  test('outside the radius but the municipality (or its district) is a service area → match', () => {
    const far = profile({ radius_km: 2 });
    assert.equal(matchOpenRequest({ specialtyCodes: ['roofing'] }, sintra, far).match, false);
    assert.equal(matchOpenRequest({ specialtyCodes: ['roofing'] }, sintra, { ...far, service_areas: ['1111'] }).match, true);
    assert.equal(matchOpenRequest({ specialtyCodes: ['roofing'] }, sintra, { ...far, service_areas: ['11'] }).match, true);
  });

  test('a build without a point matches by area only; no distance', () => {
    const m = matchOpenRequest({ specialtyCodes: ['roofing'] }, { municipality_code: '1111', lat: null, lng: null },
      profile({ service_areas: ['1111'] }));
    assert.deepEqual(m, { match: true, distance_km: null });
  });
});

describe('wire', () => {
  test('BidRequest: decider and company only when given', () => {
    const row = {
      id: 'b', rfp_id: 'r', org_id: 'co', status: 'approved', requested_at: new Date('2026-12-01T10:00:00Z'),
      decided_at: '2026-12-02T10:00:00Z', decided_by_person_id: 'p', recipient_id: 'rec',
    };
    const company = bidRequestBody(row);
    assert.equal(company.requested_at, '2026-12-01T10:00:00.000Z');
    assert.equal(company.decided_by_person_id, undefined);
    assert.equal(company.recipient_id, 'rec');
    const issuer = bidRequestBody(row, { issuer: true, company: { org_id: 'co' } });
    assert.equal(issuer.decided_by_person_id, 'p');
    assert.deepEqual(issuer.company, { org_id: 'co' });
  });

  test('CompanyRequest: origin, issuer level, counts, awarded to me', () => {
    const body = companyRequestBody({
      rfp_id: 'r', recipient_id: 'rec', title: 'Roofing', source: 'directory', level: 'owner',
      rfp_status: 'awarded', submission_deadline: '2027-01-15T17:00:00Z', task_count: '10', file_count: '1',
      recipient_status: 'proposal_submitted', proposal_id: 'p1', proposal_status: 'awarded',
      awarded_proposal_id: 'p1', received_at: '2026-12-01T10:00:00Z',
    }, { name: 'Casa da Encosta', municipality_code: '1111', lat: 1, lng: 2 });
    assert.equal(body.origin, 'directory');
    assert.equal(body.task_count, 10);
    assert.equal(body.awarded_to_me, true);
    assert.deepEqual(body.build, { name: 'Casa da Encosta', municipality_code: '1111' });
  });

  test('OpenRequest: never the build point, my request when asked', () => {
    const body = openRequestBody(
      { id: 'r', title: 'Roofing', level: 'sub', specialty_codes: ['roofing'], submission_deadline: '2027-01-15T17:00:00Z', task_count: 3 },
      { build: { name: 'Casa', municipality_code: '1111', lat: 1, lng: 2 }, distanceKm: 6.2,
        myRequest: { id: 'b', rfp_id: 'r', org_id: 'co', status: 'pending', requested_at: '2026-12-01T10:00:00Z', decided_at: null } },
    );
    assert.equal(body.distance_km, 6.2);
    assert.equal(body.build.lat, undefined);
    assert.equal(body.my_request.status, 'pending');
  });
});
