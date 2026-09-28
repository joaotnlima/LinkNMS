import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toAuditEntry } from './audit-view.mjs';

const base = {
  seq: '3',
  occurred_at: '2026-09-20T10:00:00.000Z',
  category: 'planning',
  type: 'planning.progress.reported',
  actor_person_id: 'p1', actor_org_id: 'o1', actor_org_role: 'site_lead',
  object_type: 'task', object_id: 't1',
  entry_hash: 'abcd', prev_hash: '00ff',
  payload: { percent: 40 }, redacted: false,
};

describe('toAuditEntry', () => {
  test('shapes an in-scope entry, seq coerced to a number', () => {
    const e = toAuditEntry(base);
    assert.equal(e.seq, 3);
    assert.equal(typeof e.seq, 'number');
    assert.deepEqual(e.actor, { person_id: 'p1', org_id: 'o1', org_role: 'site_lead' });
    assert.equal(e.redacted, false);
    assert.deepEqual(e.payload, { percent: 40 });
    assert.equal(e.entry_hash, 'abcd');
    assert.equal(e.prev_hash, '00ff');
  });

  test('withholds the payload of a redacted entry but keeps the hashes', () => {
    const e = toAuditEntry({ ...base, redacted: true, payload: null });
    assert.equal(e.redacted, true);
    assert.equal('payload' in e, false, 'payload is absent, not null');
    // the chain must still be verifiable across a redacted entry
    assert.equal(e.entry_hash, 'abcd');
    assert.equal(e.prev_hash, '00ff');
    assert.equal(e.type, 'planning.progress.reported');
    assert.equal(e.seq, 3);
  });

  test('never leaks a payload the store left on a redacted row', () => {
    // defence in depth: even if a caller passes redacted=true WITH a payload,
    // the body must not carry it.
    const e = toAuditEntry({ ...base, redacted: true });
    assert.equal('payload' in e, false);
  });

  test('a genesis entry has a null prev_hash', () => {
    const e = toAuditEntry({ ...base, seq: '1', prev_hash: null });
    assert.equal(e.prev_hash, null);
  });
});
