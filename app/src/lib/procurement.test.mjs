// Unit tests for the procurement client helpers (LINA-283).
//
// The composer is copy + layout; these are the seams that can be wrong silently:
//   1. `parseRecipients` decides who gets a tokenised invitation — a false
//      positive mails a stranger, a missed duplicate sends two tokens for one
//      bid, and a lost address means a contractor never hears about the job;
//   2. `sendBlockedReason` is the only thing between "draft" and the one-way
//      send, so it must refuse exactly what the server refuses;
//   3. `budgetRange` / `timelineWords` quote a stranger's bid back to the owner,
//      so they have to be boringly right;
//   4. `canSkipToExecution` must never offer to skip past live invitations.
//
// Run: node --test --experimental-strip-types src/lib/procurement.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  budgetRange, canSkipToExecution, inboxRows, parseRecipients, recipientBadge,
  sendBlockedReason, timelineWords,
} from './procurement.ts';

const rfp = (over = {}) => ({
  id: 'rfp-1', phaseId: 'ph-1', description: 'Full build, 210 m²',
  attachments: [], specialties: [], status: 'draft', updatedAt: '2026-09-13T10:00:00.000Z',
  ...over,
});

const recipient = (id, email, status = 'invited') => ({ id, email, status });

const proposal = (id, rfpRecipientId, submittedAt, over = {}) => ({
  id, rfpRecipientId, companyName: `Co ${id}`, websiteUrl: null, portfolioImages: [],
  budgetMinCents: 100_00, budgetMaxCents: 200_00, timelineDays: 90, comment: null,
  submittedAt, ...over,
});

const view = (over = {}) => ({
  phase: { id: 'ph-1', kind: 'procurement', name: 'Procurement', status: 'active', sequence: 0 },
  rfp: rfp(), recipients: [], proposals: [], selectedProposalId: null, ...over,
});

// ── parseRecipients ──────────────────────────────────────────────────────────

test('parseRecipients takes one typed address', () => {
  assert.deepEqual(parseRecipients('ana@obra.pt').valid, ['ana@obra.pt']);
});

test('parseRecipients splits a paste on commas, semicolons, newlines and tabs', () => {
  const out = parseRecipients('a@x.pt, b@x.pt;c@x.pt\nd@x.pt\te@x.pt');
  assert.deepEqual(out.valid, ['a@x.pt', 'b@x.pt', 'c@x.pt', 'd@x.pt', 'e@x.pt']);
  assert.deepEqual(out.invalid, []);
});

test('parseRecipients lowercases, so one contractor is not invited twice', () => {
  const out = parseRecipients('Ana@Obra.PT, ana@obra.pt');
  assert.deepEqual(out.valid, ['ana@obra.pt']);
  assert.deepEqual(out.duplicates, ['ana@obra.pt']);
});

test('parseRecipients treats the existing list as already-seen', () => {
  const out = parseRecipients('ana@obra.pt, novo@obra.pt', ['ANA@obra.pt']);
  assert.deepEqual(out.valid, ['novo@obra.pt']);
  assert.deepEqual(out.duplicates, ['ana@obra.pt']);
});

test('parseRecipients keeps a typo verbatim so it can be corrected', () => {
  const out = parseRecipients('ana@obra, @obra.pt, ok@obra.pt, plain-text');
  assert.deepEqual(out.valid, ['ok@obra.pt']);
  assert.deepEqual(out.invalid, ['ana@obra', '@obra.pt', 'plain-text']);
});

test('parseRecipients strips the angle brackets an email client pastes', () => {
  assert.deepEqual(parseRecipients('<ana@obra.pt>').valid, ['ana@obra.pt']);
});

test('parseRecipients accepts plus-tags and multi-label domains', () => {
  const out = parseRecipients('ana+rfp@obra.co.uk');
  assert.deepEqual(out.valid, ['ana+rfp@obra.co.uk']);
});

test('parseRecipients on empty or whitespace-only input yields nothing, not an error', () => {
  const out = parseRecipients('  \n\t ');
  assert.deepEqual(out, { valid: [], invalid: [], duplicates: [] });
});

// ── sendBlockedReason ────────────────────────────────────────────────────────

