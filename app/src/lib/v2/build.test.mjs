// Unit tests for the v2 build-creation field mapping (LINA-365).
//
// The rules worth pinning: name and municipality_code are required and trimmed;
// blank optionals are OMITTED from the wire body, never sent as empty strings;
// on_behalf_of_owner_email is lower-cased; and the create body carries NO budget
// (the plan is the baseline's source, LINA-219). The I/O wrapper
// (`createBuildDraftV2`) is not exercised here — it needs a session; the mapping
// is where the decisions live.
//
// Run: node --experimental-strip-types --test src/lib/v2/build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toProjectCreateBody } from './build-create.ts';

const ID = '00000000-0000-4000-8000-000000000001';

test('maps the required fields and mints nothing (id is passed in)', () => {
  const body = toProjectCreateBody({ name: 'Maple Street', municipalityCode: '1106' }, ID);
  assert.deepEqual(body, { id: ID, name: 'Maple Street', municipality_code: '1106' });
});

test('trims name and municipality code', () => {
  const body = toProjectCreateBody({ name: '  Maple  ', municipalityCode: '  1106 ' }, ID);
  assert.equal(body.name, 'Maple');
  assert.equal(body.municipality_code, '1106');
});

test('forwards optional address and typology only when non-blank', () => {
  const body = toProjectCreateBody(
    { name: 'Maple', municipalityCode: '1106', siteAddress: ' 12 Elm Rd ', buildType: ' villa ' },
    ID,
  );
  assert.equal(body.address, '12 Elm Rd');
  assert.equal(body.typology, 'villa');
});

test('omits blank optionals rather than sending empty strings', () => {
  const body = toProjectCreateBody(
    { name: 'Maple', municipalityCode: '1106', siteAddress: '   ', buildType: '' },
    ID,
  );
  assert.ok(!('address' in body), 'blank address must be omitted');
  assert.ok(!('typology' in body), 'blank typology must be omitted');
});

test('lower-cases the on-behalf-of owner email', () => {
  const body = toProjectCreateBody(
    { name: 'Maple', municipalityCode: '1106', onBehalfOfOwnerEmail: ' Owner@Example.COM ' },
    ID,
  );
  assert.equal(body.on_behalf_of_owner_email, 'owner@example.com');
});

test('never carries a budget — the plan is the baseline source', () => {
  const body = toProjectCreateBody({ name: 'Maple', municipalityCode: '1106' }, ID);
  assert.ok(!('indicative_budget' in body));
  assert.ok(!('baseline_budget_cents' in body));
});

test('throws on a blank name (the form must validate first)', () => {
  assert.throws(() => toProjectCreateBody({ name: '   ', municipalityCode: '1106' }, ID), /name is required/);
});

test('throws on a blank municipality code (GAP-1)', () => {
  assert.throws(() => toProjectCreateBody({ name: 'Maple', municipalityCode: '' }, ID), /municipality code is required/);
});
