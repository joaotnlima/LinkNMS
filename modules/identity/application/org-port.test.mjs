// The organisation port answers names and staffed people from the identity
// store only, deduplicating ids and skipping empty asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOrgPort } from './org-port.mjs';

test('namesOf / staffedPeople: one store read per ask, none for an empty one', async () => {
  const calls = [];
  const port = createOrgPort({
    async organizationNames(ids) { calls.push(['names', ids]); return [{ id: 'a', legal_name: 'Alfa' }]; },
    async staffedPeople(projectId, ids) { calls.push(['people', projectId, ids]); return [{ org_id: 'a', person_id: 'p', name: 'Ana', extra: 1 }]; },
  });
  assert.deepEqual([...(await port.namesOf(['a', 'a', null]))], [['a', 'Alfa']]);
  assert.equal((await port.namesOf([])).size, 0);
  assert.deepEqual(await port.staffedPeople('pr', ['a']), [{ org_id: 'a', person_id: 'p', name: 'Ana' }]);
  assert.deepEqual(await port.staffedPeople('pr', []), []);
  assert.deepEqual(calls, [['names', ['a']], ['people', 'pr', ['a']]]);
});
