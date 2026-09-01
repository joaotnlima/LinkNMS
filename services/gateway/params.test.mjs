// The API boundary's param handling (LINA-79): `[id]` ⇄ `projectId` aliasing and
// the UUID shape check that keeps a malformed identifier from reaching Postgres
// as a `uuid` cast — a client input error must not be answered with a 500.
//
//   node --test services/gateway/params.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseParams, isUuid, ParamError } from './params.mjs';

const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/** Run `fn`, expecting it to throw, and hand back the error to assert on. */
function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a throw');
}

test('aliases id -> projectId and back, in both directions', () => {
  assert.deepEqual(normaliseParams({ id: UUID }), { id: UUID, projectId: UUID });
  assert.deepEqual(normaliseParams({ projectId: UUID }), { id: UUID, projectId: UUID });
});

test('a malformed identifier is a typed 400, not a throw the gateway logs as a 500', () => {
  const err = caught(() => normaliseParams({ id: 'not-a-uuid' }));
  assert.ok(err instanceof ParamError);
  assert.equal(err.status, 400);
  assert.equal(err.code, 'bad_request');
});

test('every UUID path param is checked, not just the project id', () => {
  for (const name of ['id', 'projectId', 'decisionId', 'changeOrderId']) {
    assert.throws(() => normaliseParams({ [name]: 'nope' }), ParamError, `${name} unchecked`);
    assert.doesNotThrow(() => normaliseParams({ [name]: UUID }));
  }
});

test('the 400 message names the param but never echoes the attacker-controlled value', () => {
  const err = caught(() => normaliseParams({ changeOrderId: "'; drop table --" }));
  assert.match(err.message, /changeOrderId/);
  assert.ok(!err.message.includes('drop table'));
});

test('a non-UUID param is left alone — an invitation token is base64url, not a UUID', () => {
  const token = 'Zm9vYmFyLXRva2VuLXZhbHVl';
  assert.deepEqual(normaliseParams({ token }), { token });
});

test('an absent or empty param is not an error; the handlers own "missing"', () => {
  assert.deepEqual(normaliseParams({}), {});
  assert.deepEqual(normaliseParams({ id: '' }), { id: '' });
});

test('isUuid accepts the canonical form and rejects near-misses', () => {
  assert.ok(isUuid(UUID));
  assert.ok(isUuid(UUID.toUpperCase()));
  assert.ok(!isUuid(`${UUID} `), 'trailing space');
  assert.ok(!isUuid(`${UUID}x`), 'trailing junk');
  assert.ok(!isUuid(UUID.replace(/-/g, '')), 'unhyphenated');
  // Postgres itself is laxer than this (it accepts unhyphenated forms), but the
  // API surface should have ONE spelling of an id so an audit trail and an ETag
  // cannot key off two representations of the same row.
  assert.ok(!isUuid('proj-1'));
  assert.ok(!isUuid(undefined));
  assert.ok(!isUuid(null));
});
