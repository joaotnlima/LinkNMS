import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ERROR_STATUS, problem, problemResponse, ProblemError } from './errors.mjs';

describe('problem+json vocabulary (doc 11 §Errors)', () => {
  test('every doc-11 code exists with its documented status', () => {
    // The contract table, verbatim. A missing or re-numbered code here is a
    // wire-contract break, not a refactor.
    const contract = {
      unauthenticated: 401, not_entitled: 402,
      not_a_participant: 403, forbidden: 403, out_of_scope: 403, two_sided_rule: 403,
      not_found: 404,
      version_conflict: 409, invalid_transition: 409, dependency_cycle: 409,
      gone: 410, validation_failed: 422, rate_limited: 429,
    };
    for (const [code, status] of Object.entries(contract)) {
      assert.equal(ERROR_STATUS[code], status, code);
    }
  });

  test('problem() emits the RFC 9457 members and keeps extras subordinate', () => {
    const p = problem('not_entitled', 'Tendering needs the Pro plan', { upgrade_hint: '/settings/billing' });
    assert.equal(p.type, 'https://linknms.com/errors/not_entitled');
    assert.equal(p.status, 402);
    assert.equal(p.code, 'not_entitled');
    assert.equal(p.detail, 'Tendering needs the Pro plan');
    assert.equal(p.upgrade_hint, '/settings/billing');
  });

  test('extras can never override the reserved members', () => {
    const p = problem('forbidden', null, { status: 200, code: 'ok' });
    assert.equal(p.status, 403);
    assert.equal(p.code, 'forbidden');
  });

  test('unknown codes are a programming error, loudly', () => {
    assert.throws(() => problem('nope'), /unknown problem code/);
  });

  test('problemResponse carries the media type', () => {
    const r = problemResponse('validation_failed', null, { errors: { name: 'required' } });
    assert.equal(r.status, 422);
    assert.equal(r.headers['content-type'], 'application/problem+json');
    assert.deepEqual(r.body.errors, { name: 'required' });
  });

  test('ProblemError carries the same body a response would', () => {
    const err = new ProblemError('two_sided_rule', 'Proposer cannot decide');
    assert.equal(err.problem.status, 403);
    assert.equal(err.problem.code, 'two_sided_rule');
  });
});
