// Unit tests for the tender flow's view model (PRD-02): the composer's step
// states, the phrases that say what each step does to the plan, the stepper's
// dates, the side-by-side compare (no ranking, fit flags) and the panel face.
//
// Run: node --experimental-strip-types --test src/lib/v2/tender-flow-view.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  composeSteps, continueBlocked, coversLabel, leftOutLine, workWindowLine, scopeSummary,
  criticalNote, sendConfirmation, sendLabel, lifecycleSteps, cancelledLine, compareColumns,
  planWindowNote, awardConsequences, panelFace, offersCopyLink, deadlineFromInputs,
  inputsFromDeadline, duePhrase, daysUntil, isLanded,
} from './tender-flow-view.ts';

const window = {
  project_id: 'p', root_task_ids: ['roof'], covered_task_ids: ['roof', 'a', 'b'],
  left_out: [{ task_id: 'g', name: 'Gutters & skylight', reason: 'assigned', assignee: { org_id: 'o', name: 'Nuno Ferreira' } }],
  work_window: { start: '2027-02-01', finish: '2027-02-26', duration_wd: 20 },
  on_critical_path: true, critical_task_ids: ['a'], project_finish: '2027-04-30',
  mobilisation_lead_wd: 5, award_by: '2027-01-25', bids_due: '2027-01-20',
  wd_bids_due_to_start: 8, wd_bids_due_to_award_by: 3,
};

describe('compose steps (T-8)', () => {
  const facts = (over = {}) => ({ hasDraft: false, bidders: 0, visibility: 'invite_only', ...over });

  test('a fresh composer: Scope open, the rest locked', () => {
    assert.deepEqual(composeSteps(1, facts()), { 1: 'open', 2: 'locked', 3: 'locked' });
  });

  test('saved scope, on Bidders: Scope done (Edit), Review locked until a bidder', () => {
    assert.deepEqual(composeSteps(2, facts({ hasDraft: true })), { 1: 'done', 2: 'open', 3: 'locked' });
    assert.equal(continueBlocked(2, facts({ hasDraft: true })), 'Add at least one contractor.');
    assert.equal(continueBlocked(2, facts({ hasDraft: true, visibility: 'open' })), null);
  });

  test('editing Scope again keeps a complete Bidders step collapsed as done', () => {
    assert.deepEqual(composeSteps(1, facts({ hasDraft: true, bidders: 3 })), { 1: 'open', 2: 'done', 3: 'locked' });
    assert.deepEqual(composeSteps(3, facts({ hasDraft: true, bidders: 3 })), { 1: 'done', 2: 'done', 3: 'open' });
  });
});

describe('scope phrases (T-2..T-5)', () => {
  test('covers, left out, window', () => {
    assert.equal(coversLabel('Roofing', 10), 'Roofing + 9 sub-tasks');
    assert.equal(coversLabel('Roofing', 1), 'Roofing');
    assert.equal(leftOutLine(window.left_out[0]), 'Gutters & skylight — already assigned to Nuno Ferreira.');
    assert.match(workWindowLine(window), /^Work window from the plan: 1 Feb → 26 Feb 2027\. These dates lock/);
    assert.match(workWindowLine(null), /no dates yet/);
  });

  test('the step summary is one line', () => {
    const line = scopeSummary({ mode: 'detailed', taskName: 'Roofing', deadline: '2027-01-20T18:00:00', visibility: 'invite_only' });
    assert.equal(line, 'Detailed (build) · Roofing · bids due 20 Jan 2027, 18:00 · invite only');
  });

  test('the critical alert speaks planning\'s numbers, in the words of each step', () => {
    assert.match(criticalNote(window, 'Roofing', 'compose'), /leaves 3 working days to award before 25 Jan \(5 working days ahead of the 1 Feb start\)/);
    assert.equal(criticalNote(window, 'Roofing', 'follow'), "On the critical path. Award by 25 Jan or the build's finish date (30 Apr 2027) moves.");
    assert.match(criticalNote({ ...window, wd_bids_due_to_award_by: -2 }, 'Roofing', 'compose'), /come in after the award-by date/);
    assert.equal(criticalNote({ ...window, on_critical_path: false }, 'Roofing', 'follow'), null);
  });

  test('deadline inputs round-trip through an ISO instant', () => {
    const iso = deadlineFromInputs('2027-01-20', '18:00');
    assert.deepEqual(inputsFromDeadline(iso), { day: '2027-01-20', time: '18:00' });
    assert.equal(deadlineFromInputs('', '18:00'), '');
  });
});

