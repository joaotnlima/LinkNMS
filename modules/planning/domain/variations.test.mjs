// Variations engine + digest windowing, pure (doc 05 §6, doc 09 §Variation).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeCalendar } from './calendar.mjs';
import {
  isControlled, timePosition, scopeTextPosition, costPosition,
  variationAction, variationVisibleTo, windowOf, digestWindows, digestNet,
} from './variations.mjs';

const cal = makeCalendar({ work_days: [1, 2, 3, 4, 5], holidays: [], closures: [] });
const baselined = new Set(['ctr-1']);

describe('controlled rows', () => {
  test('a row is controlled when its branch contract has a baseline', () => {
    assert.equal(isControlled({ branchContractId: 'ctr-1' }, baselined), true);
    assert.equal(isControlled({ contractId: 'ctr-1', branchContractId: null }, baselined), true);
    assert.equal(isControlled({ branchContractId: 'ctr-2' }, baselined), false);
    assert.equal(isControlled({ branchContractId: null }, baselined), false);
  });
});

describe('time position', () => {
  const task = {
    baselineStart: '2026-09-21', baselineFinish: '2026-09-23',
    start: '2026-09-21', finish: '2026-09-23', actualStart: null, actualFinish: null,
  };

  test('on baseline → unchanged', () => {
    assert.equal(timePosition(task, cal).changed, false);
  });

  test('a slipped finish carries the working-day delta', () => {
    const p = timePosition({ ...task, finish: '2026-09-25' }, cal);
    assert.equal(p.changed, true);
    assert.equal(p.delta.finish_wd, 2);
    assert.equal(p.delta.start_wd, 0);
  });

  test('actual dates win over planned', () => {
    const p = timePosition({ ...task, actualFinish: '2026-09-28' }, cal);
    assert.equal(p.changed, true);
    assert.equal(p.delta.finish_wd, 3);
  });

  test('undated sides give a null delta but still count as changed', () => {
    const p = timePosition({ ...task, start: null, finish: null }, cal);
    assert.equal(p.changed, true);
    assert.equal(p.delta.start_wd, null);
  });
});

describe('scope-text position', () => {
  test('text drift against the baseline snapshot', () => {
    const p = scopeTextPosition(
      { description: 'paredes duplas', acceptanceCriteria: 'sem fissuras' },
      { scopeText: 'paredes simples', acceptanceCriteria: 'sem fissuras' },
    );
    assert.equal(p.changed, true);
    assert.deepEqual(p.delta, { scope_text_changed: true, acceptance_criteria_changed: false });
  });

  test('back to the snapshot → unchanged', () => {
    const p = scopeTextPosition(
      { description: 'x', acceptanceCriteria: null },
      { scopeText: 'x', acceptanceCriteria: null },
    );
    assert.equal(p.changed, false);
  });
});

describe('variation action (record / update / reopen / close)', () => {
  test('changed with no open slot → record; with one → update', () => {
    assert.equal(variationAction({ existing: null, changed: true }), 'record');
    assert.equal(variationAction({ existing: { status: 'open' }, changed: true }), 'update');
  });

  test('a new change on an ACKNOWLEDGED slot reopens it (doc 09)', () => {
    assert.equal(variationAction({ existing: { status: 'acknowledged' }, changed: true }), 'reopen');
  });

  test('back to baseline closes; nothing on nothing', () => {
    assert.equal(variationAction({ existing: { status: 'open' }, changed: false }), 'close');
    assert.equal(variationAction({ existing: null, changed: false }), null);
  });
});

describe('cost position', () => {
  test('net cents against the reference total', () => {
    const p = costPosition({ baselineTotalCents: 100000, currentTotalCents: 112500 });
    assert.equal(p.changed, true);
    assert.equal(p.delta.amount_cents, 12500);
    assert.equal(costPosition({ baselineTotalCents: 5, currentTotalCents: 5 }).changed, false);
  });
});

describe('visibility (V2/V5)', () => {
  const contracts = new Map([['ctr-1', { clientOrgId: 'owner', supplierOrgId: 'gc' }]]);

  test('time and scope are for every participant', () => {
    assert.equal(variationVisibleTo({ kind: 'time' }, 'anyone', { contracts }), true);
    assert.equal(variationVisibleTo({ kind: 'scope' }, 'anyone', { contracts }), true);
  });

  test('cost/material only for parties of the scope contract', () => {
    const v = { kind: 'cost', scopeId: 'ctr-1' };
    assert.equal(variationVisibleTo(v, 'owner', { contracts }), true);
    assert.equal(variationVisibleTo(v, 'gc', { contracts }), true);
    assert.equal(variationVisibleTo(v, 'sub', { contracts }), false);
    assert.equal(variationVisibleTo({ kind: 'material', scopeId: 'nope' }, 'owner', { contracts }), false);
  });
});

describe('digest windowing (15 minutes, doc 05 §6)', () => {
  test('windowOf aligns to the quarter hour', () => {
    const w = windowOf('2026-09-26T10:07:12Z');
    assert.equal(w.start.toISOString(), '2026-09-26T10:00:00.000Z');
    assert.equal(w.end.toISOString(), '2026-09-26T10:15:00.000Z');
  });

  test('four edits inside one window → ONE group; a later edit → a second', () => {
    const evt = (variation_id, occurred_at) => ({ project_id: 'prj', variation_id, occurred_at });
    const groups = digestWindows([
      evt('v1', '2026-09-26T10:01:00Z'),
      evt('v2', '2026-09-26T10:05:00Z'),
      evt('v1', '2026-09-26T10:14:59Z'), // refresh of v1, same window: no dup
      evt('v3', '2026-09-26T10:09:00Z'),
      evt('v1', '2026-09-26T10:16:00Z'), // next window
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].variation_ids, ['v1', 'v2', 'v3']);
    assert.deepEqual(groups[1].variation_ids, ['v1']);
  });

  test('projects never share a digest', () => {
    const groups = digestWindows([
      { project_id: 'a', variation_id: 'v1', occurred_at: '2026-09-26T10:01:00Z' },
      { project_id: 'b', variation_id: 'v2', occurred_at: '2026-09-26T10:02:00Z' },
    ]);
    assert.equal(groups.length, 2);
  });

  test('nets are per recipient org: cost only when the org is a party', () => {
    const contracts = new Map([['ctr-1', { clientOrgId: 'owner', supplierOrgId: 'gc' }]]);
    const variations = [
      { kind: 'time', status: 'open', delta: { finish_wd: 3 } },
      { kind: 'cost', status: 'open', scopeId: 'ctr-1', delta: { amount_cents: 12500 } },
    ];
    assert.deepEqual(digestNet(variations, 'owner', { contracts }), {
      net_project_finish_delta_wd: 3, net_cost_delta_cents: 12500,
    });
    // a non-party sees the time slip but no money — null, never zero (§6.5)
    assert.deepEqual(digestNet(variations, 'sub', { contracts }), {
      net_project_finish_delta_wd: 3, net_cost_delta_cents: null,
    });
  });
});
