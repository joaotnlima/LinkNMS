// Unit tests for the v2 org-provisioning field mapping (LINA-365 increment 2).
//
// The rules worth pinning: 'owner' maps to a household and 'general_contractor'
// to a contractor org; legal_name is required and trimmed; nif and
// approval_policy are NEVER sent (the server defaults them, and the pen does not
// collect the nif); and an unmapped role throws rather than silently defaulting
// to a household (GAP-3). The I/O wrapper (`provisionOrgV2`) is not exercised
// here — it needs a session; the mapping is where the decisions live.
//
// Run: node --experimental-strip-types --test src/lib/v2/org.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toOrganizationCreateBody, kindForRole } from './org-provision.ts';

const ID = '00000000-0000-4000-8000-000000000001';

test("maps role 'owner' to a household org", () => {
  const body = toOrganizationCreateBody({ role: 'owner', displayName: 'The Silva Family' }, ID);
  assert.deepEqual(body, { id: ID, kind: 'household', legal_name: 'The Silva Family' });
});

test("maps role 'general_contractor' to a contractor org", () => {
  const body = toOrganizationCreateBody({ role: 'general_contractor', displayName: 'BuildCo Lda' }, ID);
  assert.deepEqual(body, { id: ID, kind: 'contractor', legal_name: 'BuildCo Lda' });
});

test('trims the legal name', () => {
  const body = toOrganizationCreateBody({ role: 'owner', displayName: '  The Silvas  ' }, ID);
  assert.equal(body.legal_name, 'The Silvas');
});

test('never sends nif or approval_policy — the server defaults them', () => {
  const body = toOrganizationCreateBody({ role: 'general_contractor', displayName: 'BuildCo' }, ID);
  assert.ok(!('nif' in body), 'nif must be omitted (captured later on the org profile)');
  assert.ok(!('approval_policy' in body), 'approval_policy must be omitted (server default)');
});

test('carries the passed-in id and mints nothing', () => {
  const body = toOrganizationCreateBody({ role: 'owner', displayName: 'Home' }, ID);
  assert.equal(body.id, ID);
});

test('throws on a blank display name (the form must validate first)', () => {
  assert.throws(() => toOrganizationCreateBody({ role: 'owner', displayName: '   ' }, ID), /display name is required/);
});

test('kindForRole throws on a role with no v2 kind (GAP-3)', () => {
  assert.throws(() => kindForRole('consultant'), /no v2 organization kind/);
});
