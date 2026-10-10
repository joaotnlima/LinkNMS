// Unit tests for the notification centre's view model (PRD-12 N-1, N-2).
// Run: node --test src/lib/v2/notifications-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupNotifications, safeAppPath, preferenceRows, preferencesFromForm, badgeText, categoryLabel,
} from './notifications-view.ts';

const NOW = new Date('2026-10-10T15:00:00Z');
const n = (id, created_at, over = {}) => ({
  id, category: 'bids', title: `t${id}`, created_at, read_at: null,
  object_ref: { type: 'rfp', id: 'r', url: '/projects/p/plan?task=t&tab=tender' }, ...over,
});

test('groups newest-first items into Today / Yesterday / Earlier, dropping empty groups', () => {
  const groups = groupNotifications([
    n('1', '2026-10-10T09:00:00Z'),
    n('2', '2026-10-09T23:59:00Z', { read_at: '2026-10-10T00:00:00Z' }),
    n('3', '2026-09-01T10:00:00Z'),
  ], NOW);
  assert.deepEqual(groups.map((g) => [g.key, g.items.map((i) => i.id)]), [
    ['today', ['1']], ['yesterday', ['2']], ['earlier', ['3']],
  ]);
  assert.equal(groups[0].items[0].unread, true);
  assert.equal(groups[1].items[0].unread, false);
  assert.equal(groups[0].items[0].categoryLabel, 'Bids received');
  assert.equal(groups[0].items[0].url, '/projects/p/plan?task=t&tab=tender');
  assert.deepEqual(groupNotifications([], NOW), []);
});

test('the deep link stays app-relative — never an open redirect', () => {
  assert.equal(safeAppPath('/projects/p'), '/projects/p');
  assert.equal(safeAppPath('https://evil.example'), '/notifications');
  assert.equal(safeAppPath('//evil.example'), '/notifications');
  assert.equal(safeAppPath('/\\evil'), '/notifications');
  assert.equal(safeAppPath(undefined), '/notifications');
});

test('preference rows pair the two channels per category, in server order', () => {
  const rows = preferenceRows([
    { category: 'bids', channel: 'in_app', enabled: true },
    { category: 'bids', channel: 'email', enabled: false },
    { category: 'variations', channel: 'in_app', enabled: false },
    { category: 'variations', channel: 'email', enabled: true },
  ]);
  assert.deepEqual(rows.map((r) => [r.category, r.inApp, r.email]), [['bids', true, false], ['variations', false, true]]);
  assert.equal(rows[0].label, 'Bids received');
  assert.equal(categoryLabel('unknown'), 'unknown');
});

test('form → PUT body: an unchecked box is an explicit off', () => {
  const on = new Set(['bids:in_app']);
  assert.deepEqual(preferencesFromForm(['bids'], (k) => on.has(k)), [
    { category: 'bids', channel: 'in_app', enabled: true },
    { category: 'bids', channel: 'email', enabled: false },
  ]);
});

test('bell badge: hidden at zero, capped at 99+', () => {
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(120), '99+');
});
