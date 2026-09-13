// Unit tests for the token-scoped proposal helpers (LINA-284).
//
// This form is filled in by someone with no account, no support channel and no
// second chance — the RFP window can close under them. So the seams that can be
// wrong silently are the ones worth holding:
//
//   1. `validateProposalDraft` decides what reaches the record. A budget range
//      that parsed the wrong way, or a max below a min, becomes a figure the
//      homeowner quotes back in an argument six months later;
//   2. `normaliseWebsiteUrl` output is rendered as an ANCHOR on the homeowner's
//      proposals inbox — a surface with a real session behind it. A `javascript:`
//      URL getting through is the one genuinely dangerous bug on this screen;
//   3. `timelineToDays` writes an int column with a `> 0` check — a fraction
//      must be refused here, not rounded into a number nobody typed;
//   4. the two formatters print back what was submitted on the confirmation
//      page, so they have to be boringly right.
//
// Run: node --test --experimental-strip-types src/lib/rfp-proposal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_DRAFT,
  formatBudgetRange,
  formatTimeline,
  normaliseWebsiteUrl,
  submittedPath,
  timelineToDays,
  validateProposalDraft,
} from './rfp-proposal.ts';

/** A draft that passes, so each test can bend exactly one field. */
const draft = (over = {}) => ({
  ...EMPTY_DRAFT,
  companyName: 'Acme Builders',
  budgetMin: '250000',
  budgetMax: '310000',
  timelineValue: '12',
  timelineUnit: 'weeks',
  ...over,
});

// ── normaliseWebsiteUrl ──────────────────────────────────────────────────────

test('website: a bare domain gets https, because that is how people type one', () => {
  assert.equal(normaliseWebsiteUrl('acme-builders.com'), 'https://acme-builders.com/');
  assert.equal(normaliseWebsiteUrl('  www.acme.co.uk  '), 'https://www.acme.co.uk/');
});

test('website: an explicit http(s) scheme is kept as given', () => {
  assert.equal(normaliseWebsiteUrl('http://acme.com/work'), 'http://acme.com/work');
  assert.equal(normaliseWebsiteUrl('https://acme.com/work'), 'https://acme.com/work');
});

test('website: empty is null, not an error — the field is optional', () => {
  assert.equal(normaliseWebsiteUrl(''), null);
  assert.equal(normaliseWebsiteUrl('   '), null);
});

