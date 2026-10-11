// Unit tests for the PRD-04 view model: source tags, suggestions, proof lines,
// the directory hand-off, "Ask for a proposal" and the company inbox.
//
// Run: node --test src/lib/v2/rfp-directory-view.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  sourceTag, recipientName, recipientNote, biddersSummary, emailInviteeCount, isSuggestionAdded, suggestionLine,
  proofLine, safeReturnTo, directoryHref, pendingFirst, defaultBidsDue,
  originLine, requestState, openRequestLine, openRequestAction, inboxTab,
} from './rfp-directory-view.ts';

const P = '01920000-0000-7000-8000-0000000000b1';
const T = '01920000-0000-7000-8000-0000000000d1';

describe('bidders tagged by source (X-4, X-5)', () => {
  const recipients = [
    { id: '1', org_id: 'o1', email: 'geral@telhados.pt', source: 'directory', company_name: 'Telhados do Norte' },
    { id: '2', email: 'obra@silva.pt', source: 'directory', company_name: 'Silva Roofing' },
    { id: '3', email: 'obra@amigo.pt', source: 'email' },
    { id: '4', email: 'old@x.pt' },
  ];

  test('tags, names and notes', () => {
    assert.equal(sourceTag('directory').label, 'Directory');
    assert.equal(sourceTag('asked_to_bid').label, 'Asked to bid');
    assert.equal(sourceTag(undefined).label, 'Email');
    assert.equal(recipientName(recipients[0]), 'Telhados do Norte');
    assert.equal(recipientName(recipients[2]), 'obra@amigo.pt');
    assert.equal(recipientNote(recipients[0]), null);
    assert.equal(recipientNote(recipients[1]), 'unclaimed profile');
    assert.equal(recipientNote(recipients[2]), 'not on LinkNMS yet');
  });

  test('summary and the e-mail invitees who get an unclaimed profile', () => {
    assert.equal(biddersSummary(recipients), '4 · 2 from the directory · 2 by email');
    assert.equal(biddersSummary([]), 'none yet');
    assert.equal(emailInviteeCount(recipients), 2);
  });
});

describe('suggested companies (X-1)', () => {
  const ranked = { org_id: 'o1', display_name: 'Telhados do Norte', claimed: true, distance_km: 6,
    record: { ranked: true, verified_clients: 3, builds: 4, tasks_finished: 7, tasks_on_time: 6 } };
  const unclaimed = { org_id: 'u1', display_name: 'Silva Roofing', claimed: false, distance_km: 14.2,
    record: { ranked: false, verified_clients: 0, builds: 0, tasks_finished: 0, tasks_on_time: 0 } };

  test('proof lines in the design’s words', () => {
    assert.deepEqual(suggestionLine(ranked), { tag: 'Verified', text: '6 km · 4 builds · 6 of 7 tasks on the planned date' });
    assert.deepEqual(suggestionLine(unclaimed), { tag: 'Stated', text: '14 km · unclaimed · No profile details yet' });
  });

  test('Added: a claimed company by its org, an unclaimed one by its directory name', () => {
    assert.equal(isSuggestionAdded(ranked, [{ org_id: 'o1' }]), true);
    assert.equal(isSuggestionAdded(unclaimed, [{ source: 'directory', company_name: 'Silva Roofing' }]), true);
    assert.equal(isSuggestionAdded(unclaimed, [{ source: 'email', company_name: 'Silva Roofing' }]), false);
    assert.equal(isSuggestionAdded(ranked, []), false);
  });

  test('the directory hand-off carries the task, the RFP and a safe way back', () => {
    const href = directoryHref({ projectId: P, taskId: T, rfpId: 'r1', specialtyCode: 'roofing' });
    const usp = new URLSearchParams(href.split('?')[1]);
    assert.equal(usp.get('specialty'), 'roofing');
    assert.equal(usp.get('near_project'), P);
    assert.equal(usp.get('for_rfp'), 'r1');
    assert.equal(safeReturnTo(usp.get('return_to')), `/projects/${P}/plan?task=${T}&tab=tender`);
    assert.equal(safeReturnTo('https://evil.example/projects'), null);
    assert.equal(safeReturnTo('//evil.example'), null);
    assert.equal(safeReturnTo(undefined), null);
  });
});

