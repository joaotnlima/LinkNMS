// PRD-08 through the /api/v2 router, DB-free: clarifications from both bidder
// doors (in-app org, personal link) and the issuer's answer, plus the tendering
// home read. The fake store mirrors pg-store's rows (asker kept, never
// projected). Proves:
//   H-6  a bidder asks in-app or from its link; the link ask needs no session;
//   H-7  the issuer sees every question; the asker is on no bidder's wire;
//   H-8  an answer is visible to every bidder (A, B and the link-only C), emits
//        tendering.clarification.answered, and emails ONLY link-only bidders,
//        with no token in the mail;
//   H-9  after the questions deadline (or once not published) asking is 409,
//        refused by the server whatever the form shows;
//   H-1  listProjectRfps: issuer counts, bidder none (V8), stranger 404.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { createCapturingMailSender } from '../infra/mail-sender.mjs';
import { registerTendering } from './register.mjs';
import { createInMemoryIdempotency } from '../../../platform/idempotency.mjs';

const OWNER = '01950000-0000-7000-8000-0000000000a1';
const BIDDER_A = '01950000-0000-7000-8000-0000000000a2';
const BIDDER_B = '01950000-0000-7000-8000-0000000000a3';
const STRANGER = '01950000-0000-7000-8000-0000000000a5';
const PROJECT = '01950000-0000-7000-8000-0000000000b1';
const RFP = '01950000-0000-7000-8000-0000000000e1';
const REC_C = '01950000-0000-7000-8000-0000000000c3'; // link-only, no org
const Q_A = '01950000-0000-7000-8000-0000000000d1';
const Q_NEW = '01950000-0000-7000-8000-0000000000d2';
const Q_LINK = '01950000-0000-7000-8000-0000000000d3';
const ME = '01950000-0000-7000-8000-0000000000e9';
const TOKEN_C = 'c'.repeat(64);
const PAST = '2020-01-01T00:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';

function fakeStore() {
  const rfp = {
    id: RFP, project_id: PROJECT, issuer_org_id: OWNER, level: 'owner', purpose: 'execution', mode: 'detailed',
    root_task_ids: [], title: 'Cobertura', specialties: [], visibility: 'invite_only', status: 'published',
    questions_deadline: FUTURE, submission_deadline: FUTURE, package_version: 1, version: 2,
    created_at: '2026-12-01T00:00:00Z',
  };
  const clar = new Map([[Q_A, {
    id: Q_A, rfp_id: RFP, asked_by_org_id: BIDDER_A, asked_by_recipient_id: null,
    question: 'Inclui XPS 80 mm?', answer: null, answered_at: null, status: 'open', asked_at: '2026-12-02T00:00:00Z',
  }]]);
  const events = [];
  return {
    idempotent: createInMemoryIdempotency(),
    rfp, clar, events,
    async getPersonByClerkId() { return { id: ME, clerk_user_id: 'user_me' }; },
    async getProject(id) { return id === PROJECT ? { id, owner_org_id: OWNER, created_by_org_id: OWNER } : null; },
    async isParticipant(p, o) { return p === PROJECT && o === OWNER; },
    async isStaffed() { return false; },
    async getRfp(id) { return id === RFP ? rfp : null; },
    async isRecipient(id, org) { return id === RFP && [BIDDER_A, BIDDER_B].includes(org); },
    async packageOf() { return { rows: [], items: [] }; },
    async clarificationsOf(id) { return [...clar.values()].filter((c) => c.rfp_id === id); },
    async getClarification(id) { return clar.get(id) ?? null; },
    async askClarification(cmd) {
      const row = { id: cmd.id, rfp_id: cmd.rfpId, asked_by_org_id: cmd.askedByOrgId ?? null,
        asked_by_recipient_id: cmd.askedByRecipientId ?? null, question: cmd.question, answer: null,
        answered_at: null, status: 'open', asked_at: '2026-12-03T00:00:00Z' };
      clar.set(cmd.id, row);
      return row;
    },
    async answerClarification({ clarificationId, answer }) {
      const c = clar.get(clarificationId);
      if (!c || c.status !== 'open') return null;
      const next = { ...c, answer, status: 'answered', answered_at: '2026-12-04T00:00:00Z' };
      clar.set(clarificationId, next);
      events.push('tendering.clarification.answered');
      return next;
    },
    async tokenOnlyRecipients() { return [{ id: REC_C, email: 'c@telhados.pt' }]; },
    async projectName() { return 'Casa Silva'; },
    async findRecipientByToken(raw) {
      if (raw !== TOKEN_C) return null;
      return {
        id: REC_C, rfp_id: RFP, org_id: null, email: 'c@telhados.pt', title: rfp.title, scope_text: null,
        specialties: [], purpose: 'execution', mode: 'detailed', submission_deadline: rfp.submission_deadline,
        questions_deadline: rfp.questions_deadline, rfp_status: rfp.status, project_id: PROJECT,
        package_version: 1, project_name: 'Casa Silva', project_location: null, proposal_id: null,
      };
    },
    async markRecipientOpened() {},
    async projectRfps(projectId, orgId) {
      if (projectId !== PROJECT) return [];
      const row = { ...rfp, covers: [{ task_id: 't', name: 'Cobertura' }], covered_task_count: 3,
        lane_counts: { invited: 2, submitted: 1 }, open_question_count: 1,
        my_proposal_id: orgId === BIDDER_A ? 'p-a' : null, my_proposal_status: 'invited' };
      return orgId === OWNER || orgId === BIDDER_A ? [row] : [];
    },
  };
}

