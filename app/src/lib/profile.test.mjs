// Unit tests for the response→outcome mapping in profile.ts (LINA-132).
//
// This is the correctness-critical seam of the account-setup screen: it decides
// whether a first-login POST means "into the portal", "fix this field", "sign in
// again", or "retry". Getting 409 wrong (it is SUCCESS, not an error) would trap
// a returning user on the setup screen forever. Run: node --test src/lib/
//
// Uses Node's native TS type-stripping (v22.18+) to import the .ts directly —
// interpretResponse is pure, so no DOM or fetch is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interpretResponse } from './profile.ts';

test('200 and 201 are success', () => {
  assert.equal(interpretResponse(200, { profile: {} }).kind, 'ok');
  assert.equal(interpretResponse(201, { profile: {} }).kind, 'ok');
});

test('409 already_setup is treated as success (idempotent)', () => {
  const r = interpretResponse(409, { error: { code: 'already_setup', message: 'x' } });
  assert.equal(r.kind, 'ok');
});

test('401 is unauthenticated', () => {
  assert.equal(interpretResponse(401, { error: { code: 'unauthenticated' } }).kind, 'unauthenticated');
});

test('422 with a known field maps to an inline field error', () => {
  const r = interpretResponse(422, { error: { field: 'displayName', message: 'too long' } });
  assert.deepEqual(r, { kind: 'field', field: 'displayName', message: 'too long' });
});

test('400 with a role field lands on the role control', () => {
  const r = interpretResponse(400, { error: { field: 'role', message: 'pick one' } });
  assert.equal(r.kind, 'field');
  assert.equal(r.field, 'role');
});

test('400 without a recognised field is a general error, not a field error', () => {
  const r = interpretResponse(400, { error: { message: 'bad' } });
  assert.equal(r.kind, 'error');
  assert.equal(r.message, 'bad');
});

test('400 with an unknown field name is not misrouted to a control', () => {
  const r = interpretResponse(422, { error: { field: 'clerkUserId', message: 'nope' } });
  assert.equal(r.kind, 'error');
});

test('429 and 5xx are retryable', () => {
  assert.equal(interpretResponse(429, null).kind, 'retry');
  assert.equal(interpretResponse(500, null).kind, 'retry');
  assert.equal(interpretResponse(503, {}).kind, 'retry');
});

test('an unexpected 4xx is a general error', () => {
  assert.equal(interpretResponse(418, null).kind, 'error');
});

test('a missing/garbled body never throws', () => {
  assert.equal(interpretResponse(422, null).kind, 'error');
  assert.equal(interpretResponse(400, 'not-json').kind, 'error');
  assert.equal(interpretResponse(200, undefined).kind, 'ok');
});