test('website: a script or data URL is refused, it would be linked on the inbox', () => {
  assert.throws(() => normaliseWebsiteUrl('javascript:alert(1)'), /http:\/\/ or https:\/\//);
  assert.throws(() => normaliseWebsiteUrl('data:text/html,<script>'), /http:\/\/ or https:\/\//);
  assert.throws(() => normaliseWebsiteUrl('file:///etc/passwd'), /http:\/\/ or https:\/\//);
});

test('website: a hostname with no dot is a typo or a local name, not a company site', () => {
  assert.throws(() => normaliseWebsiteUrl('localhost'), /web address/);
  assert.throws(() => normaliseWebsiteUrl('acmecom'), /web address/);
  assert.throws(() => normaliseWebsiteUrl('https://acme.'), /web address/);
});

// ── timelineToDays ───────────────────────────────────────────────────────────

test('timeline: weeks convert by seven, days pass through', () => {
  assert.equal(timelineToDays('12', 'weeks'), 84);
  assert.equal(timelineToDays('30', 'days'), 30);
  assert.equal(timelineToDays(' 1 ', 'weeks'), 7);
});

test('timeline: a fraction is refused rather than rounded into a number nobody typed', () => {
  assert.throws(() => timelineToDays('2.5', 'weeks'), /whole number/);
});

test('timeline: zero, negative and non-numeric are refused (int column, CHECK > 0)', () => {
  assert.throws(() => timelineToDays('0', 'weeks'), /whole number/);
  assert.throws(() => timelineToDays('-3', 'days'), /whole number/);
  assert.throws(() => timelineToDays('soon', 'days'), /whole number/);
  assert.throws(() => timelineToDays('', 'days'), /whole number/);
});

test('timeline: past ten years it is a typo, not an estimate', () => {
  assert.throws(() => timelineToDays('600', 'weeks'), /longer than this form accepts/);
});

// ── validateProposalDraft ────────────────────────────────────────────────────

test('validate: a good draft becomes integer cents and whole days', () => {
  const out = validateProposalDraft(draft({ websiteUrl: 'acme.com', comment: '  hello  ' }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.body, {
    companyName: 'Acme Builders',
    websiteUrl: 'https://acme.com/',
    portfolioImages: [],
    budgetMinCents: 25_000_000,
    budgetMaxCents: 31_000_000,
    timelineDays: 84,
    comment: 'hello',
  });
});

test('validate: money is parsed exactly — separators and a dollar sign are fine', () => {
  const out = validateProposalDraft(draft({ budgetMin: '$250,000.50', budgetMax: '310000' }));
  assert.equal(out.ok, true);
  assert.equal(out.body.budgetMinCents, 25_000_050);
});

test('validate: a third decimal is refused, never rounded', () => {
  const out = validateProposalDraft(draft({ budgetMin: '250000.999' }));
  assert.equal(out.ok, false);
  assert.match(out.errors.budgetMin, /two decimals/);
});

test('validate: max below min is reported on max, the field they will change', () => {
  const out = validateProposalDraft(draft({ budgetMin: '310000', budgetMax: '250000' }));
  assert.equal(out.ok, false);
  assert.equal(out.errors.budgetMax, 'The highest figure cannot be below the lowest one.');
  assert.equal(out.errors.budgetMin, undefined);
});

test('validate: an equal min and max is a fixed price, and is allowed', () => {
  const out = validateProposalDraft(draft({ budgetMin: '250000', budgetMax: '250000' }));
  assert.equal(out.ok, true);
});

test('validate: every problem is reported at once, not one submit at a time', () => {
  const out = validateProposalDraft({
    ...EMPTY_DRAFT, companyName: '  ', websiteUrl: 'javascript:x', timelineUnit: 'weeks',
  });
  assert.equal(out.ok, false);
  assert.deepEqual(Object.keys(out.errors).sort(), [
    'budgetMax', 'budgetMin', 'companyName', 'timelineValue', 'websiteUrl',
  ]);
});

test('validate: a blank money field says "give a figure", not the parser sentence', () => {
  const out = validateProposalDraft(draft({ budgetMin: '', budgetMax: '' }));
  assert.equal(out.ok, false);
  assert.equal(out.errors.budgetMin, 'Give a lowest figure.');
  assert.equal(out.errors.budgetMax, 'Give a highest figure.');
});

test('validate: an empty comment is null, not an empty string', () => {
  const out = validateProposalDraft(draft({ comment: '   ' }));
  assert.equal(out.ok, true);
  assert.equal(out.body.comment, null);
});

test('validate: a 4001-character comment is truncated to the column limit', () => {
  const out = validateProposalDraft(draft({ comment: 'x'.repeat(4100) }));
  assert.equal(out.ok, true);
  assert.equal(out.body.comment.length, 4000);
});

// ── formatters ───────────────────────────────────────────────────────────────

test('budget range: two ends print as a range, one end prints once', () => {
  assert.equal(formatBudgetRange(25_000_000, 31_000_000), '$250,000 – $310,000');
  assert.equal(formatBudgetRange(25_000_000, 25_000_000), '$250,000');
});

test('timeline: exact weeks read as weeks, everything else stays in days', () => {
  assert.equal(formatTimeline(84), '12 weeks');
  assert.equal(formatTimeline(7), '1 week');
  assert.equal(formatTimeline(30), '30 days');
  assert.equal(formatTimeline(1), '1 day');
  assert.equal(formatTimeline(0), '—');
});

test('submitted path: the token is encoded, never interpolated raw', () => {
  assert.equal(submittedPath('abc/def'), '/rfp/abc%2Fdef/submitted');
});
