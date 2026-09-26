// Collaboration operations end to end through the /api/v2 router, DB-free:
// the fake store answers what pg-store would. Proves the doc-16 request flow
// — session → relationship — a thread's visibility IS its object's (404 for
// non-readers), the D-13 question lanes (addressee answers, asker resolves),
// minutes (participants write, the author circulates, attendees ack), and
// the notifications surface.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerCollaboration } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1'; // asked the question
const GC_ORG = '01920000-0000-7000-8000-0000000000a2'; // its addressee
const SUB_ORG = '01920000-0000-7000-8000-0000000000a3'; // participant, neither
const STRANGER_ORG = '01920000-0000-7000-8000-0000000000a5';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const TASK = '01920000-0000-7000-8000-0000000000d1';
const QUESTION = '01920000-0000-7000-8000-0000000000e1';
const MINUTE = '01920000-0000-7000-8000-0000000000e2';
const NOTIF = '01920000-0000-7000-8000-0000000000e3';
const NEW_ID = '01920000-0000-7000-8000-0000000000ff';
const ME = '01920000-0000-7000-8000-0000000000e9';

function question(over = {}) {
  return {
    id: QUESTION, object_type: 'task', object_id: TASK, project_id: PROJECT,
    kind: 'question', body: 'A parede é para demolir?',
    author_person_id: ME, author_org_id: OWNER_ORG,
    mentions: [], attachment_document_ids: [],
    addressee_org_id: GC_ORG, question_status: 'open',
    answers_comment_id: null, deleted_at: null, created_at: '2026-09-26T09:00:00Z',
    ...over,
  };
}

function minute(over = {}) {
  return {
    id: MINUTE, project_id: PROJECT, date: '2026-09-25',
    attendees: [OWNER_ORG, GC_ORG], status: 'draft',
    created_by_org_id: GC_ORG, created_by_person_id: ME,
    ...over,
  };
}

function fakeStore() {
  const comments = new Map([[QUESTION, question()]]);
  const minutes = new Map([[MINUTE, minute()]]);
  const participants = new Set([OWNER_ORG, GC_ORG, SUB_ORG]);
  const readers = new Set([OWNER_ORG, GC_ORG, SUB_ORG]); // who can read TASK
  const marked = [];
  const prefs = [];

  return {
    comments, minutes, marked, prefs,
    async getPersonByClerkId(id) {
      return id === 'user_me' ? { id: ME, clerk_user_id: 'user_me', email: 'me@x.pt' } : null;
    },
    async resolveObject(objectType, objectId) {
      return objectType === 'task' && objectId === TASK ? { projectId: PROJECT } : null;
    },
    async canReadObject({ orgId }) { return readers.has(orgId); },
    async isParticipant(projectId, orgId) { return projectId === PROJECT && participants.has(orgId); },
    async isStaffed() { return true; },
    async listComments() {
      return { items: [...comments.values()], nextCursor: null };
    },
    async getComment(id) { return comments.get(id) ?? null; },
    async createComment(cmd) {
      const row = question({
        id: cmd.id, kind: cmd.kind, body: cmd.body,
        author_org_id: cmd.actor.orgId, addressee_org_id: cmd.addresseeOrgId,
        question_status: cmd.kind === 'question' ? 'open' : null,
        attachment_document_ids: cmd.attachmentDocumentIds,
      });
      comments.set(cmd.id, row);
      return row;
    },
    async answerQuestion({ questionId, answerId, body, actor }) {
      const q = comments.get(questionId);
      if (!q || q.question_status !== 'open') return null;
      comments.set(questionId, { ...q, question_status: 'answered' });
      const answer = question({
        id: answerId, kind: 'answer', body, author_org_id: actor.orgId,
        addressee_org_id: null, question_status: null, answers_comment_id: questionId,
      });
      comments.set(answerId, answer);
      return answer;
    },
    async resolveQuestion({ questionId }) {
      const q = comments.get(questionId);
      if (!q || q.question_status !== 'answered') return null;
      const next = { ...q, question_status: 'resolved' };
      comments.set(questionId, next);
      return next;
    },
    async listMyQuestions({ orgId, status }) {
      return {
        items: [...comments.values()].filter((c) => c.kind === 'question' && c.addressee_org_id === orgId && c.question_status === status),
        nextCursor: null,
      };
    },
    async getMinute(id) { return minutes.get(id) ?? null; },
    async minuteParts() {
      return { items: [{ text: 'Betonagem sexta', owner_org_id: GC_ORG, due_date: '2026-10-02', object_type: null, object_id: null }], acks: [] };
    },
    async createMinute(cmd) {
      const row = minute({ id: cmd.id, date: cmd.date, attendees: cmd.attendees, created_by_org_id: cmd.actor.orgId });
      minutes.set(cmd.id, row);
      return row;
    },
    async circulateMinute({ minuteId }) {
      const m = minutes.get(minuteId);
      if (!m || m.status !== 'draft') return null;
      const next = { ...m, status: 'circulated' };
      minutes.set(minuteId, next);
      return next;
    },
    async acknowledgeMinute({ minuteId }) {
      return minutes.get(minuteId);
    },
    async listActivity() {
      return {
        items: [{
          event_id: NEW_ID, type: 'planning.variation.recorded', occurred_at: '2026-09-26T08:00:00Z',
          actor: { person_id: ME, org_id: GC_ORG }, scope: { type: 'task', id: TASK },
          data: { name: 'Demolição' },
        }],
        nextCursor: null,
      };
    },
    async listNotifications() {
      return {
        items: [{ id: NOTIF, category: 'questions', title: 'Your question was answered', object_ref: { type: 'comment', id: QUESTION }, created_at: '2026-09-26T09:30:00Z', read_at: null }],
        nextCursor: null,
      };
    },
    async markNotificationsRead(cmd) { marked.push(cmd); },
    async putPreferences({ items }) { prefs.push(...items); return items; },
  };
}

