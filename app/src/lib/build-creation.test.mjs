// Unit tests for the Band B wizard contract (LINA-179).
//
// Two seams are worth testing and the rest is copy:
//
//   1. `stepFor` — resuming a draft. Get it wrong in one direction and an owner
//      is re-asked a question the record has already answered; wrong in the other
//      and they are sent to an invite form whose submit is guaranteed to 409.
//   2. `inviteRoleFor` — it MIRRORS OPERATING_MODEL_ROLES in
//      services/identity/identity.mjs. The restatement is deliberate (that module
//      is server-only), so these assertions are the tripwire that makes a
//      contract drift fail here instead of as a 400 on the owner's last step.
//
// Run: node --test src/lib/  (Node's native TS type-stripping imports the .ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  stepFor,
  hrefForStep,
  inviteRoleFor,
  isOperatingModel,
  OPERATING_MODELS,
  OPERATING_MODEL_COPY,
  INVITE_ROLE_COPY,
  TOTAL_STEPS,
  BUILD_TYPES,
  buildTypeLabel,
} from './build-creation.ts';

// ── stepFor ─────────────────────────────────────────────────────────────────

test('a fresh draft owes the operating-model step', () => {
  assert.equal(stepFor({ status: 'draft', operatingModel: null }), 'model');
  assert.equal(stepFor({ status: 'draft' }), 'model');
});

test('a draft with a model owes the invite step', () => {
  assert.equal(stepFor({ status: 'draft', operatingModel: 'turnkey' }), 'invite');
  assert.equal(stepFor({ status: 'draft', operatingModel: 'direct' }), 'invite');
});

test('an active build is done — the first invite committed it', () => {
  assert.equal(stepFor({ status: 'active', operatingModel: 'hybrid' }), 'done');
});

test('an active build with no model is still done, not re-asked', () => {
  // Every pre-Band-B project: 0009 back-filled status='active' and left
  // operating_model NULL. Sending its owner into the wizard would 409 on a PATCH
  // that only accepts drafts.
  assert.equal(stepFor({ status: 'active', operatingModel: null }), 'done');
});

test('an unknown status is treated as done, never as a fresh draft', () => {
  // A build read from an API that predates migration 0009. The conservative
  // failure is "go to your build", not "re-run a wizard against a live record".
  assert.equal(stepFor({}), 'done');
  assert.equal(stepFor({ operatingModel: 'turnkey' }), 'done');
});

// ── hrefForStep ─────────────────────────────────────────────────────────────

test('every step has a route, and the ids are encoded into the path', () => {
  assert.equal(hrefForStep('abc', 'basics'), '/projects/new');
  assert.equal(hrefForStep('abc', 'model'), '/projects/abc/operating-model');
  assert.equal(hrefForStep('abc', 'invite'), '/projects/abc/invite');
  assert.equal(hrefForStep('abc', 'done'), '/projects/abc');
});

// ── inviteRoleFor — mirrors services/identity/identity.mjs ──────────────────

test('turnkey invites the general contractor (counterparty)', () => {
  assert.equal(inviteRoleFor('turnkey'), 'counterparty');
});

test('direct-to-specialty invites a subcontractor', () => {
  assert.equal(inviteRoleFor('direct'), 'subcontractor');
});

test('hybrid invites the GC first — V1 is one party per wizard pass', () => {
  // The service admits BOTH roles for hybrid (ADR-0011 OQ-3); the wizard picks
  // the GC, the party who runs the main build. If V2 offers the choice, this is
  // the assertion that has to change deliberately rather than by accident.
  assert.equal(inviteRoleFor('hybrid'), 'counterparty');
});

test('a legacy build with no model keeps R0 behaviour — the one GC', () => {
  assert.equal(inviteRoleFor(null), 'counterparty');
  assert.equal(inviteRoleFor(undefined), 'counterparty');
});

// ── tables ──────────────────────────────────────────────────────────────────

test('isOperatingModel accepts exactly the three models', () => {
  for (const m of OPERATING_MODELS) assert.ok(isOperatingModel(m));
  for (const bad of ['gc_led', 'TURNKEY', '', null, undefined, 7, {}]) {
    assert.equal(isOperatingModel(bad), false, `${String(bad)} must not pass`);
  }
});

test('every model carries screen copy, and every invite role a human noun', () => {
  for (const m of OPERATING_MODELS) {
    const copy = OPERATING_MODEL_COPY[m];
    assert.ok(copy?.label && copy.blurb && copy.consequence, `${m} is missing copy`);
    const role = inviteRoleFor(m);
    assert.ok(INVITE_ROLE_COPY[role]?.noun, `${role} is missing a noun`);
    // "counterparty" is a schema word. It must never reach a screen.
    assert.ok(!INVITE_ROLE_COPY[role].noun.includes('counterparty'));
  }
});

test('the wizard is three steps — the invite-sent state is a result, not a step', () => {
  assert.equal(TOTAL_STEPS, 3);
});

// ── Basics build type (LINA-219) ─────────────────────────────────────────────

test('build types have unique slugs and non-empty labels', () => {
  const slugs = new Set();
  for (const t of BUILD_TYPES) {
    assert.ok(t.value && t.label, `${JSON.stringify(t)} is malformed`);
    assert.ok(!slugs.has(t.value), `duplicate build-type slug ${t.value}`);
    slugs.add(t.value);
  }
  assert.ok(BUILD_TYPES.length >= 2);
});

test('buildTypeLabel maps a known slug, echoes an unknown one, and nulls a blank', () => {
  const first = BUILD_TYPES[0];
  assert.equal(buildTypeLabel(first.value), first.label);
  // An old stored value that predates a list change must never render blank.
  assert.equal(buildTypeLabel('legacy-slug'), 'legacy-slug');
  for (const empty of [null, undefined, '']) {
    assert.equal(buildTypeLabel(empty), null, `${String(empty)} should map to null`);
  }
});
