// The build's questions and minutes through the /api/v2 router, DB-free
// (PRD-12 N-5..N-7): topics, a scope gap routed to the owner through the
// project build port, a design change answered with a decision, the
// architect's queue on a build and across builds, minutes with the viewer's
// next step and drafts kept with their writer.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerCollaboration } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const GC_ORG = '01920000-0000-7000-8000-0000000000a2';
const ARCH_ORG = '01920000-0000-7000-8000-0000000000a3';
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const ME = '01920000-0000-7000-8000-0000000000e9';
const id = (n) => `01920000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;

function fakeStore() {
  const comments = new Map();
  const minutes = new Map();
  let clock = 0;
  return {
    comments, minutes,
    async getPersonByClerkId(c) { return c === 'user_me' ? { id: ME } : null; },
    async resolveObject(type, oid) { return type === 'project' && oid === PROJECT ? { projectId: PROJECT } : null; },
    async canReadObject({ orgId }) { return [OWNER_ORG, GC_ORG, ARCH_ORG].includes(orgId); },
    async isParticipant(pid, orgId) { return pid === PROJECT && [OWNER_ORG, GC_ORG, ARCH_ORG].includes(orgId); },
    async isStaffed() { return true; },
    async getComment(cid) { return comments.get(cid) ?? null; },
    async createComment(cmd) {
      const row = {
        id: cmd.id, object_type: cmd.objectType, object_id: cmd.objectId, project_id: cmd.projectId, kind: cmd.kind,
        body: cmd.body, author_person_id: ME, author_org_id: cmd.actor.orgId, addressee_org_id: cmd.addresseeOrgId,
        question_status: cmd.kind === 'question' ? 'open' : null, topic: cmd.topic, decision: null,
        created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString(), deleted_at: null,
      };
      comments.set(cmd.id, row);
      return row;
    },
    async answerQuestion({ questionId, answerId, body, decision, actor }) {
      const q = comments.get(questionId);
      if (q.question_status !== 'open') return null;
      Object.assign(q, { question_status: 'answered', decision });
      const answer = { ...q, id: answerId, kind: 'answer', body, author_org_id: actor.orgId, question_status: null, topic: null, decision: null };
      comments.set(answerId, answer);
      return answer;
    },
    async listMyQuestions({ orgId, status, topic, projectId }) {
      const items = [...comments.values()].filter((c) => c.kind === 'question' && c.addressee_org_id === orgId
        && c.question_status === status && (!topic || c.topic === topic) && (!projectId || c.project_id === projectId));
      return { items, nextCursor: null };
    },
    async listProjectQuestions({ orgId, role, topic }) {
      const mine = (c) => (role === 'addressed' ? c.addressee_org_id === orgId
        : role === 'asked' ? c.author_org_id === orgId : c.addressee_org_id === orgId || c.author_org_id === orgId);
      const items = [...comments.values()].filter((c) => c.kind === 'question' && mine(c) && (!topic || c.topic === topic)).reverse();
      return { items, nextCursor: null };
    },
    async getMinute(mid) { return minutes.get(mid) ?? null; },
    async minuteParts() { return { items: [], acks: [] }; },
    async createMinute(cmd) {
      const row = { id: cmd.id, project_id: cmd.projectId, date: cmd.date, attendees: cmd.attendees, status: 'draft', created_by_org_id: cmd.actor.orgId };
      minutes.set(cmd.id, row);
      return row;
    },
    async circulateMinute({ minuteId }) { const m = minutes.get(minuteId); m.status = 'circulated'; return { ...m }; },
    async listMinutes({ orgId }) {
      return { items: [...minutes.values()].filter((m) => m.status !== 'draft' || m.created_by_org_id === orgId), nextCursor: null };
    },
    async minutesParts(ids) { return new Map(ids.map((m) => [m, { items: [{ text: 'Betonagem sexta' }], acks: [] }])); },
  };
}

const builds = { async ownerOf(pid) { return pid === PROJECT ? { owner_org_id: OWNER_ORG } : null; } };
const as = (orgId) => createViewerContext({
  clerkUserId: 'user_me', orgId, clerkOrgId: `org_${orgId.slice(-2)}`, orgKind: 'contractor', orgRole: 'admin', permissions: [],
});

describe('questions and minutes over the v2 router (PRD-12 N-5..N-7)', () => {
  let router, store;
  const call = (method, path, { viewer = as(GC_ORG), body = null, query = {} } = {}) =>
    router.dispatch({ method, path, viewer, body, query, headers: {} });
  const ask = (body, viewer = as(GC_ORG)) => call('POST', `/threads/project/${PROJECT}/comments`, {
    viewer, body: { kind: 'question', body: 'Pergunta', ...body },
  });

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerCollaboration(router, { store, builds });
  });

  test('a scope gap is routed to the owner; naming anyone else is refused', async () => {
    const gap = await ask({ id: id(1), topic: 'scope_gap', body: 'Ninguém tem a impermeabilização da cobertura' });
    assert.equal(gap.status, 201);
    assert.equal(gap.body.addressee_org_id, OWNER_ORG);
    assert.equal(gap.body.topic, 'scope_gap');
    assert.equal((await ask({ id: id(2), topic: 'scope_gap', addressee_org_id: ARCH_ORG })).status, 422);
    assert.equal((await ask({ id: id(3), topic: 'scope_gap' }, as(OWNER_ORG))).status, 422);
    assert.equal((await ask({ id: id(4), topic: 'nonsense', addressee_org_id: ARCH_ORG })).status, 422);
    const owners = await call('GET', `/projects/${PROJECT}/questions`, { viewer: as(OWNER_ORG), query: { role: 'addressed', topic: 'scope_gap' } });
    assert.deepEqual(owners.body.items.map((q) => [q.id, q.actions]), [[id(1), ['answer']]]);
  });

  test('the architect’s queue: a design change is answered with a decision, kept on the question', async () => {
    await ask({ id: id(5), topic: 'design_change', addressee_org_id: ARCH_ORG, body: 'Trocar caixilharia para alumínio?' });
    await ask({ id: id(6), addressee_org_id: ARCH_ORG, body: 'Cota do pavimento?' });
    const queue = await call('GET', '/me/questions', { viewer: as(ARCH_ORG), query: { topic: 'design_change' } });
    assert.deepEqual(queue.body.items.map((q) => [q.id, q.project_id, q.actions]), [[id(5), PROJECT, ['answer']]]);

    const noDecision = await call('POST', `/comments/${id(5)}:answer`, { viewer: as(ARCH_ORG), body: { id: id(7), body: 'Sim' } });
    assert.equal(noDecision.status, 422);
    assert.ok(noDecision.body.errors.decision);
    const approved = await call('POST', `/comments/${id(5)}:answer`, {
      viewer: as(ARCH_ORG), body: { id: id(7), body: 'Aprovado, RAL 7016', decision: 'approved' },
    });
    assert.equal(approved.status, 201);
    assert.equal(store.comments.get(id(5)).decision, 'approved');
    const clar = await call('POST', `/comments/${id(6)}:answer`, { viewer: as(ARCH_ORG), body: { id: id(8), body: '+0.15', decision: 'approved' } });
    assert.equal(clar.status, 422); // only a design change carries a decision

    const asked = await call('GET', `/projects/${PROJECT}/questions`, { query: { role: 'asked' } });
    const dc = asked.body.items.find((q) => q.id === id(5));
    assert.equal(dc.decision, 'approved');
    assert.deepEqual(dc.actions, ['resolve']);
    assert.equal((await call('GET', '/me/questions', { query: { topic: 'nope' } })).status, 422);
  });

  test('the build’s questions are participants’ only; bad filters 422', async () => {
    assert.equal((await call('GET', `/projects/${PROJECT}/questions`, { viewer: as(STRANGER_ORG) })).status, 404);
    assert.equal((await call('GET', `/projects/${PROJECT}/questions`, { query: { role: 'everyone' } })).status, 422);
  });

  test('minutes: drafts stay with their writer; circulated ones show who still has to acknowledge', async () => {
    const created = await call('POST', `/projects/${PROJECT}/minutes`, {
      body: { id: id(9), date: '2026-10-09', attendees: [GC_ORG, OWNER_ORG], items: [{ text: 'Betonagem sexta' }] },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.actions, ['circulate']);
    assert.equal((await call('GET', `/projects/${PROJECT}/minutes`, { viewer: as(OWNER_ORG) })).body.items.length, 0);
    await call('POST', `/minutes/${id(9)}:circulate`);
    const owners = await call('GET', `/projects/${PROJECT}/minutes`, { viewer: as(OWNER_ORG) });
    assert.equal(owners.status, 200);
    assert.deepEqual(owners.body.items.map((m) => [m.id, m.status, m.actions]), [[id(9), 'circulated', ['acknowledge']]]);
    assert.equal(owners.body.items[0].items[0].text, 'Betonagem sexta');
    assert.equal((await call('GET', `/projects/${PROJECT}/minutes`, { viewer: as(STRANGER_ORG) })).status, 404);
  });
});