function viewer(orgId, perms = ['org:tendering:issue', 'org:tendering:bid']) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'contractor', orgRole: 'manager', permissions: perms, channel: 'ui',
  });
}

describe('PRD-08 clarifications and the tendering home', () => {
  let router, store, mail;
  const call = (method, path, v, body = null) =>
    router.dispatch({ method, path, viewer: v, query: {}, body, headers: {} });

  beforeEach(() => {
    store = fakeStore();
    mail = createCapturingMailSender();
    router = createRouter();
    registerTendering(router, { store, mailSender: mail, contractingAward: async () => {} });
  });

  test('H-6: an invited org asks in-app; its own open question reads back as mine', async () => {
    const res = await call('POST', `/rfps/${RFP}/clarifications`, viewer(BIDDER_B), { id: Q_NEW, question: ' Prazo? ' });
    assert.equal(res.status, 201);
    assert.equal(res.body.question, 'Prazo?');
    assert.equal(res.body.mine, true);
    const own = await call('GET', `/rfps/${RFP}`, viewer(BIDDER_B));
    assert.deepEqual(own.body.clarifications.map((c) => [c.id, c.mine]), [[Q_NEW, true]]);
    assert.equal(own.body.questions_open, true);
  });

  test('H-6: a link-only bidder asks with the token alone; unknown token is 404', async () => {
    const res = await call('POST', `/rfp-links/${TOKEN_C}/clarifications`, null, { id: Q_LINK, question: 'Andaimes?' });
    assert.equal(res.status, 201);
    assert.equal(store.clar.get(Q_LINK).asked_by_recipient_id, REC_C);
    const replay = await call('POST', `/rfp-links/${TOKEN_C}/clarifications`, null, { id: Q_LINK, question: 'Andaimes?' });
    assert.equal(replay.status, 201);
    const dead = await call('POST', `/rfp-links/${'d'.repeat(64)}/clarifications`, null, { id: Q_NEW, question: 'x' });
    assert.equal(dead.status, 404);
  });

  test('H-9: after the questions deadline, or once closed, asking is refused server-side', async () => {
    store.rfp.questions_deadline = PAST;
    const inApp = await call('POST', `/rfps/${RFP}/clarifications`, viewer(BIDDER_B), { id: Q_NEW, question: 'x' });
    assert.equal(inApp.status, 409);
    const link = await call('POST', `/rfp-links/${TOKEN_C}/clarifications`, null, { id: Q_LINK, question: 'x' });
    assert.equal(link.status, 409);
    const view = await call('GET', `/rfp-links/${TOKEN_C}`, null);
    assert.equal(view.body.questions_open, false);
    store.rfp.questions_deadline = null;
    store.rfp.status = 'closed';
    const closed = await call('POST', `/rfp-links/${TOKEN_C}/clarifications`, null, { id: Q_LINK, question: 'x' });
    assert.equal(closed.status, 409);
  });

  test("H-7/H-8: the answer reaches A, B and link-only C — no one sees who asked", async () => {
    const before = await call('GET', `/rfps/${RFP}`, viewer(BIDDER_B));
    assert.equal(before.body.clarifications.length, 0, "B never sees A's OPEN question");
    const issuer = await call('GET', `/rfps/${RFP}`, viewer(OWNER));
    assert.equal(issuer.body.clarifications.length, 1);

    const ans = await call('POST', `/clarifications/${Q_A}:answer`, viewer(OWNER), { answer: 'Sim, incluir.' });
    assert.equal(ans.status, 200);
    assert.deepEqual(store.events, ['tendering.clarification.answered']);

    for (const [org, mine] of [[BIDDER_A, true], [BIDDER_B, false]]) {
      const res = await call('GET', `/rfps/${RFP}`, viewer(org));
      assert.deepEqual(res.body.clarifications.map((c) => [c.answer, c.mine]), [['Sim, incluir.', mine]]);
      assert.ok(!JSON.stringify(res.body.clarifications).includes(BIDDER_A));
    }
    const link = await call('GET', `/rfp-links/${TOKEN_C}`, null);
    assert.deepEqual(link.body.clarifications.map((c) => [c.answer, c.mine]), [['Sim, incluir.', false]]);
    assert.ok(!JSON.stringify(link.body).includes(BIDDER_A));

    assert.equal(mail.sent.length, 1, 'only the link-only bidder is emailed');
    assert.equal(mail.sent[0].to, 'c@telhados.pt');
    assert.ok(!mail.sent[0].text.includes(TOKEN_C) && !mail.sent[0].html.includes(TOKEN_C));
    assert.match(mail.sent[0].text, /Sim, incluir\./);
  });

  test('answering twice or as a bidder is refused', async () => {
    const asBidder = await call('POST', `/clarifications/${Q_A}:answer`, viewer(BIDDER_A), { answer: 'x' });
    assert.equal(asBidder.status, 404);
    await call('POST', `/clarifications/${Q_A}:answer`, viewer(OWNER), { answer: 'ok' });
    const again = await call('POST', `/clarifications/${Q_A}:answer`, viewer(OWNER), { answer: 'ok' });
    assert.equal(again.status, 409);
  });

  test('a failing mail provider never fails the answer', async () => {
    router = createRouter();
    registerTendering(router, { store, mailSender: { async send() { throw new Error('down'); } }, contractingAward: async () => {} });
    const ans = await call('POST', `/clarifications/${Q_A}:answer`, viewer(OWNER), { answer: 'ok' });
    assert.equal(ans.status, 200);
  });

  test('H-1: the issuer reads counts, a bidder reads only its lane, a stranger gets 404', async () => {
    const own = await call('GET', `/projects/${PROJECT}/rfps`, viewer(OWNER));
    assert.equal(own.status, 200);
    assert.equal(own.body.items[0].viewer_role, 'issuer');
    assert.equal(own.body.items[0].submitted_count, 1);
    assert.equal(own.body.items[0].open_question_count, 1);
    const bid = await call('GET', `/projects/${PROJECT}/rfps`, viewer(BIDDER_A));
    assert.equal(bid.status, 200, 'a bidder is not a participant, yet sees the RFPs it is on');
    assert.equal(bid.body.items[0].viewer_role, 'bidder');
    assert.equal(bid.body.items[0].submitted_count, undefined);
    assert.deepEqual(bid.body.items[0].my_proposal, { id: 'p-a', status: 'invited' });
    const stranger = await call('GET', `/projects/${PROJECT}/rfps`, viewer(STRANGER));
    assert.equal(stranger.status, 404);
  });
});
