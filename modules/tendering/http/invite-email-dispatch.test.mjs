// Invite-email dispatch through the /api/v2 router, DB-free (LINA-412, slice E).
// Proves the acceptance criteria:
//   - addRecipients and reissueRecipientLink CALL the MailSender port;
//   - the secure link (token) rides ONLY in the email body — never the subject,
//     and never a log line (LINA-373/294);
//   - the delivery breadcrumb is recorded (status→sent via markRecipientSent);
//   - the invite-email:preview renders the copy with a NON-secret placeholder.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerTendering } from './register.mjs';
import { createCapturingMailSender, createLogMailSender } from '../infra/mail-sender.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000000a1';
const BIDDER_ORG = '01920000-0000-7000-8000-0000000000a3';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const RFP = '01920000-0000-7000-8000-0000000000e1';
const REC = '01920000-0000-7000-8000-0000000000c2';
const NEW_ID = '01920000-0000-7000-8000-0000000000ff';
const ME = '01920000-0000-7000-8000-0000000000e9';
const FUTURE = '2027-01-15T17:00:00Z';
const TOKEN_NEW = 'a'.repeat(64);
const TOKEN_REISSUE = 'b'.repeat(64);
const BASE = 'https://portal.linknms.com';

function fakeStore() {
  const marked = [];
  const rfp = {
    id: RFP, project_id: PROJECT, issuer_org_id: OWNER_ORG, level: 'owner',
    title: 'Canalização', scope_text: 'Tubagem PEX', submission_deadline: FUTURE,
    visibility: 'invite_only', status: 'draft', version: 1,
  };
  return {
    marked,
    async getPersonByClerkId(id) { return id === 'user_me' ? { id: ME, email: 'me@x.pt' } : null; },
    async getRfp(id) { return id === RFP ? rfp : null; },
    async addRecipients({ recipients }) {
      // One freshly-minted link (token), plus one pre-existing (token null).
      return recipients.map((r, i) => ({
        recipient: { id: i === 0 ? NEW_ID : REC, org_id: r.orgId, email: r.email, status: 'queued', sent_at: null, opened_at: null },
        token: i === 0 ? TOKEN_NEW : null,
      }));
    },
    async markRecipientSent({ rfpId, recipientId, messageId }) {
      marked.push({ rfpId, recipientId, messageId });
      return { id: recipientId, org_id: null, email: 'bidder@example.pt', status: 'sent', sent_at: FUTURE, opened_at: null };
    },
    async getRecipient(rfpId, recipientId) {
      return rfpId === RFP && recipientId === REC
        ? { id: REC, rfp_id: RFP, org_id: BIDDER_ORG, email: 'maia@hidro.pt', lane_status: 'invited' }
        : null;
    },
    async reissueRecipientLink({ recipientId }) {
      return {
        recipient: { id: recipientId, org_id: BIDDER_ORG, email: 'maia@hidro.pt', status: 'queued', sent_at: null, opened_at: null, expires_at: FUTURE, revoked_at: null },
        token: TOKEN_REISSUE,
      };
    },
  };
}

function viewer(orgId = OWNER_ORG) {
  return createViewerContext({
    clerkUserId: 'user_me', personId: ME, orgId, clerkOrgId: `clerk_${orgId}`,
    orgKind: 'household', orgRole: 'manager',
    permissions: ['org:tendering:issue', 'org:tendering:bid', 'org:money:view'], channel: 'ui',
  });
}

