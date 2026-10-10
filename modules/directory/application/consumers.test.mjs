// The directory consumer map and the published ports, with an in-memory store.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { combineConsumers } from '../../../platform/outbox.mjs';
import { directoryConsumers } from './consumers.mjs';
import { createSpecialtyPort } from './specialty-port.mjs';
import { createUnclaimedProfileSeeder } from './claims.mjs';

function store() {
  const applied = [];
  const unclaimed = [];
  return {
    applied, unclaimed,
    async applyRecordEvent(x) { applied.push(x); },
    async listSpecialties() { return [{ code: 'roofing' }, { code: 'roofing-tiled' }]; },
    async insertUnclaimedProfile(x) { unclaimed.push(x); return { org_id: x.orgId, slug: x.slugBase, claimed: false }; },
  };
}

test('subscribes to the record events and applies their operations once per event', async () => {
  const s = store();
  const subs = combineConsumers(directoryConsumers(s));
  const deliver = async (evt) => { for (const sub of subs) if (sub.matches(evt.type)) await sub.handle(evt); };
  await deliver({
    event_id: 'e1', type: 'contracting.contract.signed', project_id: 'p', scope: { type: 'contract', id: 'c' },
    data: { kind: 'direct', client_org_id: 'o', supplier_org_id: 's' },
  });
  await deliver({ event_id: 'e2', type: 'planning.progress.reported', data: { task_id: 't', status: 'verified' } });
  await deliver({ event_id: 'e3', type: 'planning.task.updated', data: {} });
  assert.equal(s.applied.length, 1);
  assert.equal(s.applied[0].eventId, 'e1');
  assert.equal(s.applied[0].ops[0].op, 'contract_signed');
});

test('specialty port answers taxonomy membership', async () => {
  const port = createSpecialtyPort(store());
  assert.equal(await port.exists('roofing-tiled'), true);
  assert.equal(await port.exists('made-up'), false);
  assert.equal(await port.exists(null), false);
});

test('unclaimed seeder (PRD-04 hook): normalised e-mail, slug from name, only known codes', async () => {
  const s = store();
  const seeder = createUnclaimedProfileSeeder(s);
  const row = await seeder.ensureUnclaimed({ displayName: ' Silva Roofing ', contactEmail: 'Geral@Silva.PT', specialties: ['roofing', 'x'] });
  assert.equal(row.claimed, false);
  assert.equal(s.unclaimed[0].contactEmail, 'geral@silva.pt');
  assert.equal(s.unclaimed[0].slugBase, 'silva-roofing');
  assert.deepEqual(s.unclaimed[0].specialties, ['roofing']);
  await assert.rejects(seeder.ensureUnclaimed({ displayName: 'x', contactEmail: 'nope' }));
});
