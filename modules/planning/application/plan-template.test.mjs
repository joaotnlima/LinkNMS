// Plan template "my default" (LINA-383) — DB-free unit tests of the resolve/save
// use cases and the names-only validation. The fake store stores rows exactly as
// the pg-store would, so the body↔rows mapping round-trips through resolve/save.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePlanTemplate, savePlanTemplate, validatePlanTemplateBody,
} from './use-cases.mjs';

const PERSON = '01920000-0000-7000-8000-0000000000e1';

const SAMPLE = [
  { name: 'Phase 1', tasks: ['1.1 A', '1.2 B'] },
  { name: 'Phase 2', tasks: ['2.1 C'] },
];

const LIBRARY = [{ name: 'Standard residential build', tasks: ['Groundwork'] }];

// Reproduce bodyToTemplateRows so the fake seed matches what save would store.
function toRows(body) {
  const pad = (n) => String(n).padStart(4, '0');
  const rows = [];
  body.forEach((phase, pi) => {
    const pk = `p${pad(pi + 1)}`;
    rows.push({ rowKey: pk, parentRowKey: null, position: pad(pi + 1), kind: 'summary', name: phase.name });
    phase.tasks.forEach((t, ti) => {
      rows.push({ rowKey: `${pk}.t${pad(ti + 1)}`, parentRowKey: pk, position: pad(ti + 1), kind: 'task', name: t });
    });
  });
  return rows;
}

function fakeStore({ personal = null, library = null } = {}) {
  const state = { personal, library };
  return {
    state,
    async getPersonalDefaultTemplate(personId) {
      if (!state.personal || personId !== PERSON) return null;
      return { template: { id: 'tpl-personal', scope: 'personal', name: state.personal.name, updatedAt: '2026-09-30T00:00:00.000Z' }, rows: state.personal.rows };
    },
    async getLibraryDefaultTemplate() {
      if (!state.library) return null;
      return { template: { id: 'tpl-library', scope: 'library', name: state.library.name, updatedAt: '2026-09-01T00:00:00.000Z' }, rows: state.library.rows };
    },
    async upsertPersonalDefaultTemplate({ personId, name, rows }) {
      assert.equal(personId, PERSON);
      state.personal = { name, rows };
      return { template: { id: 'tpl-personal', scope: 'personal', name, updatedAt: '2026-09-30T12:00:00.000Z' }, rows };
    },
  };
}

const viewer = { personId: PERSON };

describe('validatePlanTemplateBody', () => {
  test('accepts a names-only two-level body and trims', () => {
    const out = validatePlanTemplateBody([{ name: ' P ', tasks: [' t '] }]);
    assert.deepEqual(out, [{ name: 'P', tasks: ['t'] }]);
  });

  test('rejects an empty body', () => {
    assert.throws(() => validatePlanTemplateBody([]), (e) => e.problem.code === 'validation_failed');
  });

  test('rejects an extra phase key (no smuggled plan data)', () => {
    assert.throws(
      () => validatePlanTemplateBody([{ name: 'P', tasks: [], start: '2026-01-01' }]),
      (e) => e.problem.code === 'validation_failed',
    );
  });

  test('rejects a task-as-object as too_deep', () => {
    assert.throws(
      () => validatePlanTemplateBody([{ name: 'P', tasks: [{ name: 'x' }] }]),
      (e) => e.problem.code === 'too_deep',
    );
  });
});

describe('resolvePlanTemplate', () => {
  test('401 when the identity mirror has not resolved a person', async () => {
    await assert.rejects(
      () => resolvePlanTemplate({ viewer: { personId: null }, store: fakeStore() }),
      (e) => e.problem.code === 'unauthenticated',
    );
  });

  test('returns the personal default as source=user', async () => {
    const store = fakeStore({ personal: { name: 'Mine', rows: toRows(SAMPLE) } });
    const res = await resolvePlanTemplate({ viewer, store });
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'user');
    assert.equal(res.body.template.ownerScope, 'user');
    assert.deepEqual(res.body.body, SAMPLE);
  });

  test('falls back to the library default as source=system', async () => {
    const store = fakeStore({ library: { name: 'Standard residential build', rows: toRows(LIBRARY) } });
    const res = await resolvePlanTemplate({ viewer, store });
    assert.equal(res.body.source, 'system');
    assert.equal(res.body.template.ownerScope, 'system');
    assert.deepEqual(res.body.body, LIBRARY);
  });

  test('500 when no default is seeded at all (deploy fault)', async () => {
    await assert.rejects(
      () => resolvePlanTemplate({ viewer, store: fakeStore() }),
      (e) => e.problem.code === 'internal',
    );
  });
});

describe('savePlanTemplate', () => {
  test('upserts and round-trips the body through rows', async () => {
    const store = fakeStore();
    const res = await savePlanTemplate({ viewer, store, body: { body: SAMPLE } });
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'user');
    assert.deepEqual(res.body.body, SAMPLE);
    // A subsequent resolve sees exactly what was saved.
    const again = await resolvePlanTemplate({ viewer, store });
    assert.deepEqual(again.body.body, SAMPLE);
  });

  test('rejects an invalid body before writing', async () => {
    const store = fakeStore();
    await assert.rejects(
      () => savePlanTemplate({ viewer, store, body: { body: [{ name: '', tasks: [] }] } }),
      (e) => e.problem.code === 'validation_failed',
    );
    assert.equal(store.state.personal, null);
  });

  test('401 when no person is resolved', async () => {
    await assert.rejects(
      () => savePlanTemplate({ viewer: { personId: null }, store: fakeStore(), body: { body: SAMPLE } }),
      (e) => e.problem.code === 'unauthenticated',
    );
  });
});
