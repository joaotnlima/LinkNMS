// Unit test for the surviving task-permalink helper (LINA-250).
//
// The v1 task-workspace client (stage lookups, byte/time formatters, and the
// three network calls) was removed with the v1 API in LINA-387 (Phase 12c); the
// drawer reads/writes moved to v2 in LINA-399. Only `taskPath` remains — a pure
// URL builder PlanBuildEditor uses to address a task.
//
// Run: node --test src/lib/   (Node's native TS type-stripping imports the .ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { taskPath, taskHref, planHref } from './task-workspace.ts';

test('taskPath: builds the project-nested task permalink, encoding both segments', () => {
  assert.equal(
    taskPath('proj-1', 'stage-key-2'),
    '/projects/proj-1/plan/tasks/stage-key-2',
  );
  // A key or id with URL-unsafe characters is percent-encoded, not interpolated raw.
  assert.equal(
    taskPath('a/b', 'k e/y'),
    `/projects/${encodeURIComponent('a/b')}/plan/tasks/${encodeURIComponent('k e/y')}`,
  );
});

// The in-place drawer addresses (LINA-404) MUST stay on the `/plan` route — the
// whole fix is that the live editor never points the canonical URL at a sibling
// route or a redirect, so a server action's revalidation refreshes in place.
test('taskHref: opens a task as a query on the plan route, never a sibling path', () => {
  const href = taskHref('proj-1', 'task-id-2');
  assert.equal(href, '/projects/proj-1/plan?task=task-id-2');
  // It is the SAME route as planHref — only a query apart — so a save stays put.
  assert.ok(href.startsWith(`${planHref('proj-1')}?task=`));
  // No `/plan/tasks/` or `/plan/build` segment that would navigate on revalidate.
  assert.ok(!href.includes('/plan/tasks/'));
  assert.ok(!href.includes('/plan/build'));
  // URL-unsafe characters are encoded, not interpolated raw.
  assert.equal(
    taskHref('a/b', 'k e/y'),
    `/projects/${encodeURIComponent('a/b')}/plan?task=${encodeURIComponent('k e/y')}`,
  );
});

test('planHref: the drawer-closed address is the bare plan route', () => {
  assert.equal(planHref('proj-1'), '/projects/proj-1/plan');
  assert.equal(planHref('a/b'), `/projects/${encodeURIComponent('a/b')}/plan`);
});
