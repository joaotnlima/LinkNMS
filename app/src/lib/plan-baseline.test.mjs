// Unit tests for the plan-baseline client contract (LINA-212).
//
// D11–D13 are mostly copy and layout. These seams are not, and each fails in a
// way that is expensive rather than obvious:
//
//   1. `awaitedPartyId` — the "who is this waiting for" banner. The roles SWAP
//      on a request-changes fork (contract §1), so anything that assumes the
//      owner is always the reviewer names the wrong person on v2 — a wrong
//      answer to the only question that screen asks.
//   2. `canWithdraw` / `canReview` — which affordances exist. Not the
//      permission (the server decides, §6), but showing the proposer a Reject
//      button that 403s is a promise the record cannot keep.
//   3. `diffEdits` — the D12a patch. It must carry ONLY what changed, must never
//      carry a structural field (§5 is dates and money only), and must refuse
//      rather than round or zero a value. A counter-proposal containing a number
//      nobody typed is the worst possible bug on this screen.
//   4. `totalCents` / `totalAfter` — the plan value and its delta. Unpriced must
//      read as unpriced, never as $0.00.
//
// Run: node --test src/lib/   (Node's native TS type-stripping imports the .ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  awaitedPartyId, canReview, canWithdraw, describeEdit, diffEdits, draftOf,
  stageCounts, stamps, toRows, totalAfter, totalCents,
} from './plan-baseline.ts';

const stage = (id, name, start, end, cents, children = []) => ({
  id, name, position: 0, trade: null,
  plannedStartDate: start, plannedEndDate: end, plannedCostCents: cents,
  children,
});

const TREE = [
  stage('s1', 'Foundations', '2026-03-02', '2026-03-20', 954_600, [
    stage('s1a', 'Excavation', '2026-03-02', '2026-03-09', 300_000),
  ]),
  stage('s2', 'Structure', '2026-03-23', '2026-04-30', 2_015_000),
];

const ROWS = toRows(TREE);

const version = (over = {}) => ({
  id: 'v-1', versionNo: 1, status: 'proposed',
  sourceImportId: null, supersedesVersionId: null,
  proposedByPartyId: 'gc', createdAt: '2026-03-04T16:08:00Z', frozenAt: null,
  acceptances: [{ partyId: 'gc', role: 'counterparty', kind: 'proposed', stampedAt: '2026-03-04T16:08:00Z' }],
  ...over,
});

const MEMBERS = [{ partyId: 'gc' }, { partyId: 'owner' }];

// ── toRows: the B1 gantt's shape, from the B2 projection ────────────────────

test('toRows aliases the planned dates to the names the mini-gantt reads', () => {
  assert.equal(ROWS[0].start, '2026-03-02');
  assert.equal(ROWS[0].end, '2026-03-20');
  assert.equal(ROWS[0].costCents, 954_600);
  assert.equal(ROWS[0].children[0].name, 'Excavation');
});

// ── the totals ──────────────────────────────────────────────────────────────

test('totalCents sums the whole tree, children included', () => {
  assert.equal(totalCents(ROWS), 954_600 + 300_000 + 2_015_000);
});

test('a plan nobody has priced has no total — not zero', () => {
  const rows = toRows([stage('a', 'A', '2026-03-02', '2026-03-09', null)]);
  assert.equal(totalCents(rows), null);
});

test('stageCounts separates actions from everything beneath them', () => {
  assert.deepEqual(stageCounts(ROWS), { actions: 2, subActions: 1, total: 3 });
});

// ── the stamps and the banner ───────────────────────────────────────────────

test('stamps splits authorship from acceptance', () => {
  const s = stamps(version());
  assert.equal(s.proposed.partyId, 'gc');
  assert.equal(s.accepted, null);
});

test('an open v1 proposed by the GC is awaiting the owner', () => {
  assert.equal(awaitedPartyId(version(), MEMBERS), 'owner');
});

test('the roles swap on a fork: a version the OWNER proposed awaits the GC', () => {
  const v2 = version({
    id: 'v-2', versionNo: 2, proposedByPartyId: 'owner', supersedesVersionId: 'v-1',
    acceptances: [{ partyId: 'owner', role: 'owner', kind: 'proposed', stampedAt: '2026-03-04T17:00:00Z' }],
  });
  assert.equal(awaitedPartyId(v2, MEMBERS), 'gc');
});

test('a terminal version is not awaiting anyone', () => {
  for (const status of ['accepted', 'rejected', 'withdrawn', 'superseded']) {
    assert.equal(awaitedPartyId(version({ status }), MEMBERS), null, status);
  }
});

// ── the affordances ─────────────────────────────────────────────────────────

