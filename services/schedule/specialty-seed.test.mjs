// Guard: the migration seed and the in-memory seed must not drift (LINA-306).
//
// The SQL migration 0014_specialty_catalog.sql seeds the system specialties as a
// VALUES list; the in-memory store seeds from SYSTEM_SPECIALTIES. If someone adds
// a trade to one and forgets the other, the picker behaves differently in tests
// than in prod. This asserts every SYSTEM_SPECIALTIES label appears verbatim in
// the migration's VALUES block, and that the labels are unique.
// Run: node --test services/schedule/specialty-seed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SYSTEM_SPECIALTIES } from './specialty-seed.mjs';

const migration = readFileSync(
  fileURLToPath(new URL('./migrations/0014_specialty_catalog.sql', import.meta.url)), 'utf8');

test('every seeded specialty label is present in the migration VALUES block', () => {
  for (const label of SYSTEM_SPECIALTIES) {
    assert.ok(
      migration.includes(`('${label}')`),
      `migration 0014 is missing the seeded specialty ('${label}')`);
  }
});

test('the seed list has no duplicate labels (case-insensitively)', () => {
  const seen = new Set();
  for (const label of SYSTEM_SPECIALTIES) {
    const key = label.trim().toLowerCase();
    assert.ok(!seen.has(key), `duplicate seed label: ${label}`);
    seen.add(key);
  }
});

test('the migration seeds exactly the SYSTEM_SPECIALTIES count', () => {
  // Count the seed VALUES rows — the lines of the form ('...') inside the INSERT.
  const rows = migration.match(/\(\s*'[^']+'\s*\)/g) ?? [];
  assert.equal(rows.length, SYSTEM_SPECIALTIES.length,
    'the migration VALUES row count must equal SYSTEM_SPECIALTIES.length');
});