describe('review & send (T-7)', () => {
  test('one confirmation says what sending does', () => {
    assert.equal(
      sendConfirmation({ bidders: 3, taskName: 'Roofing', visibility: 'invite_only' }),
      'This sends a personal link to 3 bidders and locks the dates of Roofing until you award.',
    );
    assert.equal(sendLabel(1), 'Send to 1 bidder');
  });
});

describe('lifecycle stepper with dates (T-10)', () => {
  test('out for bids: sent date, comparing from the deadline', () => {
    const steps = lifecycleSteps({
      status: 'published', created_at: '2027-01-09T10:00:00Z', published_at: '2027-01-12T10:00:00Z',
      submission_deadline: '2027-01-20T18:00:00Z',
    }, { proposalsIn: 1 });
    assert.deepEqual(steps.map((s) => [s.label, s.sub, s.state]), [
      ['Draft', '9 Jan', 'done'], ['Out for bids', 'sent 12 Jan', 'done'],
      ['Comparing', 'from 20 Jan', 'todo'], ['Awarded', '—', 'todo'],
    ]);
  });

  test('closed: comparing is your move; awarded names the winner', () => {
    const base = {
      created_at: '2027-01-09T10:00:00Z', published_at: '2027-01-12T10:00:00Z',
      closed_at: '2027-01-20T18:00:00Z', submission_deadline: '2027-01-20T18:00:00Z',
    };
    const closed = lifecycleSteps({ ...base, status: 'closed' }, { proposalsIn: 3 });
    assert.deepEqual(closed.slice(1, 3).map((s) => [s.sub, s.state]), [['12 Jan → 20 Jan', 'done'], ['3 proposals', 'now']]);
    const won = lifecycleSteps({ ...base, status: 'awarded' }, { proposalsIn: 3, winnerName: 'Telhados do Norte' });
    assert.deepEqual(won[3], { label: 'Awarded', sub: 'Telhados do Norte', state: 'won' });
  });

  test('a cancelled tender says when and why (T-19)', () => {
    assert.equal(cancelledLine({ cancelled_at: '2027-01-15T10:00:00Z', cancel_reason: 'Design changed' }), 'Tender cancelled on 15 Jan 2027: Design changed');
    assert.match(cancelledLine({}), /No reason was given/);
  });

  test('due phrases', () => {
    assert.equal(duePhrase(daysUntil('2027-01-20T18:00:00Z', '2027-01-14')), 'in 6 days');
    assert.equal(duePhrase(0), 'today');
    assert.equal(duePhrase(-1), '1 day ago');
  });
});

