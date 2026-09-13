// Unit tests for the execution-phase sign-off rules (LINA-282, ADR-0023 §6/§8).
//
// The component is fetch plumbing and markup; these seams are the logic:
//   1. only ONE request is ever open, and a rejection stays the last word until
//      a newer request supersedes it;
//   2. the plan locks on a PENDING request, not only on `signed_off` — a plan
//      that moves under the approver makes the signature meaningless;
//   3. the requester never sees Approve, and the approver never sees "you have
//      no tasks";
//   4. the zero-task block disables the button rather than hiding it.
//
// Run: node --test src/lib/phase-signoff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  openRequest, standingRejection, approvedRequest, isPlanLocked,
  phaseBadge, signOffControls, countPlanTasks, pendingChangeKeys, signOffStamp,
} from './phase-signoff.ts';

const req = (over = {}) => ({
  id: 'r1', requestedBy: 'gc', requestedAt: '2026-03-01T09:00:00Z', status: 'pending', ...over,
});
const phase = (status, requests = []) => ({ id: 'ph1', status, signOffRequests: requests });

const DRIVER = { partyId: 'gc', canDecide: false, canRequest: true };
const APPROVER = { partyId: 'owner', canDecide: true, canRequest: false };
const BYSTANDER = { partyId: 'sub', canDecide: false, canRequest: false };

test('openRequest: the single pending row, and nothing else', () => {
  assert.equal(openRequest(null), null);
  assert.equal(openRequest(phase('active', [])), null);
  assert.equal(openRequest(phase('active', [req({ status: 'rejected' })])), null);
  assert.equal(openRequest(phase('active', [req({ id: 'r2' })])).id, 'r2');
});

test('standingRejection: only when the rejection is still the newest word', () => {
  const rejected = req({ id: 'r1', status: 'rejected', requestedAt: '2026-03-01T09:00:00Z', resolutionComment: 'Dates slip' });
  assert.equal(standingRejection(phase('active', [rejected])).resolutionComment, 'Dates slip');

  // A retry after the rejection supersedes it — the requester is no longer
  // being asked to answer, they are waiting again.
  const retry = req({ id: 'r2', requestedAt: '2026-03-05T09:00:00Z' });
  assert.equal(standingRejection(phase('active', [rejected, retry])), null);

  // Order in the array must not matter; recency does.
  assert.equal(standingRejection(phase('active', [retry, rejected])), null);
});

test('approvedRequest: the latest approval, by resolution time', () => {
  const a1 = req({ id: 'a1', status: 'approved', resolvedAt: '2026-03-02T10:00:00Z' });
  const a2 = req({ id: 'a2', status: 'approved', resolvedAt: '2026-04-02T10:00:00Z' });
  assert.equal(approvedRequest(phase('signed_off', [a1, a2])).id, 'a2');
  assert.equal(approvedRequest(phase('active', [])), null);
});

test('isPlanLocked: signed_off, archived, AND a pending request all lock', () => {
  assert.equal(isPlanLocked(null), false);
  assert.equal(isPlanLocked(phase('active')), false);
  assert.equal(isPlanLocked(phase('pending')), false);
  assert.equal(isPlanLocked(phase('active', [req()])), true);
  assert.equal(isPlanLocked(phase('signed_off', [req({ status: 'approved' })])), true);
  assert.equal(isPlanLocked(phase('archived')), true);
  // A rejection UNLOCKS — that is the whole point of "request changes".
  assert.equal(isPlanLocked(phase('active', [req({ status: 'rejected' })])), false);
});

test('phaseBadge: awaiting sign-off is a UI state layered over `active`', () => {
  assert.equal(phaseBadge(null), 'draft');
  assert.equal(phaseBadge(phase('pending')), 'draft');
  assert.equal(phaseBadge(phase('active')), 'active');
  assert.equal(phaseBadge(phase('active', [req()])), 'awaiting_sign_off');
  assert.equal(phaseBadge(phase('signed_off')), 'signed_off');
  assert.equal(phaseBadge(phase('archived')), 'archived');
});