describe('asking to bid (X-5)', () => {
  test('proof line of a company asking', () => {
    assert.deepEqual(proofLine({ org_id: 'a', display_name: 'A', claimed: true, verified_clients: 2, builds: 3, tasks_finished: 5, tasks_on_time: 5 }),
      { tag: 'Verified', text: '3 builds on LinkNMS · 5 of 5 tasks on the planned date' });
    assert.deepEqual(proofLine({ org_id: 'b', display_name: 'B', claimed: true, verified_clients: 0, builds: 0, tasks_finished: 0, tasks_on_time: 0, distance_km: 31 }),
      { tag: 'Stated', text: 'No builds on LinkNMS yet · 31 km away' });
  });

  test('pending first, newest first', () => {
    const items = [
      { id: '1', status: 'declined', requested_at: '2026-12-03' },
      { id: '2', status: 'pending', requested_at: '2026-12-01' },
      { id: '3', status: 'pending', requested_at: '2026-12-02' },
    ];
    assert.deepEqual(pendingFirst(items).map((i) => i.id), ['3', '2', '1']);
  });
});

describe('Ask for a proposal (X-6, X-7)', () => {
  test('the new draft’s bids are due in two weeks', () => {
    const due = new Date(defaultBidsDue(new Date('2026-12-01T09:00:00')));
    assert.equal(Math.round((due.getTime() - new Date('2026-12-01T09:00:00').getTime()) / 86400000), 14);
    assert.equal(due.getHours(), 18);
  });
});

describe('the company inbox (X-9, X-10)', () => {
  const req = (over = {}) => ({
    rfp_id: 'r', recipient_id: 'rec', title: 'Roofing', origin: 'directory', issuer_level: 'owner',
    rfp_status: 'published', submission_deadline: '2027-01-20T18:00:00Z', task_count: 9, file_count: 1,
    invitation_status: 'sent', proposal_id: 'p', proposal_status: 'invited', awarded_to_me: false, ...over,
  });

  test('origin line', () => {
    assert.equal(originLine(req()), 'From the owner · found you in the directory · bids due 20 Jan 2027 · 9 tasks · 1 file');
    assert.match(originLine(req({ issuer_level: 'sub', origin: 'email', file_count: 0 })), /^From a general contractor · invited by email · .* · 9 tasks$/);
  });

  test('states: new, priced, awarded, not chosen, declined', () => {
    assert.deepEqual(requestState(req()), { label: 'New', tone: 'warn', canPrice: true, canDecline: true });
    assert.equal(requestState(req({ invitation_status: 'opened' })).label, 'Opened');
    assert.deepEqual(requestState(req({ proposal_status: 'submitted' })), { label: 'Proposal sent', tone: 'live', canPrice: true, canDecline: false });
    assert.equal(requestState(req({ rfp_status: 'awarded', awarded_to_me: true })).label, '✓ Awarded');
    assert.equal(requestState(req({ rfp_status: 'awarded' })).label, 'Not chosen');
    assert.equal(requestState(req({ invitation_status: 'declined' })).canPrice, false);
  });

  test('open requests: the line and what the company can do', () => {
    const o = { rfp_id: 'r', title: 'Roofing', issuer_level: 'owner', build: { name: 'Casa da Encosta' }, distance_km: 6.04,
      specialty_codes: ['roofing'], submission_deadline: '2027-01-20T18:00:00Z', task_count: 9 };
    assert.equal(openRequestLine(o), 'Casa da Encosta · 6 km away · from the owner · bids due 20 Jan 2027 · 9 tasks');
    assert.deepEqual(openRequestAction(o), { kind: 'ask' });
    assert.equal(openRequestAction({ ...o, my_request: { status: 'pending' } }).label, 'Asked — waiting for the owner');
    assert.equal(openRequestAction({ ...o, my_request: { status: 'approved' } }).open, true);
    assert.equal(inboxTab('near'), 'near');
    assert.equal(inboxTab(undefined), 'for-you');
  });
});
