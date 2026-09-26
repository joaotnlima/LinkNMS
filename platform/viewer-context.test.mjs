import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createViewerContext } from './viewer-context.mjs';

describe('ViewerContext (doc 16)', () => {
  const init = {
    clerkUserId: 'user_1',
    personId: 'p-1',
    orgId: 'o-1',
    clerkOrgId: 'org_1',
    orgKind: 'contractor',
    orgRole: 'site_lead',
    permissions: ['org:plan:edit', 'org:progress:report'],
  };

  test('has() answers from the token permissions only', () => {
    const v = createViewerContext(init);
    assert.equal(v.has('org:plan:edit'), true);
    assert.equal(v.has('org:money:view'), false); // site_lead: no money (doc 16 §4)
  });

  test('actor() gives the ledger its person/org/role snapshot', () => {
    assert.deepEqual(createViewerContext(init).actor(), { personId: 'p-1', orgId: 'o-1', orgRole: 'site_lead' });
  });

  test('a personal session (no active org) is representable', () => {
    const v = createViewerContext({ clerkUserId: 'user_1' });
    assert.equal(v.orgId, null);
    assert.equal(v.has('org:plan:edit'), false);
  });

  test('rejects roles and kinds outside the doc-16 vocabulary', () => {
    assert.throws(() => createViewerContext({ ...init, orgRole: 'superuser' }), /unknown org role/);
    assert.throws(() => createViewerContext({ ...init, orgKind: 'agency' }), /unknown org kind/);
  });

  test('is frozen — nothing downstream can escalate it', () => {
    const v = createViewerContext(init);
    assert.throws(() => { v.orgRole = 'admin'; }, TypeError);
  });
});