test('signOffControls: an empty plan disables the button but keeps it visible', () => {
  const c = signOffControls(phase('active'), DRIVER, 0);
  assert.equal(c.showRequestButton, true);
  assert.equal(c.requestDisabled, true);
  assert.equal(c.requestBlockedReason, 'no-tasks');
  assert.match(c.requestBlockedCopy, /at least one task/i);
});

test('signOffControls: a plan with tasks enables it', () => {
  const c = signOffControls(phase('active'), DRIVER, 3);
  assert.equal(c.showRequestButton, true);
  assert.equal(c.requestDisabled, false);
  assert.equal(c.requestBlockedReason, null);
  assert.equal(c.locked, false);
});

test('signOffControls: the requester waits, the approver decides — never both', () => {
  const pending = phase('active', [req()]);

  const driver = signOffControls(pending, DRIVER, 3);
  assert.equal(driver.showAwaitingBanner, true);
  assert.equal(driver.showDecisionControls, false);
  assert.equal(driver.showRequestButton, false, 'no second request while one is open');
  assert.equal(driver.locked, true);

  const approver = signOffControls(pending, APPROVER, 3);
  assert.equal(approver.showDecisionControls, true);
  assert.equal(approver.showAwaitingBanner, false);
  assert.equal(approver.pendingRequest.id, 'r1');

  // A bystander sees the state but is offered nothing.
  const other = signOffControls(pending, BYSTANDER, 3);
  assert.equal(other.showDecisionControls, false);
  assert.equal(other.showRequestButton, false);
  assert.equal(other.locked, true);
});

test('signOffControls: an approver is never told to go add tasks', () => {
  const c = signOffControls(phase('active'), APPROVER, 0);
  assert.equal(c.showRequestButton, false);
  assert.equal(c.requestBlockedReason, 'not-permitted');
});

test('signOffControls: a rejection unlocks the plan and surfaces the comment', () => {
  const rejected = req({ status: 'rejected', resolvedAt: '2026-03-03T09:00:00Z', resolutionComment: 'Move the roof ahead of the render.' });
  const c = signOffControls(phase('active', [rejected]), DRIVER, 4);
  assert.equal(c.locked, false);
  assert.equal(c.rejection.resolutionComment, 'Move the roof ahead of the render.');
  assert.equal(c.showRequestButton, true, 'the driver can ask again');
  assert.equal(c.requestDisabled, false);
});

test('signOffControls: signed off locks, hides the button, and carries the approval', () => {
  const approved = req({ status: 'approved', resolvedAt: '2026-03-04T09:00:00Z', resolvedByName: 'Ana Reis' });
  const c = signOffControls(phase('signed_off', [approved]), DRIVER, 4);
  assert.equal(c.locked, true);
  assert.equal(c.showRequestButton, false);
  assert.equal(c.requestBlockedReason, 'already-signed-off');
  assert.equal(c.approval.resolvedByName, 'Ana Reis');
  assert.equal(c.badge, 'signed_off');
});

test('countPlanTasks: counts tasks and their sub-tasks, tolerates gaps', () => {
  assert.equal(countPlanTasks(null), 0);
  assert.equal(countPlanTasks([{ tasks: [] }]), 0);
  assert.equal(countPlanTasks([{ tasks: [{}, { children: [{}, {}] }] }, { tasks: [{}] }]), 5);
  assert.equal(countPlanTasks([{}]), 0, 'a phase with no tasks key is empty, not a crash');
});

test('pendingChangeKeys: only rows a change order actually names', () => {
  const s = pendingChangeKeys([{ targetKey: 'st-3' }, { targetKey: null }, {}, { targetKey: 'st-9' }]);
  assert.deepEqual([...s].sort(), ['st-3', 'st-9']);
  assert.equal(pendingChangeKeys(undefined).size, 0);
});

test('signOffStamp: a UTC date, or null rather than an invented one', () => {
  assert.equal(signOffStamp(req({ status: 'approved', resolvedAt: '2026-03-04T09:00:00Z' })), '4 March 2026');
  assert.equal(signOffStamp(req({ resolvedAt: null })), null);
  assert.equal(signOffStamp(req({ resolvedAt: 'not a date' })), null);
  assert.equal(signOffStamp(null), null);
});