test('only the proposer may withdraw, and only while it is open', () => {
  assert.equal(canWithdraw(version(), 'gc'), true);
  assert.equal(canWithdraw(version(), 'owner'), false);
  assert.equal(canWithdraw(version({ status: 'accepted' }), 'gc'), false);
  assert.equal(canWithdraw(version(), null), false);
});

test('only the other party reviews — a party never reviews its own proposal', () => {
  assert.equal(canReview(version(), 'owner'), true);
  assert.equal(canReview(version(), 'gc'), false);
  assert.equal(canReview(version({ status: 'rejected' }), 'owner'), false);
  assert.equal(canReview(version(), null), false);
});

// ── the D12a diff ───────────────────────────────────────────────────────────

const draftsOf = (rows, over = {}) => {
  const out = {};
  const visit = (r) => { out[r.id] = draftOf(r); r.children.forEach(visit); };
  rows.forEach(visit);
  for (const [id, patch] of Object.entries(over)) out[id] = { ...out[id], ...patch };
  return out;
};

test('an untouched plan produces no edits at all', () => {
  assert.deepEqual(diffEdits(ROWS, draftsOf(ROWS)), []);
});

test('only the changed field of the changed stage is sent', () => {
  const edits = diffEdits(ROWS, draftsOf(ROWS, { s2: { end: '2026-05-08' } }));
  assert.deepEqual(edits, [{ stageId: 's2', plannedEndDate: '2026-05-08' }]);
});

test('a changed value travels as integer cents', () => {
  const edits = diffEdits(ROWS, draftsOf(ROWS, { s1: { cost: '9,000.50' } }));
  assert.deepEqual(edits, [{ stageId: 's1', plannedCostCents: 900_050 }]);
});

test('a nested stage can be edited too', () => {
  const edits = diffEdits(ROWS, draftsOf(ROWS, { s1a: { start: '2026-03-03' } }));
  assert.deepEqual(edits, [{ stageId: 's1a', plannedStartDate: '2026-03-03' }]);
});

test('a date can be cleared, and that is a change', () => {
  const edits = diffEdits(ROWS, draftsOf(ROWS, { s2: { start: '' } }));
  assert.deepEqual(edits, [{ stageId: 's2', plannedStartDate: null }]);
});

test('an unparseable amount is refused, never rounded', () => {
  assert.throws(
    () => diffEdits(ROWS, draftsOf(ROWS, { s1: { cost: '9,000.999' } })),
    (err) => err.name === 'StageEditError' && err.stageId === 's1',
  );
});

test('clearing a value is refused rather than sent as zero', () => {
  assert.throws(
    () => diffEdits(ROWS, draftsOf(ROWS, { s1: { cost: '' } })),
    (err) => err.name === 'StageEditError' && err.stageId === 's1',
  );
});

test('a negative value is refused — a stage costing less than nothing is a typo', () => {
  assert.throws(() => diffEdits(ROWS, draftsOf(ROWS, { s1: { cost: '-100' } })), /StageEditError|value/);
});

test('the patch can never carry a structural field', () => {
  // Whatever a caller puts in the draft, the shape that leaves here is the
  // narrow StageEdit — dates and money only (contract §5).
  const edits = diffEdits(ROWS, draftsOf(ROWS, { s1: { cost: '1.00', name: 'Renamed', parentId: 'x' } }));
  assert.deepEqual(Object.keys(edits[0]).sort(), ['plannedCostCents', 'stageId']);
});

test('totalAfter reprices the plan as the counter-proposal would leave it', () => {
  const edits = diffEdits(ROWS, draftsOf(ROWS, { s1: { cost: '9,000.00' } }));
  assert.equal(totalAfter(ROWS, edits), 900_000 + 300_000 + 2_015_000);
});

test('describeEdit carries both sides of a change, unformatted', () => {
  const edits = diffEdits(ROWS, draftsOf(ROWS, { s2: { end: '2026-05-08', cost: '20,000.00' } }));
  const s = describeEdit(ROWS[1], edits[0]);
  // The start was not touched, so "after" restates it rather than dropping it —
  // a summary that showed a blank start would claim a change nobody made.
  assert.deepEqual(s.dates, {
    from: { start: '2026-03-23', end: '2026-04-30' },
    to: { start: '2026-03-23', end: '2026-05-08' },
  });
  assert.deepEqual(s.value, { fromCents: 2_015_000, toCents: 2_000_000 });
});

test('describeEdit reports only the side that changed', () => {
  const edits = diffEdits(ROWS, draftsOf(ROWS, { s2: { cost: '20,000.00' } }));
  const s = describeEdit(ROWS[1], edits[0]);
  assert.equal(s.dates, undefined);
  assert.equal(s.value.toCents, 2_000_000);
});
