// V7 redaction projection — the security-load-bearing transform: an
// out-of-scope entry must expose NOTHING but its chain-verifying skeleton.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toAuditEntry, toRecordPage } from './redaction.mjs';

const OCCURRED = new Date('2026-09-28T10:00:00.000Z');

function rawRow(overrides = {}) {
  return {
    seq: '7',
    occurred_at: OCCURRED,
    category: 'contracting',
    type: 'contracting.change_order.approved',
    actor_person_id: '11111111-1111-1111-1111-111111111111',
    actor_org_id: '22222222-2222-2222-2222-222222222222',
    actor_org_role: 'manager',
    object_type: 'change_order',
    object_id: '33333333-3333-3333-3333-333333333333',
    payload: { delta_cents: 125000, reason: 'extra footings' },
    entry_hash: 'aa'.repeat(32),
    prev_hash: 'bb'.repeat(32),
    visible: true,
    ...overrides,
  };
}

describe('toAuditEntry — V7 redaction', () => {
  test('an in-scope entry carries the full payload, actor and object', () => {
    const e = toAuditEntry(rawRow());
    assert.equal(e.seq, 7);
    assert.equal(e.occurred_at, '2026-09-28T10:00:00.000Z');
    assert.equal(e.category, 'contracting');
    assert.equal(e.type, 'contracting.change_order.approved');
    assert.deepEqual(e.actor, {
      person_id: '11111111-1111-1111-1111-111111111111',
      org_id: '22222222-2222-2222-2222-222222222222',
      org_role: 'manager',
    });
    assert.equal(e.object_type, 'change_order');
    assert.deepEqual(e.payload, { delta_cents: 125000, reason: 'extra footings' });
    assert.equal(e.redacted, false);
    assert.equal(e.entry_hash, 'aa'.repeat(32));
    assert.equal(e.prev_hash, 'bb'.repeat(32));
  });

  test('an out-of-scope entry keeps ONLY seq/occurred_at/category + both hashes', () => {
    const e = toAuditEntry(rawRow({ visible: false }));
    assert.deepEqual(Object.keys(e).sort(), [
      'category', 'entry_hash', 'occurred_at', 'prev_hash', 'redacted', 'seq',
    ]);
    assert.equal(e.redacted, true);
    // The hashes survive so the chain still verifies end to end (V7)…
    assert.equal(e.entry_hash, 'aa'.repeat(32));
    assert.equal(e.prev_hash, 'bb'.repeat(32));
    // …but NOTHING that could disclose the withheld change leaks.
    assert.equal(e.type, undefined);
    assert.equal(e.actor, undefined);
    assert.equal(e.object_type, undefined);
    assert.equal(e.object_id, undefined);
    assert.equal(e.payload, undefined);
  });

  test('a genesis entry (no prev) redacts to a null prev_hash, never a leak', () => {
    const e = toAuditEntry(rawRow({ visible: false, prev_hash: null }));
    assert.equal(e.prev_hash, null);
    assert.equal(e.redacted, true);
  });

  test('string occurred_at (test/import path) passes through as ISO', () => {
    const e = toAuditEntry(rawRow({ occurred_at: '2026-01-02T03:04:05.000Z' }));
    assert.equal(e.occurred_at, '2026-01-02T03:04:05.000Z');
  });
});

describe('toRecordPage', () => {
  test('maps rows and carries the cursor', () => {
    const page = toRecordPage([rawRow(), rawRow({ seq: '6', visible: false })], 'cursor6');
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0].redacted, false);
    assert.equal(page.items[1].redacted, true);
    assert.equal(page.next_cursor, 'cursor6');
  });

  test('a last page normalises an absent cursor to null', () => {
    const page = toRecordPage([rawRow()], undefined);
    assert.equal(page.next_cursor, null);
  });
});
