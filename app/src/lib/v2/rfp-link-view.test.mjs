// Unit tests for the public RFP link's pure layer (LINA-360, S5).
//
// The rules worth pinning: the bid is a SINGLE EUR total (no range); a duration
// in weeks is FIVE working days, not seven; fractions are refused not rounded; a
// validity date in the past is refused; and a clean draft produces exactly the
// v2 submit body — EUR currency, empty document_ids, optionals omitted when blank.
//
// Run: node --experimental-strip-types --test src/lib/v2/rfp-link-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  durationToWorkingDays,
  formatEuro,
  formatWorkingDays,
  formatDateOnly,
  validateBid,
  WORKING_DAYS_PER_WEEK,
} from './rfp-link-view.ts';

const NOW = new Date('2026-09-28T12:00:00Z');

const goodDraft = {
  total: '250,000',
  durationValue: '12',
  durationUnit: 'weeks',
  conditions: '',
  validityUntil: '',
};

test('a week is five working days, not seven', () => {
  assert.equal(durationToWorkingDays('2', 'weeks'), 10);
  assert.equal(durationToWorkingDays('3', 'wd'), 3);
  assert.equal(WORKING_DAYS_PER_WEEK, 5);
});

test('duration refuses fractions and non-positive values', () => {
  assert.throws(() => durationToWorkingDays('2.5', 'weeks'), /whole number/);
  assert.throws(() => durationToWorkingDays('0', 'wd'), /whole number/);
  assert.throws(() => durationToWorkingDays('-3', 'wd'), /whole number/);
});

test('a clean draft maps to the exact v2 submit body', () => {
  const r = validateBid(goodDraft, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, {
    total: { amount_cents: 25_000_000, currency: 'EUR' },
    duration_wd: 60,
    document_ids: [],
  });
});

test('optional conditions and validity are carried when present', () => {
  const r = validateBid(
    { ...goodDraft, conditions: '  price assumes dry weather ', validityUntil: '2026-12-31' },
    NOW,
  );
  assert.equal(r.ok, true);
  assert.equal(r.body.conditions, 'price assumes dry weather');
  assert.equal(r.body.validity_until, '2026-12-31');
});

test('a missing total and missing duration both report field errors', () => {
  const r = validateBid({ ...goodDraft, total: '', durationValue: '' }, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.errors.total);
  assert.ok(r.errors.durationValue);
});

test('a zero or negative total is refused', () => {
  const zero = validateBid({ ...goodDraft, total: '0' }, NOW);
  assert.equal(zero.ok, false);
  assert.ok(zero.errors.total);
});

test('a validity date in the past is refused; today is fine', () => {
  const past = validateBid({ ...goodDraft, validityUntil: '2026-09-27' }, NOW);
  assert.equal(past.ok, false);
  assert.ok(past.errors.validityUntil);

  const today = validateBid({ ...goodDraft, validityUntil: '2026-09-28' }, NOW);
  assert.equal(today.ok, true);
});

test('a malformed validity date is refused', () => {
  const r = validateBid({ ...goodDraft, validityUntil: '31/12/2026' }, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.errors.validityUntil);
});

test('formatters read money, working days and dates back the way a person says them', () => {
  assert.equal(formatEuro(25_000_000), '€250,000');
  assert.equal(formatWorkingDays(60), '12 weeks');
  assert.equal(formatWorkingDays(5), '1 week');
  assert.equal(formatWorkingDays(3), '3 working days');
  assert.equal(formatWorkingDays(1), '1 working day');
  assert.equal(formatDateOnly('2026-12-31'), 'Dec 31, 2026');
});