describe('side by side (T-14, T-15, T-17)', () => {
  const lane = (over) => ({
    proposal_id: 'p1', bidder: { name: 'Telhados do Norte', email: 't@n.pt', org_id: 'o1' }, channel: 'platform',
    status: 'submitted', duration_wd: 18, start: '2027-02-01', validity_until: '2027-02-28',
    missing_lines: 0, variant_lines: 0, document_count: 2, has_plan: true, url: '/p',
    total: { amount_cents: 2140000, currency: 'EUR' }, ...over,
  });

  test('every landed bid is a column — shortlisting is not required — in list order, figures as quoted', () => {
    const cols = compareColumns([
      lane({}),
      lane({ proposal_id: 'p2', bidder: { email: 'v@c.pt' }, status: 'shortlisted', duration_wd: 30, start: '2027-02-15', missing_lines: 2, total: undefined }),
      lane({ proposal_id: 'p3', status: 'invited' }),
      lane({ proposal_id: 'p4', status: 'withdrawn' }),
    ], window);
    assert.deepEqual(cols.map((c) => c.proposalId), ['p1', 'p2']);
    assert.equal(cols[0].total, '€21,400');
    assert.equal(cols[1].total, '—', 'money withheld prints a dash, never €0');
    assert.equal(cols[1].name, 'v@c.pt');
    assert.equal(cols[0].validUntil, '28 Feb 2027');
    assert.equal(cols[1].linesUnpriced, 2);
  });

  test('a bid that does not fit the plan window is flagged (T-15)', () => {
    const [fits, late] = compareColumns([
      lane({}), lane({ proposal_id: 'p2', duration_wd: 30, start: '2027-02-15' }),
    ], window);
    assert.equal(fits.durationFits, true);
    assert.equal(fits.startFits, true);
    assert.equal(late.durationFits, false);
    assert.equal(late.startFits, false);
    const [unknown] = compareColumns([lane({ duration_wd: undefined, start: undefined })], null);
    assert.equal(unknown.durationFits, null);
    assert.equal(unknown.startFits, null);
  });

  test('isLanded and the window note', () => {
    assert.equal(isLanded({ status: 'awarded' }), true);
    assert.equal(isLanded({ status: 'draft' }), false);
    assert.equal(planWindowNote(window, 'Roofing'), 'Plan window for this task: 1 Feb → 26 Feb 2027 (20 working days).');
  });

  test('the award confirmation states its consequences (T-16)', () => {
    assert.equal(
      awardConsequences({ winnerName: 'Telhados', otherBids: 2, taskName: 'Roofing' }),
      "This closes the tender, declines the other 2 bids and drafts their contract. Roofing's dates unlock so you can set them to the agreed start. Every proposal stays on the record.",
    );
  });
});

describe('panel face and copy link', () => {
  test('the face follows the lifecycle', () => {
    assert.equal(panelFace(null), 'none');
    assert.equal(panelFace({ status: 'draft' }), 'compose');
    assert.equal(panelFace({ status: 'published' }), 'follow');
    assert.equal(panelFace({ status: 'closed' }), 'compare');
    assert.equal(panelFace({ status: 'awarded' }), 'compare');
    assert.equal(panelFace({ status: 'cancelled' }), 'cancelled');
  });

  test('copy link is offered only to bidders who have not opened theirs (T-11)', () => {
    assert.equal(offersCopyLink({ status: 'sent' }), true);
    assert.equal(offersCopyLink({ status: 'opened' }), false);
    assert.equal(offersCopyLink({ status: 'proposal_submitted' }), false);
  });
});

describe('plan bridge after a panel write', async () => {
  const { procurementFromRfp, governingRfp } = await import('./tender-flow-view.ts');
  const { procurementChip } = await import('../plan-gantt.ts');

  test('an RFP → the grid chip, without a reload', () => {
    const p = procurementFromRfp({
      id: 'r1', status: 'published', title: 'Roofing', created_at: '2027-01-09T10:00:00Z',
      submission_deadline: '2027-01-20T18:00:00Z', excluded_task_ids: ['g'],
    }, { invited: 3, submitted: 0 });
    assert.equal(p.openedDay, '2027-01-09');
    assert.equal(p.bidsDueDay, '2027-01-20');
    assert.deepEqual(p.excludedTaskIds, ['g']);
    assert.equal(procurementChip(p).label, 'Out for bids · 0/3 in');
  });

  test('the governing RFP: named by the server, else newest live, else newest', () => {
    const rfps = [
      { id: 'new-cancelled', status: 'cancelled', root_task_ids: ['t'] },
      { id: 'older-live', status: 'published', root_task_ids: ['t'] },
      { id: 'other', status: 'draft', root_task_ids: ['x'] },
    ];
    assert.equal(governingRfp(rfps, 't').id, 'older-live');
    assert.equal(governingRfp(rfps, 't', 'new-cancelled').id, 'new-cancelled');
    assert.equal(governingRfp(rfps.slice(0, 1), 't').id, 'new-cancelled');
    assert.equal(governingRfp(rfps, 'none'), null);
  });
});