function viewer(orgId, { role = 'manager' } = {}) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: orgId && `clerk_${orgId}`,
    orgKind: orgId === OWNER_ORG ? 'household' : 'contractor', orgRole: orgId ? role : null,
    permissions: [], channel: 'ui',
  });
}

describe('collaboration over the /api/v2 router', () => {
  let router, store;

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    registerCollaboration(router, { store });
  });

  const dispatch = (method, path, viewerCtx, body = null, query = {}) =>
    router.dispatch({ method, path, viewer: viewerCtx, body, query, headers: {} });

  describe('threads (visibility IS the object’s)', () => {
    test('a reader lists the thread; the asker is on the wire (not anonymous here)', async () => {
      const res = await dispatch('GET', `/threads/task/${TASK}/comments`, viewer(SUB_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items[0].author.org_id, OWNER_ORG);
      assert.equal(res.body.items[0].addressee_org_id, GC_ORG);
    });

    test('a stranger → 404 (never learns the object exists)', async () => {
      const res = await dispatch('GET', `/threads/task/${TASK}/comments`, viewer(STRANGER_ORG));
      assert.equal(res.status, 404);
    });

    test('an unknown object type → 404, not 500', async () => {
      const res = await dispatch('GET', `/threads/invoice/${TASK}/comments`, viewer(SUB_ORG));
      assert.equal(res.status, 404);
    });

    test('a note posts with attachments → 201', async () => {
      const res = await dispatch('POST', `/threads/task/${TASK}/comments`, viewer(SUB_ORG),
        { id: NEW_ID, kind: 'note', body: 'Foto da fissura em anexo.', attachment_ids: [NOTIF] });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.attachment_ids, [NOTIF]);
    });

    test('a question without an addressee → 422 (D-13: addressed, not shouted)', async () => {
      const res = await dispatch('POST', `/threads/task/${TASK}/comments`, viewer(OWNER_ORG),
        { id: NEW_ID, kind: 'question', body: 'E o prazo?' });
      assert.equal(res.status, 422);
    });
  });

  describe('question lanes (addressee answers, asker resolves)', () => {
    test('the addressee answers → 201 answer linked to the question', async () => {
      const res = await dispatch('POST', `/comments/${QUESTION}:answer`, viewer(GC_ORG),
        { id: NEW_ID, body: 'Sim, consta do mapa de demolições.' });
      assert.equal(res.status, 201);
      assert.equal(res.body.kind, 'answer');
      assert.equal(res.body.answers_comment_id, QUESTION);
      assert.equal(store.comments.get(QUESTION).question_status, 'answered');
    });

    test('anyone else answering → 403', async () => {
      const res = await dispatch('POST', `/comments/${QUESTION}:answer`, viewer(SUB_ORG),
        { id: NEW_ID, body: 'eu sei!' });
      assert.equal(res.status, 403);
    });

    test('resolving an unanswered question → 409 with the reason', async () => {
      const res = await dispatch('POST', `/comments/${QUESTION}:resolve`, viewer(OWNER_ORG));
      assert.equal(res.status, 409);
    });

    test('only the asker resolves; the addressee → 403', async () => {
      store.comments.set(QUESTION, question({ question_status: 'answered' }));
      const no = await dispatch('POST', `/comments/${QUESTION}:resolve`, viewer(GC_ORG));
      assert.equal(no.status, 403);
      const ok = await dispatch('POST', `/comments/${QUESTION}:resolve`, viewer(OWNER_ORG));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.question_status, 'resolved');
    });

    test('listMyQuestions defaults to the open queue of MY org', async () => {
      const mine = await dispatch('GET', '/me/questions', viewer(GC_ORG));
      assert.equal(mine.status, 200);
      assert.equal(mine.body.items.length, 1);
      const none = await dispatch('GET', '/me/questions', viewer(SUB_ORG));
      assert.equal(none.body.items.length, 0);
    });
  });

  describe('minutes (author circulates, attendees ack)', () => {
    const create = {
      id: NEW_ID, date: '2026-09-26', attendees: [OWNER_ORG, GC_ORG],
      items: [{ text: 'Betonagem sexta', owner_org_id: GC_ORG, due_date: '2026-10-02' }],
    };

    test('a participant drafts a minute → 201', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/minutes`, viewer(GC_ORG), create);
      assert.equal(res.status, 201);
      assert.equal(res.body.status, 'draft');
      assert.equal(res.body.items[0].owner_org_id, GC_ORG);
    });

    test('a stranger → 404', async () => {
      const res = await dispatch('POST', `/projects/${PROJECT}/minutes`, viewer(STRANGER_ORG), create);
      assert.equal(res.status, 404);
    });

    test('only the author circulates: another attendee → 403, the author → 200', async () => {
      const no = await dispatch('POST', `/minutes/${MINUTE}:circulate`, viewer(OWNER_ORG));
      assert.equal(no.status, 403);
      const ok = await dispatch('POST', `/minutes/${MINUTE}:circulate`, viewer(GC_ORG));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.status, 'circulated');
    });

    test('acknowledge: only while circulated, only an attendee', async () => {
      const early = await dispatch('POST', `/minutes/${MINUTE}:acknowledge`, viewer(OWNER_ORG));
      assert.equal(early.status, 409); // still draft
      store.minutes.set(MINUTE, minute({ status: 'circulated' }));
      const outsider = await dispatch('POST', `/minutes/${MINUTE}:acknowledge`, viewer(SUB_ORG));
      assert.equal(outsider.status, 403); // participant but not an attendee
      const ok = await dispatch('POST', `/minutes/${MINUTE}:acknowledge`, viewer(OWNER_ORG));
      assert.equal(ok.status, 200);
    });
  });

  describe('activity + notifications', () => {
    test('a participant reads the feed as projected envelopes', async () => {
      const res = await dispatch('GET', `/projects/${PROJECT}/activity`, viewer(OWNER_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items[0].summary, 'variation recorded: Demolição');
      assert.equal(res.body.items[0].object_id, TASK);
    });

    test('a stranger → 404', async () => {
      const res = await dispatch('GET', `/projects/${PROJECT}/activity`, viewer(STRANGER_ORG));
      assert.equal(res.status, 404);
    });

    test('listNotifications answers mine', async () => {
      const res = await dispatch('GET', '/me/notifications', viewer(GC_ORG));
      assert.equal(res.status, 200);
      assert.equal(res.body.items[0].object_ref.type, 'comment');
    });

    test('mark-read wants ids or all → 422 with neither, 204 with ids', async () => {
      const bad = await dispatch('POST', '/notifications:mark-read', viewer(GC_ORG), {});
      assert.equal(bad.status, 422);
      const ok = await dispatch('POST', '/notifications:mark-read', viewer(GC_ORG), { ids: [NOTIF] });
      assert.equal(ok.status, 204);
      assert.deepEqual(store.marked[0].ids, [NOTIF]);
    });

    test('preferences upsert → 200; a bad channel → 422', async () => {
      const ok = await dispatch('PUT', '/me/notification-preferences', viewer(GC_ORG),
        { items: [{ category: 'questions', channel: 'email', enabled: false }] });
      assert.equal(ok.status, 200);
      const bad = await dispatch('PUT', '/me/notification-preferences', viewer(GC_ORG),
        { items: [{ category: 'questions', channel: 'sms', enabled: true }] });
      assert.equal(bad.status, 422);
    });
  });
});
