// Unit tests for the v2 tendering wire→view transforms (LINA-361, S5).
//
// The rules worth pinning: money that is ABSENT (the money gate withholding it)
// prints "—", never €0; unknown enum values read as themselves rather than a
// silent default; the compose/publish/award gates refuse for exactly the reasons
// the server does; lane ordering is stable (status rank, then bidder email).
//
// Run: node --experimental-strip-types --test src/lib/v2/tendering-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatMoney, rfpStatusBadge, proposalStatusBadge, recipientStatusBadge,
  parseRecipients, createBlockedReason, publishBlockedReason,
  orderLanes, isLive, awardBlockedReason, packageSpecialties,
} from './tendering-view.ts';

// ── money ─────────────────────────────────────────────────────────────────
test('formatMoney: whole euros, no cents', () => {
  assert.equal(formatMoney({ amount_cents: 18000000, currency: 'EUR' }), '€180,000');
  assert.equal(formatMoney({ amount_cents: 150050, currency: 'EUR' }), '€1,501');
});

test('formatMoney: ABSENT money is "—", never €0 (the money gate at work)', () => {
  assert.equal(formatMoney(undefined), '—');
  assert.equal(formatMoney(null), '—');
});

test('formatMoney: a non-EUR currency prints its code, negatives keep the sign', () => {
  assert.equal(formatMoney({ amount_cents: 5000, currency: 'USD' }), 'USD 50');
  assert.equal(formatMoney({ amount_cents: -2500, currency: 'EUR' }), '-€25');
});

// ── badges ───────────────────────────────────────────────────────────────
test('rfpStatusBadge: known lifecycle states', () => {
  assert.deepEqual(rfpStatusBadge('draft'), { label: 'Draft — not sent', tone: 'quiet' });
  assert.deepEqual(rfpStatusBadge('published'), { label: 'Out for bids', tone: 'live' });
  assert.deepEqual(rfpStatusBadge('awarded'), { label: 'Awarded', tone: 'good' });
});

test('badges: an unknown enum value reads as itself, not a default', () => {
  assert.equal(rfpStatusBadge('quantum').label, 'quantum');
  assert.equal(proposalStatusBadge('teleported').label, 'teleported');
  assert.equal(recipientStatusBadge('spam_flagged').label, 'spam_flagged');
});

test('recipientStatusBadge: v2 delivery vocabulary maps to issuer words', () => {
  assert.equal(recipientStatusBadge('sent').label, 'Invited');
  assert.equal(recipientStatusBadge('opened').label, 'Viewed');
  assert.equal(recipientStatusBadge('proposal_submitted').label, 'Proposal in');
  assert.equal(recipientStatusBadge('bounced').tone, 'warn');
});

// ── recipient parsing ──────────────────────────────────────────────────────
test('parseRecipients: splits, lowercases, dedupes against existing', () => {
  const r = parseRecipients('Ana@Co.pt, joao@x.pt\nana@co.pt', ['prior@x.pt']);
  assert.deepEqual(r.valid, ['ana@co.pt', 'joao@x.pt']);
  assert.deepEqual(r.duplicates, ['ana@co.pt']);
});

test('parseRecipients: a bad address is kept verbatim as invalid', () => {
  const r = parseRecipients('notanemail, ok@x.pt', []);
  assert.deepEqual(r.invalid, ['notanemail']);
  assert.deepEqual(r.valid, ['ok@x.pt']);
});

test('parseRecipients: an already-invited address is a duplicate, not re-added', () => {
  const r = parseRecipients('taken@x.pt', ['taken@x.pt']);
  assert.deepEqual(r.valid, []);
  assert.deepEqual(r.duplicates, ['taken@x.pt']);
});

// ── compose / publish gating ────────────────────────────────────────────────
test('createBlockedReason: needs title, tasks, and a deadline', () => {
  assert.match(createBlockedReason({ title: '', rootTaskIds: ['t'], submissionDeadline: 'x' }), /title/i);
  assert.match(createBlockedReason({ title: 'T', rootTaskIds: [], submissionDeadline: 'x' }), /task/i);
  assert.match(createBlockedReason({ title: 'T', rootTaskIds: ['t'], submissionDeadline: '' }), /deadline/i);
  assert.equal(createBlockedReason({ title: 'T', rootTaskIds: ['t'], submissionDeadline: 'x' }), null);
});

test('publishBlockedReason: draft with recipients only', () => {
  assert.match(publishBlockedReason(null, 1), /create/i);
  assert.match(publishBlockedReason({ status: 'published' }, 1), /already/i);
  assert.match(publishBlockedReason({ status: 'draft' }, 0), /contractor/i);
  assert.equal(publishBlockedReason({ status: 'draft' }, 2), null);
});

// ── inbox ordering + award gating ───────────────────────────────────────────
const lane = (over = {}) => ({
  proposal_id: over.proposal_id ?? 'p', bidder: over.bidder ?? { email: 'z@x.pt', org_id: 'o' },
  channel: 'platform', status: over.status ?? 'submitted', missing_lines: 0, variant_lines: 0,
  document_count: 0, has_plan: false, url: '/p', ...over,
});

test('orderLanes: in-lanes lead, shortlisted above submitted, ties by email', () => {
  const ordered = orderLanes([
    lane({ proposal_id: '1', status: 'invited', bidder: { email: 'a@x.pt' } }),
    lane({ proposal_id: '2', status: 'submitted', bidder: { email: 'c@x.pt' } }),
    lane({ proposal_id: '3', status: 'shortlisted', bidder: { email: 'b@x.pt' } }),
    lane({ proposal_id: '4', status: 'submitted', bidder: { email: 'a@x.pt' } }),
  ]);
  assert.deepEqual(ordered.map((l) => l.proposal_id), ['3', '4', '2', '1']);
});

test('isLive: only submitted/shortlisted', () => {
  assert.equal(isLive({ status: 'submitted' }), true);
  assert.equal(isLive({ status: 'shortlisted' }), true);
  assert.equal(isLive({ status: 'declined' }), false);
  assert.equal(isLive({ status: 'invited' }), false);
});

test('awardBlockedReason: needs a live winner with an org, and a closeable RFP', () => {
  const winner = { status: 'submitted', bidder: { email: 'w@x.pt', org_id: 'o' } };
  // no winner picked
  assert.match(awardBlockedReason({ status: 'closed' }, [], null), /pick/i);
  // winner not live
  assert.match(
    awardBlockedReason({ status: 'closed' }, [], { status: 'declined', bidder: { email: 'w@x.pt', org_id: 'o' } }),
    /not live/i,
  );
  // email bidder with no org
  assert.match(
    awardBlockedReason({ status: 'closed' }, [], { status: 'submitted', bidder: { email: 'w@x.pt' } }),
    /organisation/i,
  );
  // published but an invitee has not responded
  assert.match(
    awardBlockedReason({ status: 'published' }, [lane({ status: 'invited' }), winner], winner),
    /close/i,
  );
  // closed + live winner with org → clear
  assert.equal(awardBlockedReason({ status: 'closed' }, [winner], winner), null);
  // published + everyone responded + live winner → clear
  assert.equal(
    awardBlockedReason({ status: 'published' }, [lane({ status: 'declined' }), winner], winner),
    null,
  );
});

test('packageSpecialties: dedupes; empty is a real state', () => {
  assert.deepEqual(packageSpecialties({ specialties: ['roofing', 'roofing', 'electrical'] }), ['roofing', 'electrical']);
  assert.deepEqual(packageSpecialties({ specialties: [] }), []);
});
