// Clarification rules (PRD-08 H-6..H-9) and the two pure projections that
// carry them: the tendering home item and the answered-question email.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  questionsOpen, askRefusal, questionErrors, visibleClarifications, openQuestionCount, askedBy,
} from './clarifications.mjs';
import { clarificationBody } from './wire.mjs';
import { renderClarificationAnsweredEmail } from './clarification-email.mjs';
import { projectRfps } from './project-rfps.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOW = new Date('2027-01-10T12:00:00Z');
const ORG_A = 'a0000000-0000-7000-8000-00000000000a';
const ORG_B = 'b0000000-0000-7000-8000-00000000000b';
const REC_C = 'c0000000-0000-7000-8000-00000000000c';

const rows = [
  { id: '1', status: 'answered', question: 'Q1 from A', answer: 'yes', asked_by_org_id: ORG_A, asked_at: '2027-01-02T00:00:00Z' },
  { id: '2', status: 'open', question: 'Q2 from A', asked_by_org_id: ORG_A, asked_at: '2027-01-03T00:00:00Z' },
  { id: '3', status: 'open', question: 'Q3 from link C', asked_by_org_id: null, asked_by_recipient_id: REC_C, asked_at: '2027-01-01T00:00:00Z' },
  { id: '4', status: 'answered', question: 'Q4 from B', answer: 'no', asked_by_org_id: ORG_B, asked_at: '2027-01-04T00:00:00Z' },
];

describe('questionsOpen / askRefusal (H-9)', () => {
  test('open while published and before the deadline; no deadline means open', () => {
    assert.equal(questionsOpen({ status: 'published', questions_deadline: '2027-01-11T00:00:00Z' }, NOW), true);
    assert.equal(questionsOpen({ status: 'published', questions_deadline: null }, NOW), true);
    assert.equal(askRefusal({ status: 'published' }, NOW), null);
  });
  test('closed after the deadline, and in every other state', () => {
    assert.equal(questionsOpen({ status: 'published', questions_deadline: '2027-01-10T11:59:59Z' }, NOW), false);
    assert.match(askRefusal({ status: 'published', questions_deadline: '2027-01-09T00:00:00Z' }, NOW), /deadline has passed/);
    for (const status of ['draft', 'closed', 'awarded', 'cancelled']) {
      assert.equal(questionsOpen({ status }, NOW), false, status);
      assert.ok(askRefusal({ status }, NOW), status);
    }
  });
  test('questionErrors requires an id and a non-empty bounded question', () => {
    assert.deepEqual(questionErrors({ id: 'x', question: ' ' }, UUID), { id: 'client-generated UUIDv7 required', question: 'required' });
    assert.ok(questionErrors({ id: ORG_A, question: 'x'.repeat(4001) }, UUID).question);
    assert.deepEqual(questionErrors({ id: ORG_A, question: 'Does 4.1 include XPS?' }, UUID), {});
  });
});

describe('visibleClarifications (H-7, H-8)', () => {
  test('the issuer sees every question, none flagged mine, oldest first', () => {
    const seen = visibleClarifications(rows, { isIssuer: true, asker: { orgId: ORG_A } });
    assert.deepEqual(seen.map((s) => s.row.id), ['3', '1', '2', '4']);
    assert.ok(seen.every((s) => s.mine === false));
    assert.equal(openQuestionCount(rows), 2);
  });
  test("bidder A sees the answered ones (B's included, not as mine) and its own open one", () => {
    const seen = visibleClarifications(rows, { asker: { orgId: ORG_A } });
    assert.deepEqual(seen.map((s) => [s.row.id, s.mine]), [['1', true], ['2', true], ['4', false]]);
  });
  test('a link-only bidder is matched by its recipient row, never by a null org', () => {
    const seen = visibleClarifications(rows, { asker: { orgId: null, recipientId: REC_C } });
    assert.deepEqual(seen.map((s) => [s.row.id, s.mine]), [['3', true], ['1', false], ['4', false]]);
    assert.equal(askedBy(rows[2], { orgId: null }), false);
  });
  test('the wire never carries the asker', () => {
    const body = clarificationBody(rows[3], { mine: false });
    assert.deepEqual(Object.keys(body).sort(), ['answer', 'answered_at', 'asked_at', 'id', 'mine', 'question', 'status']);
    assert.ok(!JSON.stringify(body).includes(ORG_B));
  });
});

describe('renderClarificationAnsweredEmail (H-8)', () => {
  test('quotes question and answer, carries no link and no asker', () => {
    const e = renderClarificationAnsweredEmail({
      rfp: { title: 'Cobertura', project_name: 'Casa Silva' }, question: 'XPS <80mm>?', answer: 'Sim',
    });
    assert.match(e.subject, /Cobertura/);
    assert.match(e.text, /XPS <80mm>\?/);
    assert.match(e.html, /XPS &lt;80mm&gt;\?/);
    assert.ok(!/https?:\/\//.test(e.text + e.html), 'no link — tokens are stored hashed');
  });
});

describe('projectRfps (H-1)', () => {
  const base = {
    project_id: 'p', level: 'owner', purpose: 'execution', mode: 'detailed', visibility: 'invite_only',
    title: 'T', specialties: [], package_version: 1, version: 1, root_task_ids: ['t1'],
    covers: [{ task_id: 't1', name: 'Cobertura' }], covered_task_count: 4,
    lane_counts: { invited: 2, submitted: 1, shortlisted: 1 }, open_question_count: 3,
    submission_deadline: '2027-02-01T00:00:00Z', questions_deadline: '2027-01-20T00:00:00Z',
  };
  const items = projectRfps([
    { ...base, id: 'r1', issuer_org_id: ORG_A, status: 'published', created_at: '2027-01-01T00:00:00Z' },
    { ...base, id: 'r2', issuer_org_id: ORG_B, status: 'published', created_at: '2027-01-05T00:00:00Z',
      my_proposal_id: 'p9', my_proposal_status: 'submitted' },
  ], { viewerOrgId: ORG_A, now: NOW });

  test('newest first; the issuer gets n/m in, open questions and the winner slot', () => {
    assert.deepEqual(items.map((i) => i.id), ['r2', 'r1']);
    const mine = items[1];
    assert.equal(mine.viewer_role, 'issuer');
    assert.equal(mine.invited_count, 4);
    assert.equal(mine.submitted_count, 2);
    assert.equal(mine.open_question_count, 3);
    assert.equal(mine.awarded_to, null);
    assert.equal(mine.questions_open, true);
    assert.deepEqual(mine.covers, [{ task_id: 't1', name: 'Cobertura' }]);
    assert.equal(mine.covered_task_count, 4);
  });
  test('a bidder gets its own lane and none of the counts (V8: absent, not zero)', () => {
    const bid = items[0];
    assert.equal(bid.viewer_role, 'bidder');
    assert.deepEqual(bid.my_proposal, { id: 'p9', status: 'submitted' });
    for (const k of ['invited_count', 'submitted_count', 'open_question_count', 'awarded_to']) {
      assert.ok(!(k in bid), k);
    }
  });
});
