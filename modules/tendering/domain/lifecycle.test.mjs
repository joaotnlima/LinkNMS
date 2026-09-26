// Doc-09 tendering state machines, exhaustively: every action from every
// status — the allowed rows land where the doc says, everything else refuses
// with a reason (never a throw).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rfpTransition, proposalTransition } from './lifecycle.mjs';

const RFP_STATUSES = ['draft', 'published', 'closed', 'awarded', 'cancelled'];
const PROPOSAL_STATUSES = ['invited', 'draft', 'submitted', 'withdrawn', 'shortlisted', 'awarded', 'declined'];

describe('rfpTransition (doc 09 §RFP)', () => {
  const allowed = {
    publish: { draft: 'published' },
    close: { published: 'closed' },
    award: { closed: 'awarded' },
    cancel: { draft: 'cancelled', published: 'cancelled', closed: 'cancelled' },
  };

  for (const [action, table] of Object.entries(allowed)) {
    for (const status of RFP_STATUSES) {
      const to = table[status];
      test(`${action} on ${status} → ${to ?? 'refused'}`, () => {
        const outcome = rfpTransition(status, action);
        if (to) assert.deepEqual(outcome, { ok: true, to });
        else {
          assert.equal(outcome.ok, false);
          assert.match(outcome.reason, new RegExp(status));
        }
      });
    }
  }

  test('unknown action refuses', () => {
    assert.equal(rfpTransition('draft', 'reopen').ok, false);
  });
});

describe('proposalTransition (doc 09 §Proposal)', () => {
  const allowed = {
    start_draft: { invited: 'draft', draft: 'draft' },
    // invited → submitted is the issuer recording an emailed answer;
    // submitted → submitted is a bidder revision before the deadline.
    submit: { invited: 'submitted', draft: 'submitted', submitted: 'submitted' },
    withdraw: { submitted: 'withdrawn', shortlisted: 'withdrawn' },
    shortlist: { submitted: 'shortlisted' },
    award: { submitted: 'awarded', shortlisted: 'awarded' },
    decline: { invited: 'declined', draft: 'declined', submitted: 'declined', shortlisted: 'declined' },
  };

  for (const [action, table] of Object.entries(allowed)) {
    for (const status of PROPOSAL_STATUSES) {
      const to = table[status];
      test(`${action} on ${status} → ${to ?? 'refused'}`, () => {
        const outcome = proposalTransition(status, action);
        if (to) assert.deepEqual(outcome, { ok: true, to });
        else assert.equal(outcome.ok, false);
      });
    }
  }

  test('awarded and declined are terminal', () => {
    for (const status of ['awarded', 'declined', 'withdrawn']) {
      for (const action of ['start_draft', 'submit', 'withdraw', 'shortlist', 'award', 'decline']) {
        assert.equal(proposalTransition(status, action).ok, false, `${action} on ${status}`);
      }
    }
  });
});