test('sendBlockedReason: no RFP, empty brief, no recipients, already sent', () => {
  assert.equal(sendBlockedReason(null, []), 'Start the RFP first.');
  assert.equal(
    sendBlockedReason(rfp({ description: '   ' }), [recipient('r1', 'a@x.pt')]),
    'Describe the work before sending it out.',
  );
  assert.equal(sendBlockedReason(rfp(), []), 'Add at least one contractor to send it to.');
  assert.equal(
    sendBlockedReason(rfp({ status: 'sent' }), [recipient('r1', 'a@x.pt')]),
    'This RFP has already been sent.',
  );
});

test('sendBlockedReason returns null once the RFP is actually sendable', () => {
  assert.equal(sendBlockedReason(rfp(), [recipient('r1', 'a@x.pt')]), null);
});

// ── The vocabulary ───────────────────────────────────────────────────────────

test('recipientBadge covers the four states the column can hold', () => {
  assert.deepEqual(recipientBadge('invited'), { label: 'Invited', tone: 'quiet' });
  assert.deepEqual(recipientBadge('viewed'), { label: 'Viewed', tone: 'live' });
  assert.deepEqual(recipientBadge('submitted'), { label: 'Proposal in', tone: 'good' });
  assert.deepEqual(recipientBadge('declined'), { label: 'Declined', tone: 'off' });
});

test('recipientBadge shows an unknown status as itself rather than hiding it', () => {
  assert.equal(recipientBadge('withdrawn').label, 'withdrawn');
});

// ── Money & time ─────────────────────────────────────────────────────────────

test('budgetRange quotes a range, and a point quote as one figure', () => {
  assert.equal(budgetRange(180_000_00, 210_000_00), '$180,000 – $210,000');
  assert.equal(budgetRange(195_000_00, 195_000_00), '$195,000');
});

test('budgetRange refuses to invent a number from a broken one', () => {
  assert.equal(budgetRange(Number.NaN, 10), '—');
});

test('timelineWords says days up close and months at distance', () => {
  assert.equal(timelineWords(1), '1 day');
  assert.equal(timelineWords(30), '30 days');
  assert.equal(timelineWords(90), 'about 3 months');
  assert.equal(timelineWords(0), '—');
});

// ── The inbox ────────────────────────────────────────────────────────────────

test('inboxRows sorts newest-submitted first and joins the sending email', () => {
  const v = view({
    recipients: [recipient('r1', 'a@x.pt', 'submitted'), recipient('r2', 'b@x.pt', 'submitted')],
    proposals: [
      proposal('p1', 'r1', '2026-09-10T09:00:00.000Z'),
      proposal('p2', 'r2', '2026-09-12T09:00:00.000Z'),
    ],
    selectedProposalId: 'p1',
  });
  const rows = inboxRows(v);
  assert.deepEqual(rows.map((r) => r.proposal.id), ['p2', 'p1']);
  assert.deepEqual(rows.map((r) => r.email), ['b@x.pt', 'a@x.pt']);
  assert.deepEqual(rows.map((r) => r.selected), [false, true]);
});

test('inboxRows still renders a proposal whose recipient row is missing', () => {
  const rows = inboxRows(view({ proposals: [proposal('p1', 'gone', '2026-09-10T09:00:00.000Z')] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, null);
});

test('inboxRows does not mutate the view it was given', () => {
  const v = view({
    proposals: [
      proposal('p1', 'r1', '2026-09-10T09:00:00.000Z'),
      proposal('p2', 'r2', '2026-09-12T09:00:00.000Z'),
    ],
  });
  inboxRows(v);
  assert.deepEqual(v.proposals.map((p) => p.id), ['p1', 'p2']);
});

// ── Skipping ─────────────────────────────────────────────────────────────────

test('canSkipToExecution is offered with no RFP and with a draft one', () => {
  assert.equal(canSkipToExecution(view({ rfp: null })), true);
  assert.equal(canSkipToExecution(view()), true);
  assert.equal(
    canSkipToExecution(view({
      phase: { id: 'ph-1', kind: 'procurement', name: 'Procurement', status: 'pending', sequence: 0 },
      rfp: null,
    })),
    true,
  );
});

test('canSkipToExecution is withdrawn once invitations are live', () => {
  assert.equal(canSkipToExecution(view({ rfp: rfp({ status: 'sent' }) })), false);
});

test('canSkipToExecution is withdrawn once procurement itself is closed', () => {
  assert.equal(
    canSkipToExecution(view({
      phase: { id: 'ph-1', kind: 'procurement', name: 'Procurement', status: 'archived', sequence: 0 },
      rfp: null,
    })),
    false,
  );
});
