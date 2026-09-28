// Unit tests for the v2 phase wire→view seam (LINA-323, S6).
//
// The rules worth pinning: snake_case wire maps to the camelCase view the
// SignOffPanel + phase-signoff rules already render; the v2 projection carries no
// resolved display names, so `requestedByName`/`resolvedByName` stay null (names
// are never invented); sign-off history comes back newest-first; the execution
// phase is picked by `kind`, not sequence; and `signOffViewer` mirrors the v1
// accordion — everyone may request, and may decide any pending request they did
// not open (the self-approval bar), keyed on the person id `requested_by` holds.
//
// Run: node --experimental-strip-types --test src/lib/v2/phases-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toPhase, executionPhase, signOffViewer } from './phases-view.ts';

const signOff = (over = {}) => ({
  id: 'so1', phase_id: 'ph-exec', requested_by: 'person-gc',
  requested_at: '2026-09-20T10:00:00.000Z', status: 'pending',
  resolved_at: null, resolution_comment: null, ...over,
});

const wirePhase = (over = {}) => ({
  id: 'ph-exec', project_id: 'proj', kind: 'execution', name: 'Execution',
  status: 'active', sequence: 1, responsible_party_ids: ['org-owner'],
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
  sign_off_requests: [], ...over,
});

test('toPhase maps snake_case wire onto the camelCase view', () => {
  const p = toPhase(wirePhase({ sign_off_requests: [signOff()] }));
  assert.equal(p.id, 'ph-exec');
  assert.equal(p.projectId, 'proj');
  assert.equal(p.kind, 'execution');
  assert.equal(p.name, 'Execution');
  assert.equal(p.status, 'active');
  assert.equal(p.sequence, 1);
  assert.deepEqual(p.responsiblePartyIds, ['org-owner']);
  assert.equal(p.signOffRequests.length, 1);
  const r = p.signOffRequests[0];
  assert.equal(r.requestedBy, 'person-gc');
  assert.equal(r.requestedAt, '2026-09-20T10:00:00.000Z');
  assert.equal(r.status, 'pending');
  assert.equal(r.resolvedAt, null);
  assert.equal(r.resolutionComment, null);
});

test('names are never invented — the v2 projection joins none', () => {
  const p = toPhase(wirePhase({ sign_off_requests: [signOff({ status: 'approved', resolved_at: '2026-09-21T00:00:00.000Z' })] }));
  assert.equal(p.signOffRequests[0].requestedByName, null);
  assert.equal(p.signOffRequests[0].resolvedByName, null);
});

test('missing responsible_party_ids / sign_off_requests default to empty arrays', () => {
  const p = toPhase(wirePhase({ responsible_party_ids: undefined, sign_off_requests: undefined }));
  assert.deepEqual(p.responsiblePartyIds, []);
  assert.deepEqual(p.signOffRequests, []);
});

test('sign-off history comes back newest-first', () => {
  const p = toPhase(wirePhase({
    sign_off_requests: [
      signOff({ id: 'old', requested_at: '2026-09-10T00:00:00.000Z', status: 'rejected' }),
      signOff({ id: 'new', requested_at: '2026-09-20T00:00:00.000Z', status: 'pending' }),
    ],
  }));
  assert.deepEqual(p.signOffRequests.map((r) => r.id), ['new', 'old']);
});

test('enum values pass through verbatim (no coercion)', () => {
  const p = toPhase(wirePhase({ status: 'signed_off' }));
  assert.equal(p.status, 'signed_off');
});

test('executionPhase picks by kind, not sequence', () => {
  const phases = [
    toPhase(wirePhase({ id: 'proc', kind: 'procurement', sequence: 0, name: 'Procurement' })),
    toPhase(wirePhase({ id: 'exec', kind: 'execution', sequence: 1 })),
  ];
  assert.equal(executionPhase(phases)?.id, 'exec');
  // A widened enum / missing execution phase is null, not the first row.
  assert.equal(executionPhase([toPhase(wirePhase({ id: 'proc', kind: 'procurement' }))]), null);
});

test('signOffViewer: everyone may request; the requester may not decide their own', () => {
  const phase = toPhase(wirePhase({ sign_off_requests: [signOff({ requested_by: 'person-gc' })] }));

  const requester = signOffViewer(phase, 'person-gc');
  assert.equal(requester.canRequest, true);
  assert.equal(requester.canDecide, false, 'the requester cannot approve their own request');
  assert.equal(requester.partyId, 'person-gc');

  const other = signOffViewer(phase, 'person-owner');
  assert.equal(other.canRequest, true);
  assert.equal(other.canDecide, true, 'the counterparty may decide a request they did not open');
});

test('signOffViewer: no pending request means nobody has a decision to make', () => {
  const phase = toPhase(wirePhase({ sign_off_requests: [signOff({ status: 'approved', resolved_at: '2026-09-21T00:00:00.000Z' })] }));
  assert.equal(signOffViewer(phase, 'person-owner').canDecide, false);
});

test('signOffViewer tolerates a null phase and a null person', () => {
  const v = signOffViewer(null, null);
  assert.equal(v.canRequest, true);
  assert.equal(v.canDecide, false);
  assert.equal(v.partyId, null);
});
