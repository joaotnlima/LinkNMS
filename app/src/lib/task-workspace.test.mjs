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

import { taskPath } from './task-workspace.ts';

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