describe('invite-email dispatch (LINA-412)', () => {
  let router, store, mail;

  function wire(mailSender) {
    router = createRouter();
    store = fakeStore();
    mail = mailSender;
    registerTendering(router, { store, mailSender, linkBaseUrl: BASE, contractingAward: () => {} });
  }
  const dispatch = (method, path, v, body = null, query = {}) =>
    router.dispatch({ method, path, viewer: v, body, query, headers: {} });

  beforeEach(() => wire(createCapturingMailSender()));

  test('addRecipients sends the invite with the token ONLY in the body', async () => {
    const res = await dispatch('POST', `/rfps/${RFP}/recipients`, viewer(), {
      recipients: [{ email: 'bidder@example.pt' }, { email: 'already@there.pt' }],
    });
    assert.equal(res.status, 201);
    // Exactly one email sent (the freshly-minted link; the pre-existing one is not re-sent).
    assert.equal(mail.sent.length, 1);
    const msg = mail.sent[0];
    assert.equal(msg.to, 'bidder@example.pt');
    assert.ok(msg.html.includes(`${BASE}/rfp/${TOKEN_NEW}`), 'secure link in the html body');
    assert.ok(msg.text.includes(TOKEN_NEW), 'token in the text body');
    assert.ok(!msg.subject.includes(TOKEN_NEW), 'token NEVER in the subject');
    // Delivery breadcrumb recorded, and the 201 reflects status → sent.
    assert.deepEqual(store.marked, [{ rfpId: RFP, recipientId: NEW_ID, messageId: 'mem-1' }]);
    assert.equal(res.body.items[0].status, 'sent');
    // The raw token is still echoed to the issuer ONCE.
    assert.equal(res.body.items[0].token, TOKEN_NEW);
  });

  test('reissueRecipientLink sends the rotated link (reissue variant)', async () => {
    const res = await dispatch('POST', `/rfps/${RFP}/recipients/${REC}:reissue`, viewer());
    assert.equal(res.status, 200);
    assert.equal(mail.sent.length, 1);
    assert.ok(mail.sent[0].html.includes(`${BASE}/rfp/${TOKEN_REISSUE}`));
    assert.match(mail.sent[0].subject, /atualizado/i);
    assert.equal(res.body.token, TOKEN_REISSUE);
    assert.deepEqual(store.marked, [{ rfpId: RFP, recipientId: REC, messageId: 'mem-1' }]);
  });

  test('the token NEVER reaches the logs, even through the log adapter', async () => {
    const lines = [];
    wire(createLogMailSender({ logger: { info: (...a) => lines.push(a) } }));
    await dispatch('POST', `/rfps/${RFP}/recipients`, viewer(), { recipients: [{ email: 'bidder@example.pt' }] });
    const serialized = JSON.stringify(lines);
    assert.ok(lines.length > 0, 'the log adapter did log a breadcrumb');
    assert.ok(!serialized.includes(TOKEN_NEW), 'token must never be logged');
    assert.ok(!serialized.includes('/rfp/'), 'the secure link must never be logged');
  });

  test('a mail provider failure never fails the (already committed) invite', async () => {
    wire({ provider: 'boom', async send() { throw new Error('provider down'); } });
    const res = await dispatch('POST', `/rfps/${RFP}/recipients`, viewer(), { recipients: [{ email: 'bidder@example.pt' }] });
    assert.equal(res.status, 201);
    // Not marked sent (stays queued for a later re-issue), but the invite stands.
    assert.equal(store.marked.length, 0);
    assert.equal(res.body.items[0].status, 'queued');
  });

  describe('invite-email:preview', () => {
    test('renders the copy with a NON-secret placeholder link, issuer-only', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}/invite-email:preview`, viewer(), null, { email: 'x@y.pt' });
      assert.equal(res.status, 200);
      assert.equal(res.body.to, 'x@y.pt');
      assert.match(res.body.subject, /Convite para proposta/);
      assert.ok(res.body.html.includes('/rfp/'), 'the link structure shows');
      // No live token: not a 64-hex credential anywhere in the preview.
      assert.ok(!/[0-9a-f]{64}/i.test(res.body.html + res.body.text), 'no live token in a preview');
    });

    test('reissue=true previews the rotated-link copy', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}/invite-email:preview`, viewer(), null, { reissue: 'true' });
      assert.equal(res.status, 200);
      assert.match(res.body.subject, /atualizado/i);
    });

    test('a non-issuer is 404 (existence hiding)', async () => {
      const res = await dispatch('GET', `/rfps/${RFP}/invite-email:preview`, viewer(BIDDER_ORG));
      assert.equal(res.status, 404);
    });
  });
});
