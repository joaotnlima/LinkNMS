// Unit tests for the party display projection (LINA-246).
//
// The one rule worth holding: a stage's owner is stored as an ID, and everything
// a human reads about them — initials, role word, tint — is derived HERE from the
// project members the screen already holds. These tests pin that nothing is
// invented when the directory does not hold the id, and that the two-letter
// initial is the first + last initial rather than the first two characters.
//
// Run: node --experimental-strip-types --test src/lib/party-display.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNKNOWN_PARTY, avatarTone, initials, partyIndex, partyOf, roleWord,
} from './party-display.ts';

test('initials: first + last, a mononym keeps one letter, nothing is "?"', () => {
  assert.equal(initials('Nuno Ferreira'), 'NF');
  assert.equal(initials('  marta   alves  almeida '), 'MA'); // first + LAST, not first two
  assert.equal(initials('Cher'), 'C');
  assert.equal(initials(''), '?');
  assert.equal(initials('   '), '?');
});

test('roleWord: a specialty sub is a Trade, never folded into the contractor', () => {
  assert.equal(roleWord('owner'), 'Owner');
  assert.equal(roleWord('counterparty'), 'General contractor');
  assert.equal(roleWord('subcontractor'), 'Trade');
  // An unrecognised role is a contract drift; the neutral answer is "Party" and
  // NOT the owner — guessing the owner would be inventing an attribution.
  assert.equal(roleWord('inspector'), 'Party');
  assert.equal(roleWord(null), 'Party');
  assert.equal(roleWord(undefined), 'Party');
});

test('avatarTone: two sides of the table — the owner, and everyone building', () => {
  assert.equal(avatarTone('owner'), 'owner');
  assert.equal(avatarTone('counterparty'), 'builder');
  assert.equal(avatarTone('subcontractor'), 'builder');
  assert.equal(avatarTone(null), 'builder');
});

test('partyOf: null means unassigned; an id the project does not hold is an honest gap', () => {
  const dir = partyIndex([
    { partyId: 'p1', name: 'Nuno Ferreira', role: 'counterparty' },
    { partyId: 'p2', name: 'Marta Almeida', role: 'owner' },
  ]);

  assert.equal(partyOf(dir, null), null);
  assert.equal(partyOf(dir, undefined), null);
  assert.equal(partyOf(dir, ''), null);

  assert.equal(partyOf(dir, 'p2').name, 'Marta Almeida');
  assert.equal(partyOf(dir, 'p2').role, 'owner');

  // A stage assigned to somebody who has since left the build: named as unknown,
  // NOT silently dropped and not silently re-pointed at anyone else.
  const gone = partyOf(dir, 'p9');
  assert.equal(gone.name, UNKNOWN_PARTY);
  assert.equal(gone.partyId, 'p9');
  assert.equal(gone.role, null);
  assert.equal(roleWord(gone.role), 'Party');
});
