import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commandFor } from './mirror.mjs';

const user = (over = {}) => ({
  id: 'user_1',
  first_name: 'Inês',
  last_name: 'Sousa',
  primary_email_address_id: 'em_2',
  email_addresses: [
    { id: 'em_1', email_address: 'old@douro.pt' },
    { id: 'em_2', email_address: 'Ines@Douro.PT' },
  ],
  phone_numbers: [{ id: 'ph_1', phone_number: '+351910000000' }],
  primary_phone_number_id: 'ph_1',
  public_metadata: {},
  ...over,
});

test('user.created → upsert_person with the PRIMARY email, lowercased', () => {
  const cmd = commandFor({ type: 'user.created', data: user() });
  assert.deepEqual(cmd, {
    kind: 'upsert_person',
    clerkUserId: 'user_1',
    email: 'ines@douro.pt',
    name: 'Inês Sousa',
    phone: '+351910000000',
    platformRole: null,
  });
});

test('user without an email yet is ignored, platform_role is carried', () => {
  assert.equal(commandFor({ type: 'user.created', data: user({ email_addresses: [], primary_email_address_id: null }) }).kind, 'ignore');
  assert.equal(
    commandFor({ type: 'user.updated', data: user({ public_metadata: { platform_role: 'support' } }) }).platformRole,
    'support',
  );
});

test('user.deleted keeps the person (attribution outlives the account)', () => {
  assert.equal(commandFor({ type: 'user.deleted', data: { id: 'user_1', deleted: true } }).kind, 'ignore');
});

test('organization.created → upsert with kind from public_metadata', () => {
  const cmd = commandFor({
    type: 'organization.created',
    data: { id: 'org_1', name: 'Douro Lda', public_metadata: { kind: 'contractor', nif: '501234567' } },
  });
  assert.deepEqual(cmd, {
    kind: 'upsert_organization',
    clerkOrgId: 'org_1',
    orgKind: 'contractor',
    legalName: 'Douro Lda',
    nif: '501234567',
    approvalPolicy: 'any',
  });
});

test('organization without a valid kind is rejected, not guessed', () => {
  assert.equal(commandFor({ type: 'organization.created', data: { id: 'org_1', name: 'X', public_metadata: {} } }).kind, 'reject');
  assert.equal(commandFor({ type: 'organization.created', data: { id: 'org_1', name: 'X', public_metadata: { kind: 'club' } } }).kind, 'reject');
});

test('organization.deleted → the signed-contract guard, decided upstream', () => {
  assert.deepEqual(commandFor({ type: 'organization.deleted', data: { id: 'org_1' } }),
    { kind: 'guard_org_delete', clerkOrgId: 'org_1' });
});

test('membership events strip the org: prefix and check the role catalogue', () => {
  const data = { organization: { id: 'org_1' }, public_user_data: { user_id: 'user_1' }, role: 'org:site_lead' };
  assert.deepEqual(commandFor({ type: 'organizationMembership.created', data }), {
    kind: 'upsert_membership', clerkOrgId: 'org_1', clerkUserId: 'user_1', orgRole: 'site_lead',
  });
  assert.equal(commandFor({ type: 'organizationMembership.updated', data: { ...data, role: 'org:cfo' } }).kind, 'reject');
  assert.deepEqual(commandFor({ type: 'organizationMembership.deleted', data }), {
    kind: 'remove_membership', clerkOrgId: 'org_1', clerkUserId: 'user_1',
  });
});

test('unknown or malformed events are ignored', () => {
  assert.equal(commandFor({ type: 'session.created', data: {} }).kind, 'ignore');
  assert.equal(commandFor({}).kind, 'ignore');
});
