// PRD-09 O-1, O-2: the build home's pillars and "what's waiting" rows, worded
// from the server's numbers. Run: node --test src/lib/v2/build-home-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pillarsFromOverview, waitingRows, planIsEmpty } from './build-home-view.ts';

const base = { project: { id: 'p', name: 'Casa', status: 'draft' }, open_variations: 0, open_questions: 0, pending_verifications: 0 };

test('an empty build: no plan, no contract, nothing open, no safety issue', () => {
  const p = pillarsFromOverview({ ...base, plan: { rows: 0, top_level: 0, start: null } });
  assert.deepEqual([p.schedule.status, p.schedule.label], ['none', 'No plan yet']);
  assert.deepEqual([p.budget.status, p.budget.label], ['none', 'No signed contract to show']);
  assert.deepEqual([p.scope.status, p.scope.label], ['green', 'Nothing open']);
  assert.deepEqual([p.safety.status, p.safety.label], ['green', 'No open safety issues']);
  assert.equal(planIsEmpty({ ...base, plan: { rows: 0, top_level: 0, start: null } }), true);
});

test('late against baseline, cost above the signed value, open items, a safety issue', () => {
  const p = pillarsFromOverview({
    ...base,
    plan: { rows: 12, top_level: 3, start: '2026-09-01' },
    end_date: { baseline: '2026-10-01', current: '2026-10-20', delta_wd: 13 },
    cost: { baseline: { amount_cents: 1000, currency: 'EUR' }, current: { amount_cents: 1200, currency: 'EUR' } },
    open_variations: 2, open_questions: 1,
    open_nonconformities: { quality: 0, safety: 1 },
  });
  assert.equal(p.schedule.status, 'red');
  assert.match(p.schedule.label, /^\+13 wd vs baseline · ends 20 Oct$/);
  assert.deepEqual([p.budget.status, p.budget.currentCents, p.budget.deltaCents], ['amber', 1200, 200]);
  assert.equal(p.scope.label, '2 changes · 1 question open');
  assert.deepEqual([p.safety.status, p.safety.label], ['red', '1 open safety issue']);
});

test('dated but not baselined yet: the end date, honestly unrated', () => {
  const p = pillarsFromOverview({ ...base, plan: { rows: 3, top_level: 1, start: '2026-09-01' }, end_date: { current: '2026-09-30' } });
  assert.equal(p.schedule.status, 'none');
  assert.match(p.schedule.label, /^Ends 30 \S+ · no baseline yet$/);
});

test('waiting rows keep the server order, label the category, and keep links app-relative', () => {
  const latest = (url) => ({ id: 'n', category: 'plan', title: 'Plan imported', object_ref: { type: 'project', id: 'p', url }, created_at: '2026-10-11T10:00:00Z', read_at: null });
  const rows = waitingRows({
    project_id: 'p', total_unread: 3,
    categories: [
      { category: 'plan', unread_count: 1, latest: latest('/projects/p/plan') },
      { category: 'files', unread_count: 2, latest: latest('https://evil.example') },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.label, r.count, r.url]), [['Plan imported', 1, '/projects/p/plan'], ['Files & deliverables', 2, '/notifications']]);
  assert.deepEqual(waitingRows(null), []);
});
