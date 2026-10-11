// PRD-07 M-8 / M-9 — the model edit scope planning answers through its task
// port: D-33 branches, the owner apart, ended contracts closing the scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { modelScopesOf, outlineCodes, liveWorld, compareCodes } from './model-scope.mjs';

const OWNER = 'org-owner';
const GC = 'org-gc';
const ROOF = 'org-roof';
const PLUMB = 'org-plumb';

function plan({ roofStatus = 'draft' } = {}) {
  const t = (id, parentId, position, extra = {}) => [id, { id, parentId, position, name: id, branchContractId: null, ...extra }];
  return {
    ownerOrgId: OWNER,
    contracts: new Map([
      ['c-gc', { supplierOrgId: GC, clientOrgId: OWNER, parentContractId: null, status: 'signed' }],
      ['c-roof', { supplierOrgId: ROOF, clientOrgId: GC, parentContractId: 'c-gc', status: roofStatus }],
      ['c-plumb', { supplierOrgId: PLUMB, clientOrgId: OWNER, parentContractId: null, status: 'cancelled' }],
    ]),
    tasks: new Map([
      t('design', null, 'a'),
      t('build', null, 'b', { branchContractId: 'c-gc', assigneeOrgId: GC }),
      t('frame', 'build', 'a', { branchContractId: 'c-gc' }),
      t('roof', 'build', 'b', { branchContractId: 'c-roof', assigneeOrgId: ROOF }),
      t('tiles', 'roof', 'a', { branchContractId: 'c-roof' }),
      t('plumbing', null, 'c', { branchContractId: 'c-plumb', assigneeOrgId: PLUMB }),
    ]),
    statuses: new Map([['frame', 'in_progress']]),
    orgNames: new Map([[GC, 'Obra Nova'], [ROOF, 'Telhados do Norte']]),
  };
}

test('outline codes follow the tree order', () => {
  const codes = outlineCodes(plan().tasks);
  assert.equal(codes.get('design'), '1');
  assert.equal(codes.get('roof'), '2.2');
  assert.equal(codes.get('tiles'), '2.2.1');
  assert.ok(compareCodes('2.10', '2.9') > 0);
});

test('M-8: the GC edits its whole branch, the awarded roofer only its rows; the owner is apart', () => {
  const s = modelScopesOf(plan());
  assert.equal(s.owner_org_id, OWNER);
  const byOrg = Object.fromEntries(s.editors.map((e) => [e.org_id, new Set(e.task_ids)]));
  assert.deepEqual([...byOrg[GC]].sort(), ['build', 'frame', 'roof', 'tiles']);
  assert.deepEqual([...byOrg[ROOF]].sort(), ['roof', 'tiles']);
  assert.equal(byOrg[OWNER], undefined, 'the owner edits the whole model — not listed as a branch editor');
  const tiles = s.tasks.find((x) => x.id === 'tiles');
  assert.equal(tiles.assignee_org_id, ROOF, 'inherited assignee');
  assert.equal(tiles.assignee_org_name, 'Telhados do Norte');
  assert.equal(s.tasks.find((x) => x.id === 'frame').status, 'in_progress');
});

test('M-9: a cancelled, terminated or closed contract closes its supplier\'s scope', () => {
  const s = modelScopesOf(plan());
  assert.equal(s.editors.find((e) => e.org_id === PLUMB), undefined, 'cancelled before or after award — no scope');
  const ended = modelScopesOf(plan({ roofStatus: 'terminated' }));
  assert.equal(ended.editors.find((e) => e.org_id === ROOF), undefined);
  assert.ok(liveWorld(plan({ roofStatus: 'closed' })).contracts.has('c-gc'));
  assert.ok(!liveWorld(plan({ roofStatus: 'closed' })).contracts.has('c-roof'));
});
