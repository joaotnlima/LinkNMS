// Unit tests for the tendering home + clarifications view model (PRD-08).
//
// Run: node --experimental-strip-types --test src/lib/v2/tendering-home-view.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupByLifecycle, coversText, inLabel, bidsDueLabel, openQuestionsLabel, myLaneLabel,
  issuerOrder, openCount, clarificationMeta, askState, questionProblem,
  legacyProcurementTarget, rfpPath, proposalsPath, newRfpPath, tenderingPath,
} from './tendering-home-view.ts';

const item = (over = {}) => ({
  id: 'r', project_id: 'p', issuer_org_id: 'o', level: 'owner', purpose: 'execution', mode: 'detailed',
  root_task_ids: ['t'], title: 'Cobertura', specialties: [], visibility: 'invite_only', package_version: 1,
  status: 'published', version: 1, submission_deadline: '2027-01-20T18:00:00Z',
  viewer_role: 'issuer', covers: [{ task_id: 't', name: 'Cobertura' }], covered_task_count: 4,
  questions_open: true, invited_count: 5, submitted_count: 2, open_question_count: 1, ...over,
});

describe('paths (to-be/20 §3) and the H-4 redirects', () => {
  test('canonical paths', () => {
    assert.equal(tenderingPath('p'), '/projects/p/tendering');
    assert.equal(rfpPath('p', 'r'), '/projects/p/tendering/rfps/r');
    assert.equal(proposalsPath('p', 'r', 'a,b'), '/projects/p/tendering/rfps/r/proposals?compare=a%2Cb');
    assert.equal(newRfpPath('p', { task: 't', mode: 'light' }), '/projects/p/tendering/rfps/new?task=t&mode=light');
  });
  test('old /plan/procurement links land on the new routes', () => {
    assert.equal(legacyProcurementTarget('p', { rfp: 'r' }), '/projects/p/tendering/rfps/r');
    assert.equal(legacyProcurementTarget('p', { rfp: 'r', compare: 'a,b' }), '/projects/p/tendering/rfps/r/proposals?compare=a%2Cb');
    assert.equal(legacyProcurementTarget('p', { task: 't' }), '/projects/p/tendering/rfps/new?task=t');
    assert.equal(legacyProcurementTarget('p', {}), '/projects/p/tendering');
  });
});

describe('home (H-1)', () => {
  test('grouped in lifecycle order, empty groups dropped', () => {
    const groups = groupByLifecycle([item({ id: 'a', status: 'awarded' }), item({ id: 'd', status: 'draft' }), item({ id: 'p' })]);
    assert.deepEqual(groups.map((g) => [g.status, g.items.map((i) => i.id)]), [['draft', ['d']], ['published', ['p']], ['awarded', ['a']]]);
  });
  test('covers, n/m in, bids due and open questions — issuer only for the counts', () => {
    assert.equal(coversText(item()), 'Cobertura + 3 sub-tasks');
    assert.equal(coversText(item({ covers: [], covered_task_count: 0 })), 'Cobertura');
    assert.equal(inLabel(item()), '2/5 in');
    assert.equal(inLabel(item({ viewer_role: 'bidder', invited_count: undefined })), null);
    assert.match(bidsDueLabel(item(), '2027-01-01T00:00:00Z'), /^Bids due 20 Jan 2027/);
    assert.match(bidsDueLabel(item(), '2027-02-01T00:00:00Z'), /^Bids were due/);
    assert.equal(openQuestionsLabel(item()), '1 question to answer');
    assert.equal(openQuestionsLabel(item({ viewer_role: 'bidder' })), null);
    assert.equal(myLaneLabel(item({ viewer_role: 'bidder', my_proposal: { id: 'x', status: 'submitted' } })), 'Your bid is in');
  });
});

describe('clarifications (H-6..H-9)', () => {
  const list = [
    { id: '1', question: 'a', status: 'answered', answer: 'x', asked_at: '2027-01-01T00:00:00Z', answered_at: '2027-01-02T00:00:00Z' },
    { id: '2', question: 'b', status: 'open', asked_at: '2027-01-03T00:00:00Z' },
    { id: '3', question: 'c', status: 'open', asked_at: '2027-01-02T00:00:00Z', mine: true },
  ];
  test('the issuer reads open questions first, oldest first', () => {
    assert.deepEqual(issuerOrder(list).map((c) => c.id), ['3', '2', '1']);
    assert.equal(openCount(list), 2);
  });
  test('meta lines never name an asker', () => {
    assert.match(clarificationMeta(list[0], 'bidder'), /sent to every bidder/);
    assert.match(clarificationMeta(list[2], 'bidder'), /^Your question/);
    assert.equal(clarificationMeta(list[1], 'bidder'), 'Waiting for an answer');
  });
  test('the ask box follows the server flag and says why it is closed', () => {
    assert.equal(askState(true, { questions_deadline: '2027-01-10T18:00:00Z', status: 'published' }).canAsk, true);
    const closed = askState(false, { questions_deadline: '2027-01-10T18:00:00Z', status: 'published' });
    assert.equal(closed.canAsk, false);
    assert.match(closed.note, /^Questions closed on 10 Jan 2027/);
    assert.match(askState(false, { status: 'closed' }).note, /no longer out for bids/);
    assert.equal(questionProblem('  '), 'Write your question first.');
    assert.equal(questionProblem('ok?'), null);
  });
});
