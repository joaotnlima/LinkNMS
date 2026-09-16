// Unit tests for the /plan accordion's pure rules (LINA-281): the Procurement
// header badge and which section opens by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { procurementBadge, defaultOpenSections } from './plan-accordion.ts';

test('procurementBadge maps each status to a labelled, toned badge', () => {
  assert.deepEqual(procurementBadge('active'), { label: 'Active', tone: 'warn' });
  // hasSignedContractor=true seeds procurement `pending` — it was skipped.
  assert.deepEqual(procurementBadge('pending'), { label: 'Skipped', tone: 'neutral' });
  // A constructor was chosen: procurement is history.
  assert.deepEqual(procurementBadge('archived'), { label: 'Closed', tone: 'ok' });
  assert.deepEqual(procurementBadge('signed_off'), { label: 'Closed', tone: 'ok' });
});

test('defaultOpenSections always opens Execution — the plan is never hidden', () => {
  // LINA-306: the founder landed with procurement active and saw no Gantt because
  // Execution was collapsed. Execution now opens in every state.
  assert.equal(defaultOpenSections('active', 'pending').execution, true);
  assert.equal(defaultOpenSections('pending', 'active').execution, true);
  assert.equal(defaultOpenSections('archived', 'archived').execution, true);
  assert.equal(defaultOpenSections(null, null).execution, true);
});

test('defaultOpenSections opens Procurement only while it is the active phase', () => {
  // Persona A: procurement runs first, execution waits — both open.
  assert.equal(defaultOpenSections('active', 'pending').procurement, true);
  // Persona B: contractor already signed, execution live — procurement collapses.
  assert.equal(defaultOpenSections('pending', 'active').procurement, false);
  // Constructor chosen: procurement archived, execution active — procurement collapsed.
  assert.equal(defaultOpenSections('archived', 'active').procurement, false);
  // A signed-off plan stands alone — procurement collapsed even if it were active.
  assert.equal(defaultOpenSections('active', 'signed_off').procurement, false);
  // A fully closed-out build: procurement is history, collapsed.
  assert.equal(defaultOpenSections('archived', 'archived').procurement, false);
});
