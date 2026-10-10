// The non-conformity port (PRD-06 V-8): the facts documents needs to link a markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNonConformityPort } from './nonconformity-port.mjs';

const port = createNonConformityPort({
  getNonConformity: async (id) => (id === 'nc'
    ? { id: 'nc', project_id: 'p', task_id: 't', raised_by_org_id: 'o', status: 'open', description: 'x' }
    : null),
});

test('an issue answers project, task, raiser and status — nothing else', async () => {
  assert.deepEqual(await port.nonconformityFacts('nc'), { id: 'nc', project_id: 'p', task_id: 't', raised_by_org_id: 'o', status: 'open' });
  assert.equal(await port.nonconformityFacts('zz'), null);
});
