import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from './router.mjs';
import { ProblemError } from './errors.mjs';

function router() {
  const r = createRouter();
  r.register('GET', '/projects/{id}', 'getProject', async ({ params }) => ({ status: 200, body: { id: params.id } }));
  r.register('POST', '/contracts/{id}:sign', 'signContract', async ({ params }) => ({ status: 200, body: { signed: params.id } }));
  r.register('POST', '/projects', 'createProject', async ({ body }) => ({ status: 201, body }));
  return r;
}

describe('/api/v2 router', () => {
  test('plain params match and decode', () => {
    const m = router().match('GET', '/projects/0192-abc');
    assert.equal(m.route.operationId, 'getProject');
    assert.deepEqual(m.params, { id: '0192-abc' });
  });

  test('colon commands are part of the route, not the id', () => {
    const r = router();
    const m = r.match('POST', '/contracts/c-1:sign');
    assert.equal(m.route.operationId, 'signContract');
    assert.deepEqual(m.params, { id: 'c-1' });
    // The bare resource POST must NOT match the command route.
    assert.equal(r.match('POST', '/contracts/c-1'), null);
    // …and the command must not leak into a plain-param route.
    assert.equal(r.match('GET', '/projects/p-1:sign'), null);
  });

  test('duplicate registration is a programming error', () => {
    const r = router();
    assert.throws(() => r.register('GET', '/projects/{id}', 'again', async () => ({})), /duplicate route/);
  });

  test('dispatch: unknown path answers problem+json not_found', async () => {
    const res = await router().dispatch({ method: 'GET', path: '/nope' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'not_found');
    assert.equal(res.headers['content-type'], 'application/problem+json');
  });

  test('dispatch: ProblemError from a handler becomes its response, extras intact', async () => {
    const r = createRouter();
    r.register('POST', '/links', 'createLink', async () => {
      throw new ProblemError('dependency_cycle', 'A → B → A', { path: ['A', 'B', 'A'] });
    });
    const res = await r.dispatch({ method: 'POST', path: '/links', body: {} });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'dependency_cycle');
    assert.deepEqual(res.body.path, ['A', 'B', 'A']);
  });

  test('dispatch: an unexpected throw is a clean 500 with nothing internal', async () => {
    const r = createRouter();
    r.register('GET', '/boom', 'boom', async () => { throw new Error('secret stack detail'); });
    const res = await r.dispatch({ method: 'GET', path: '/boom' });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'internal');
    assert.ok(!JSON.stringify(res.body).includes('secret'));
  });

  test('dispatch: success passes params/body through and defaults content-type', async () => {
    const res = await router().dispatch({ method: 'POST', path: '/projects', body: { name: 'Casa' } });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { name: 'Casa' });
    assert.equal(res.headers['content-type'], 'application/json');
  });
});
