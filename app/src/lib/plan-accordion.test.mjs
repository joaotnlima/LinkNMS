// Unit tests for the /plan accordion's pure rules (LINA-281): the Procurement
// header badge and which section opens by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { procurementBadge, defaultOpenSection } from './plan-accordion.ts';

test('procurementBadge maps each status to a labelled, toned badge', () => {
  assert.deepEqual(procurementBadge('active'), { label: 'Active', tone: 'warn' });
  // hasSignedContractor=true seeds procurement `pending` — it was skipped.
  assert.deepEqual(procurementBadge('pending'), { label: 'Skipped', tone: 'neutral' });
  // A constructor was chosen: procurement is history.
  assert.deepEqual(procurementBadge('archived'), { label: 'Closed', tone: 'ok' });
  assert.deepEqual(procurementBadge('signed_off'), { label: 'Closed', tone: 'ok' });
});

test('defaultOpenSection opens the phase the party is working in', () => {
  // Persona A: procurement runs first, execution waits.
  assert.equal(defaultOpenSection('active', 'pending'), 'procurement');
  // Persona B: contractor already signed, execution is live from the start.
  assert.equal(defaultOpenSection('pending', 'active'), 'execution');
  // Constructor chosen: procurement archived, execution active.
  assert.equal(defaultOpenSection('archived', 'active'), 'execution');
  // A signed-off plan is the live surface even though its status is not `active`.
  assert.equal(defaultOpenSection('archived', 'signed_off'), 'execution');
});

test('defaultOpenSection falls back to execution when no phase is active', () => {
  // A fully closed-out build: the plan is still what a visitor came to read.
  assert.equal(defaultOpenSection('archived', 'archived'), 'execution');
  assert.equal(defaultOpenSection(null, null), 'execution');
});
