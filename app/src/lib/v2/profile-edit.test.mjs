// Unit tests for the onboarding profile-write field mapping (LINA-385, Phase
// 12b.6). The rules worth pinning: language widens to a locale (pt → pt-PT, en/es
// identity), the display name is trimmed, and a blank name is a defect (throws)
// because the form is expected to have validated it first.
//
// Run: node --experimental-strip-types --test src/lib/v2/profile-edit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localeForLanguage, toProfileUpdateBody } from './profile-edit.ts';

test('localeForLanguage widens pt to pt-PT and leaves en/es identity', () => {
  assert.equal(localeForLanguage('pt'), 'pt-PT');
  assert.equal(localeForLanguage('en'), 'en');
  assert.equal(localeForLanguage('es'), 'es');
});

test('toProfileUpdateBody trims the name and maps the language', () => {
  assert.deepEqual(
    toProfileUpdateBody({ displayName: '  Nuno Ferreira  ', language: 'pt' }),
    { name: 'Nuno Ferreira', locale: 'pt-PT' },
  );
  assert.deepEqual(
    toProfileUpdateBody({ displayName: 'Ana', language: 'es' }),
    { name: 'Ana', locale: 'es' },
  );
});

test('toProfileUpdateBody throws on a blank display name (a defect, not user error)', () => {
  assert.throws(() => toProfileUpdateBody({ displayName: '   ', language: 'en' }), /display name is required/);
  assert.throws(() => toProfileUpdateBody({ displayName: '', language: 'en' }), /display name is required/);
});
