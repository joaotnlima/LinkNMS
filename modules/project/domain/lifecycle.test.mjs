// Every row of the doc-09 Project table asserted, plus the D-35 derivation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { transition, TRANSITIONS, STATUSES, briefComplete, operatingModel } from './lifecycle.mjs';

describe('project lifecycle (doc 09)', () => {
  test('the declared table matches doc 09 exactly', () => {
    assert.deepEqual(Object.keys(TRANSITIONS), [
      'publish_first_rfp', 'sign_first_owner_contract', 'start', 'close', 'cancel',
    ]);
    assert.deepEqual(TRANSITIONS.publish_first_rfp, { from: ['draft'], to: 'tendering', guard: 'briefComplete' });
    assert.deepEqual(TRANSITIONS.sign_first_owner_contract, { from: ['draft', 'tendering'], to: 'contracted', guard: 'ownerContractSigned' });
    assert.deepEqual(TRANSITIONS.start, { from: ['contracted'], to: 'in_execution', guard: 'firstTaskInProgress' });
    assert.deepEqual(TRANSITIONS.close, { from: ['in_execution'], to: 'closed', guard: 'allOwnerContractsSettled' });
    assert.deepEqual(TRANSITIONS.cancel, { from: ['draft', 'tendering'], to: 'cancelled', guard: 'noSignedContract' });
  });

  test('every legal transition passes with its guard true', () => {
    for (const [action, rule] of Object.entries(TRANSITIONS)) {
      for (const from of rule.from) {
        const r = transition(from, action, { [rule.guard]: true });
        assert.deepEqual(r, { ok: true, to: rule.to }, `${from} --${action}-->`);
      }
    }
  });

  test('a true guard never rescues an illegal source status', () => {
    for (const [action, rule] of Object.entries(TRANSITIONS)) {
      for (const from of STATUSES.filter((s) => !rule.from.includes(s))) {
        const r = transition(from, action, { [rule.guard]: true });
        assert.equal(r.ok, false, `${from} --${action}--> must be illegal`);
      }
    }
  });

  test('a legal source status never passes with its guard false', () => {
    for (const [action, rule] of Object.entries(TRANSITIONS)) {
      for (const from of rule.from) {
        assert.equal(transition(from, action, {}).ok, false, `${action} without ${rule.guard}`);
      }
    }
  });

  test('unknown action is refused', () => {
    assert.equal(transition('draft', 'demolish', {}).ok, false);
  });

  test('closed and cancelled are terminal', () => {
    for (const status of ['closed', 'cancelled']) {
      for (const [action, rule] of Object.entries(TRANSITIONS)) {
        assert.equal(transition(status, action, { [rule.guard]: true }).ok, false);
      }
    }
  });
});

describe('brief completeness (publish guard)', () => {
  test('needs name, municipality and a claimed owner', () => {
    const full = { name: 'Casa', municipality_code: '1306', owner_org_id: 'org' };
    assert.equal(briefComplete(full), true);
    assert.equal(briefComplete({ ...full, name: '  ' }), false);
    assert.equal(briefComplete({ ...full, municipality_code: null }), false);
    assert.equal(briefComplete({ ...full, owner_org_id: null }), false);
  });
});

describe('operating model (D-35, derived)', () => {
  test('derives from signed owner-level contracts', () => {
    assert.equal(operatingModel({ prime: 0, direct: 0 }), 'undetermined');
    assert.equal(operatingModel({ prime: 1, direct: 0 }), 'turnkey');
    assert.equal(operatingModel({ prime: 0, direct: 2 }), 'direct');
    assert.equal(operatingModel({ prime: 1, direct: 1 }), 'hybrid');
  });
});
