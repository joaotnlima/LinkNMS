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
  OWNER_INVITE_COPY,
  TOTAL_STEPS,
  BUILD_TYPES,
  buildTypeLabel,
  expectedStartOptions,
  CREATOR_ROLES,
  CREATOR_ROLE_COPY,
  isCreatorRole,
  BASICS_LEDE,
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
  // Basics moved one level down when `/projects/new` became the pre-Basics
  // "Your role" screen (LINA-227).
  assert.equal(hrefForStep('abc', 'basics'), '/projects/new/basics');
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

test('the wizard is three steps — the "Your role" screen is a pre-step, not counted', () => {
  // The pre-Basics role screen (LINA-227) is a question ahead of the rail, not a
  // numbered step: keeping TOTAL_STEPS at 3 is what makes the owner path past it
  // byte-identical to before (ADR-0016 §2).
  assert.equal(TOTAL_STEPS, 3);
});

// ── Creator role: the "Your role" screen (LINA-227, ADR-0016) ────────────────

test('isCreatorRole accepts exactly owner and counterparty', () => {
  for (const r of CREATOR_ROLES) assert.ok(isCreatorRole(r));
  assert.deepEqual([...CREATOR_ROLES], ['owner', 'counterparty']);
  for (const bad of ['subcontractor', 'OWNER', 'gc', '', null, undefined, 7, {}]) {
    assert.equal(isCreatorRole(bad), false, `${String(bad)} must not pass`);
  }
});

test('each creator role carries card copy and a distinct Continue label', () => {
  for (const r of CREATOR_ROLES) {
    const copy = CREATOR_ROLE_COPY[r];
    assert.ok(copy?.label && copy.desc && copy.tag && copy.continueLabel, `${r} is missing copy`);
    // "counterparty" is a schema word — the GC card must never surface it.
    assert.ok(!copy.label.includes('counterparty') && !copy.desc.includes('counterparty'));
  }
  // The two Continue labels differ, so the button reflects the selection.
  assert.notEqual(CREATOR_ROLE_COPY.owner.continueLabel, CREATOR_ROLE_COPY.counterparty.continueLabel);
});

test('the Basics lede reads for both creator roles and never assumes owner for the GC', () => {
  for (const r of CREATOR_ROLES) assert.ok(BASICS_LEDE[r]?.length > 0, `${r} lede missing`);
  // The GC path must not tell a general contractor they own the build.
  assert.ok(!/you own/i.test(BASICS_LEDE.counterparty));
});

test('the inverted first invite addresses the homeowner, never "counterparty"', () => {
  assert.equal(OWNER_INVITE_COPY.noun, 'homeowner');
  assert.ok(!OWNER_INVITE_COPY.noun.includes('counterparty'));
  assert.ok(OWNER_INVITE_COPY.emailPlaceholder.includes('@'));
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

test('expectedStartOptions lists months from the given now, YYYY-MM value + human label', () => {
  // A fixed "now" so the list is deterministic. 2026-03-14 → first option is
  // March 2026, and the list rolls over the year boundary correctly.
  const now = new Date(2026, 2, 14); // month is 0-based: 2 = March
  const opts = expectedStartOptions(now, 12);
  assert.equal(opts.length, 12);
  assert.deepEqual(opts[0], { value: '2026-03', label: 'March 2026' });
  // Zero-padded month.
  assert.deepEqual(opts[1], { value: '2026-04', label: 'April 2026' });
  // Ten months on from March is January of the next year.
  assert.deepEqual(opts[10], { value: '2027-01', label: 'January 2027' });
  // Default count is a year and a half.
  assert.equal(expectedStartOptions(now).length, 18);
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
