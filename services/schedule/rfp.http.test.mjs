// HTTP-layer contract tests for the RFP procurement loop (LINA-279, ADR-0023,
// LINA-294-ratified surface).
// Proving, at the handler boundary (what the Next routes actually call):
//   - the authenticated writer routes (procurement GET/PUT, attachment, recipient
//     add/remove, send) derive the actor from the session and gate on
//     VIEW_RFP / MANAGE_RFP;
//   - the public token routes (preview/upload/submit) need NO session — the
//     token IS the credential — with the ratified ladder: unknown/declined → 404,
//     submitted → 200-with-proposal (GET) or 409 (POST), closed phase → 410
//     rfp_closed, malformed body → 400;
//   - the token lifecycle: only SHA-256 is stored, the raw token exists only in
//     the email link, and preview flips invited→viewed so the owner's inbox is
//     honest;
//   - send() fails closed (503) when email is unconfigured and mints nothing
//     on that path (ADR-0007 §5);
//   - every denial is a typed envelope, never a 500.
// Run: node --test services/schedule/rfp.http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createScheduleHttp } from './http.mjs';
import { createInMemoryStore, createInMemoryIdentity } from './ports.mjs';
import { createInMemoryBlobStore } from './blob-store.mjs';
import { createRfpService } from './rfp.mjs';

const PROJECT = 'proj-1';
const ALICE = 'party-alice';      // owner — may view and manage the RFP
const BOB = 'party-bob';          // counterparty — may view and manage the RFP
const CHARLIE = 'party-charlie';  // subcontractor — may NOT view or manage
const PHASE = 'phase-procurement';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('IHDR'),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
// A minimal ISO-BMFF "brand box": 4-byte size, 'ftyp', then the brand 'heic'.
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypheic')]);
const GIF = Buffer.from('GIF89a', 'latin1');
const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);

function seedPhase(store, { status = 'active' } = {}) {
  store._phases.set(PHASE, {
    id: PHASE, project_id: PROJECT, kind: 'procurement', name: 'Procurement',
    status, sequence: 0, responsible_party_ids: [],
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  });
}

function build({ phaseStatus = 'active', senderConf = null } = {}) {
  const store = createInMemoryStore();
  seedPhase(store, { status: phaseStatus });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: ALICE, role: 'owner' },
      { projectId: PROJECT, partyId: BOB, role: 'counterparty' },
      { projectId: PROJECT, partyId: CHARLIE, role: 'subcontractor' },
    ],
    projects: [{ projectId: PROJECT, name: 'Harbour House' }],
  });
  const blob = createInMemoryBlobStore();
  const sender = senderConf ?? {
    sent: [],
    async send(msg) { this.sent.push(msg); return { id: 'mail-1' }; },
    isConfigured() { return true; },
  };
  const rfp = createRfpService({ store, identity, blob, sender });
  const http = createScheduleHttp({ service: {}, rfp });
  return { store, identity, blob, sender, http };
}

const alice = { partyId: ALICE };
const bob = { partyId: BOB };
const charlie = { partyId: CHARLIE };
const project = { projectId: PROJECT };
const hostHeaders = { host: 'app.linknms.dev', 'x-forwarded-proto': 'https' };
const tokenFor = (html) => html.match(/rfp\/([A-Za-z0-9_-]+)/)[1];

const goodProposal = () => ({
  companyName: 'Jetty Bros',
  websiteUrl: 'https://jetty.example',
  portfolioImages: [],
  budgetMinCents: 2000000,
  budgetMaxCents: 2500000,
  timelineDays: 60,
  comment: 'Can start next month.',
});

// Draft + invitees + send, the happy path most token tests start from.
async function madeRfp(http, { session = alice, emails = ['a@example.com'], description = 'Extend the harbour jetty', specialties = ['Marine'] } = {}) {
  const saved = await http.saveRfpDraft({ session, params: project, body: { description, specialties } });
  assert.equal(saved.status, 200);
  await http.addRfpRecipients({ session, params: project, body: { emails } });
}

async function sendRfpView(http, { session = alice } = {}) {
  const res = await http.sendProcurementRfp({ session, params: project, headers: hostHeaders });
  assert.equal(res.status, 200);
  return res.body;
}

// ── GET procurement ─────────────────────────────────────────────────────────

test('GET procurement: an unreachable project is a typed 403 (never a probe); fresh project → the empty view shape', async () => {
  const { http } = build();
  const gone = await http.getProcurement({ session: alice, params: { projectId: 'proj-gone' } });
  assert.equal(gone.status, 403); // project the actor cannot see looks like a forbidden one
  assert.equal(gone.body.error.code, 'forbidden');

  const res = await http.getProcurement({ session: alice, params: project });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    phase: { id: PHASE, kind: 'procurement', name: 'Procurement', status: 'active', sequence: 0 },
    rfp: null,
    recipients: [],
    proposals: [],
    selectedProposalId: null,
  });
});

test('GET procurement: owner and counterparty read; subcontractor or stranger is a typed 403; no session a 401', async () => {
  const { http } = build();
  assert.equal((await http.getProcurement({ session: alice, params: project })).status, 200);
  assert.equal((await http.getProcurement({ session: bob, params: project })).status, 200);
  for (const session of [charlie, { partyId: 'party-stranger' }]) {
    const res = await http.getProcurement({ session, params: project });
    assert.equal(res.status, 403, `expected 403 for ${session?.partyId ?? 'no session'}`);
    assert.equal(res.body.error.code, 'forbidden');
  }
  const none = await http.getProcurement({ session: undefined, params: project });
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, 'unauthenticated');
});

// ── PUT rfp (the upsert) ────────────────────────────────────────────────────

test('PUT rfp upserts: creates on first save, updates the same row on the next, echoes specialties', async () => {
  const { http, store } = build();
  const first = await http.saveRfpDraft({ session: alice, params: project, body: { description: 'v1', specialties: ['Marine', 'Steel'] } });
  assert.equal(first.status, 200);
  const rfp = first.body.rfp;
  assert.equal(rfp.status, 'draft');
  assert.equal(rfp.phaseId, PHASE);
  assert.deepEqual(rfp.specialties, ['Marine', 'Steel']);
  assert.deepEqual(rfp.attachments, []);

  const second = await http.saveRfpDraft({ session: bob, params: project, body: { description: 'v1 edited', specialties: ['Steel'] } });
  assert.equal(second.status, 200);
  assert.equal(second.body.rfp.id, rfp.id);          // one live RFP, never a second row
  assert.equal(second.body.rfp.description, 'v1 edited');
  assert.deepEqual(second.body.rfp.specialties, ['Steel']);
  assert.equal(store._rfps.length, 1);
});

test('PUT rfp validates the draft: malformed specialties / oversized description → 400', async () => {
  const { http } = build();
  const attempt = (body) => http.saveRfpDraft({ session: alice, params: project, body });
  assert.equal((await attempt({ description: 'x', specialties: 'not-an-array' })).status, 400);
  assert.equal((await attempt({ description: 'x', specialties: [1] })).status, 400);
  assert.equal((await attempt({ description: 'x', specialties: ['  '] })).status, 400);
  assert.equal((await attempt({ description: 'x', specialties: new Array(21).fill('x') })).status, 400);
  assert.equal((await attempt({ description: 'x'.repeat(6001), specialties: [] })).status, 400);
});

test('PUT rfp refuses once sent (409 rfp_already_sent) and for a subcontractor (403)', async () => {
  const { http } = build();
  await madeRfp(http);
  const sent = await sendRfpView(http);
  assert.equal(sent.rfp.status, 'sent');

  const lock = await http.saveRfpDraft({ session: alice, params: project, body: { description: 'locked', specialties: [] } });
  assert.equal(lock.status, 409);
  assert.equal(lock.body.error.code, 'rfp_already_sent');

  const sub = await http.saveRfpDraft({ session: charlie, params: project, body: { description: 'x', specialties: [] } });
  assert.equal(sub.status, 403);
  assert.equal(sub.body.error.code, 'forbidden');
});

// ── RFP attachments ─────────────────────────────────────────────────────────

test('RFP attachment upload: a PNG appends a FileRef; a second upload appends, never replaces', async () => {
  const { http, store } = build();
  const first = await http.addRfpAttachment({ session: alice, params: project, file: { filename: 'brief.png', buffer: PNG } });
  assert.equal(first.status, 201);
  assert.equal(first.body.attachment.filename, 'brief.png');
  assert.equal(first.body.attachment.contentType, 'image/png');
  assert.equal(first.body.attachment.size, PNG.byteLength);
  assert.match(first.body.attachment.url, /^blob:\/\//);

  await http.addRfpAttachment({ session: alice, params: project, file: { filename: 'photo.jpg', buffer: JPEG } });
  assert.equal(store._rfps[0].attachments.length, 2);

  const view = await http.getProcurement({ session: alice, params: project });
  assert.equal(view.body.rfp.attachments.length, 2);
  assert.equal(view.body.rfp.attachments[0].contentType, 'image/png');
  assert.equal(view.body.rfp.attachments[1].contentType, 'image/jpeg');
});

test('attachment upload guards: empty → 400, oversize → 413, unknown type → 415, no session → 401', async () => {
  const { http } = build();
  const cases = [
    { file: { filename: 'x.png', buffer: Buffer.alloc(0) }, want: 400, code: 'empty_file' },
    { file: { filename: 'big.png', buffer: tooBig }, want: 413, code: 'attachment_too_large' },
    { file: { filename: 'x.txt', buffer: Buffer.from('hello') }, want: 415, code: 'unsupported_content_type' },
  ];
  for (const { file, want, code } of cases) {
    const res = await http.addRfpAttachment({ session: alice, params: project, file });
    assert.equal(res.status, want, `for ${file.filename}`);
    assert.equal(res.body.error.code, code);
  }
  const none = await http.addRfpAttachment({ session: undefined, params: project, file: { filename: 'x.png', buffer: PNG } });
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, 'unauthenticated');
});

// ── Recipients ──────────────────────────────────────────────────────────────

test('add recipients: normalised + deduped, the FULL list comes back, raw token never crosses', async () => {
  const { http, store } = build();
  const res = await http.addRfpRecipients({
    session: alice, params: project,
    body: { emails: ['ONE@Example.com', 'two@example.com', 'TWO@example.com'] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.recipients.length, 2);
  assert.equal(res.body.recipients[0].email, 'one@example.com');
  assert.equal(res.body.recipients[1].email, 'two@example.com');
  assert.equal('token' in res.body.recipients[0], false);      // raw token never returned
  assert.equal('token_hash' in res.body.recipients[0], false); // not even the hash
  assert.match(store._recipients[0].token_hash, /^[0-9a-f]{64}$/);

  // Re-adding an existing one is a silent no-op (no duplicate_recipient fired).
  const again = await http.addRfpRecipients({ session: alice, params: project, body: { emails: ['two@example.com', 'new@example.com'] } });
  assert.equal(again.status, 200);
  assert.equal(again.body.recipients.length, 3);
});

test('add recipients: a malformed address and a no-session call are typed, never 500', async () => {
  const { http } = build();
  const bad = await http.addRfpRecipients({ session: alice, params: project, body: { emails: ['not-an-email'] } });
  assert.equal(bad.status, 400);
  const none = await http.addRfpRecipients({ session: undefined, params: project, body: { emails: ['a@example.com'] } });
  assert.equal(none.status, 401);
  const sub = await http.addRfpRecipients({ session: charlie, params: project, body: { emails: ['a@example.com'] } });
  assert.equal(sub.status, 403);
});

test('remove recipient: 204 on a draft; unknown → 404; sealed once sent → 409', async () => {
  const { http } = build();
  const descriptions = { description: 'A brief', specialties: [] };
  await http.saveRfpDraft({ session: alice, params: project, body: descriptions });
  const { recipients } = (await http.addRfpRecipients({ session: alice, params: project, body: { emails: ['a@example.com', 'b@example.com'] } })).body;

  const del = await http.removeRfpRecipient({ session: alice, params: { ...project, recipientId: recipients[0].id } });
  assert.equal(del.status, 204);
  const view = await http.getProcurement({ session: alice, params: project });
  assert.deepEqual(view.body.recipients.map((r) => r.email), ['b@example.com']);

  const missing = await http.removeRfpRecipient({ session: alice, params: { ...project, recipientId: 'recipient-gone' } });
  assert.equal(missing.status, 404);

  await sendRfpView(http);
  const sealed = await http.removeRfpRecipient({ session: alice, params: { ...project, recipientId: recipients[1].id } });
  assert.equal(sealed.status, 409);
  assert.equal(sealed.body.error.code, 'rfp_already_sent');
});

// ── Send ────────────────────────────────────────────────────────────────────

test('send fails closed (503) and mints nothing when email is unconfigured', async () => {
  const { http, store } = build({
    senderConf: {
      sent: [], async send() { throw new Error('must not be called'); },
      isConfigured() { return false; },
    },
  });
  await madeRfp(http);
  const res = await http.sendProcurementRfp({ session: alice, params: project });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'email_unconfigured');
  assert.equal(store._rfps[0].status, 'draft'); // nothing flipped
});

test('send guards: rfp_empty (no draft and blank brief), no_recipients, and phase_not_active once closed', async () => {
  const { http } = build();
  const none = await http.sendProcurementRfp({ session: alice, params: project });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, 'rfp_empty');

  await http.saveRfpDraft({ session: alice, params: project, body: { description: '   ', specialties: [] } });
  const blank = await http.sendProcurementRfp({ session: alice, params: project });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error.code, 'rfp_empty');

  await http.saveRfpDraft({ session: alice, params: project, body: { description: 'Work', specialties: [] } });
  const lonely = await http.sendProcurementRfp({ session: alice, params: project });
  assert.equal(lonely.status, 400);
  assert.equal(lonely.body.error.code, 'no_recipients');

  const closed = build({ phaseStatus: 'active' });
  await closed.http.saveRfpDraft({ session: alice, params: project, body: { description: 'x', specialties: [] } });
  closed.store._phases.get(PHASE).status = 'signed_off'; // a constructor was chosen
  const res = await closed.http.sendProcurementRfp({ session: alice, params: project });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'phase_not_active');
});

test('send: happy path → 200 view (draft→sent), a mail whose token previews and walks invited→viewed; re-send rotates', async () => {
  const { http, sender } = build();
  await madeRfp(http);
  const view = await sendRfpView(http);
  assert.equal(view.rfp.status, 'sent');
  assert.equal(view.recipients.length, 1);
  assert.equal(view.recipients[0].status, 'invited'); // not viewed until opened

  assert.equal(sender.sent.length, 1);
  const html = sender.sent[0].html;
  assert.match(html, /https:\/\/app\.linknms\.dev\/rfp\//);
  assert.match(html, /Harbour House/); // project name dereferenced via identity (ADR-0006)
  const rawToken = tokenFor(html);

  const preview = await http.previewRfpToken({ params: { token: rawToken }, headers: hostHeaders });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.project.name, 'Harbour House');
  assert.equal(preview.body.project.location, null); // reserved-null until a locality column exists
  assert.equal(preview.body.recipientEmail, 'a@example.com');
  assert.deepEqual(preview.body.rfp, {
    description: 'Extend the harbour jetty', attachments: [], specialties: ['Marine'],
  });
  assert.equal(preview.body.proposal, null);

  const after = await http.getProcurement({ session: alice, params: project });
  assert.equal(after.body.recipients[0].status, 'viewed'); // preview walked invited→viewed

  // Re-send (unopened link, still `sent`): a FRESH token; the old link dies.
  await http.sendProcurementRfp({ session: bob, params: project, headers: hostHeaders });
  const secondToken = tokenFor(sender.sent[1].html);
  assert.notEqual(secondToken, rawToken);
  assert.equal((await http.previewRfpToken({ params: { token: rawToken } })).status, 404);
  assert.equal((await http.previewRfpToken({ params: { token: secondToken } })).status, 200);
});

// ── Public token routes (no session) ────────────────────────────────────────

test('token preview: unknown → uniform 404 with NO session', async () => {
  const { http } = build();
  const res = await http.previewRfpToken({ params: { token: 'not-a-real-token' } });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found'); // message is diagnostic; clients key on the code
});

test('token preview: declined recipient → uniform 404 (a dead link must not probe)', async () => {
  const { http, sender, store } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);
  store._recipients[0].status = 'declined';
  const res = await http.previewRfpToken({ params: { token: rawToken } });
  assert.equal(res.status, 404);
});

test('token preview: submitted token → 200 WITH the proposal even after the phase closes', async () => {
  const { http, sender, store } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);

  const submitted = await http.submitRfpProposal({ params: { token: rawToken }, body: goodProposal() });
  assert.equal(submitted.status, 201);

  // Execution activated after the bid landed — the confirmation page must still read.
  store._phases.get(PHASE).status = 'signed_off';
  const spent = await http.previewRfpToken({ params: { token: rawToken } });
  assert.equal(spent.status, 200);
  assert.equal(spent.body.proposal.companyName, 'Jetty Bros');
  assert.equal(spent.body.proposal.id, undefined);         // token ProposalView is id-less
  assert.equal(spent.body.proposal.rfpRecipientId, undefined);
  assert.equal(spent.body.proposal.websiteUrl, 'https://jetty.example/');
});

test('token preview: valid token on a closed phase → 410 rfp_closed', async () => {
  const { http, sender, store } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);

  store._phases.get(PHASE).status = 'signed_off';
  const res = await http.previewRfpToken({ params: { token: rawToken } });
  assert.equal(res.status, 410);
  assert.equal(res.body.error.code, 'rfp_closed');
});

test('portfolio upload: JPEG, PNG, WebP and HEIC accepted; GIF refused → 415; empty → 400; oversize → 413', async () => {
  const { http, sender } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);

  const png = await http.uploadPortfolioImage({ params: { token: rawToken }, file: { filename: 'site.png', buffer: PNG } });
  assert.equal(png.status, 201);
  assert.equal(png.body.image.contentType, 'image/png');
  assert.equal(png.body.image.filename, 'site.png');
  assert.match(png.body.image.url, /^blob:\/\//);

  for (const [name, bytes, type] of [['a.jpg', JPEG, 'image/jpeg'], ['a.webp', WEBP, 'image/webp'], ['a.heic', HEIC, 'image/heic']]) {
    const ok = await http.uploadPortfolioImage({ params: { token: rawToken }, file: { filename: name, buffer: bytes } });
    assert.equal(ok.status, 201, name);
    assert.equal(ok.body.image.contentType, type, name);
  }

  const gif = await http.uploadPortfolioImage({ params: { token: rawToken }, file: { filename: 'a.gif', buffer: GIF } });
  assert.equal(gif.status, 415);
  assert.equal(gif.body.error.code, 'unsupported_content_type');

  const empty = await http.uploadPortfolioImage({ params: { token: rawToken }, file: { filename: 'a.png', buffer: Buffer.alloc(0) } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'empty_file');

  const big = await http.uploadPortfolioImage({ params: { token: rawToken }, file: { filename: 'a.png', buffer: tooBig } });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'attachment_too_large');
});

test('portfolio upload: spent token → 409, closed phase → 410, unknown token → 404', async () => {
  const { http, sender, store } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);

  assert.equal((await http.uploadPortfolioImage({ params: { token: 'nope' }, file: { filename: 'a.png', buffer: PNG } })).status, 404);

  await http.submitRfpProposal({ params: { token: rawToken }, body: goodProposal() });
  const spent = await http.uploadPortfolioImage({ params: { token: rawToken }, file: { filename: 'a.png', buffer: PNG } });
  assert.equal(spent.status, 409);
  assert.equal(spent.body.error.code, 'already_submitted');

  store._recipients[0].status = 'invited'; // un-spend for the closure check
  store._phases.get(PHASE).status = 'signed_off';
  const closed = await http.uploadPortfolioImage({ params: { token: rawToken }, file: { filename: 'a.png', buffer: PNG } });
  assert.equal(closed.status, 410);
  assert.equal(closed.body.error.code, 'rfp_closed');
});

test('submit proposal → 201 with an id-less ProposalView; a second submit is 409 already_submitted', async () => {
  const { http, sender, store } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);

  const ok = await http.submitRfpProposal({ params: { token: rawToken }, body: goodProposal() });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.proposal, {
    companyName: 'Jetty Bros',
    websiteUrl: 'https://jetty.example/',
    portfolioImages: [],
    budgetMinCents: 2000000,
    budgetMaxCents: 2500000,
    timelineDays: 60,
    comment: 'Can start next month.',
    submittedAt: ok.body.proposal.submittedAt,
  });
  assert.equal(store._recipients[0].status, 'submitted'); // recipient spent, one proposal

  const again = await http.submitRfpProposal({ params: { token: rawToken }, body: goodProposal() });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_submitted');

  // The owner's inbox sees it, newest first, joined to the submitter's email.
  const view = await http.getProcurement({ session: alice, params: project });
  assert.equal(view.body.proposals.length, 1);
  assert.equal(view.body.proposals[0].recipientEmail, 'a@example.com');
  assert.equal(view.body.proposals[0].rfpRecipientId, store._recipients[0].id);
  assert.equal(view.body.selectedProposalId, null); // selection is LINA-280
});

test('submit carries portfolioImages into the record with camelCase on the wire, snake in the jsonb', async () => {
  const { http, sender, store } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);
  const images = [{ key: 'k1', filename: 'a.png', size: 3, contentType: 'image/png', url: 'blob://x/a.png' }];

  const res = await http.submitRfpProposal({ params: { token: rawToken }, body: { ...goodProposal(), portfolioImages: images } });
  assert.equal(res.status, 201);
  assert.equal(res.body.proposal.portfolioImages[0].contentType, 'image/png');
  assert.equal(res.body.proposal.portfolioImages[0].url, 'blob://x/a.png');
  assert.equal(store._proposals[0].portfolio_images[0].content_type, 'image/png');
});

test('submit validation: malformed budget/timeline/website/company → typed invalid_proposal, never 500', async () => {
  const { http, sender } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);

  const good = goodProposal();
  const cases = [
    { ...good, budgetMinCents: -1 },
    { ...good, budgetMaxCents: 0, budgetMinCents: 1 },
    { ...good, timelineDays: 0 },
    { ...good, timelineDays: 4000 },
    { ...good, companyName: '   ' },
    { ...good, websiteUrl: 'not-a-url' },
    { ...good, websiteUrl: 'javascript:alert(1)' },
    undefined,
  ];
  for (const bad of cases) {
    const res = await http.submitRfpProposal({ params: { token: rawToken }, body: bad });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    assert.equal(res.body.error.code, 'invalid_proposal');
  }
});

test('submit refuses more than 8 portfolio images with too_many_images', async () => {
  const { http, sender } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);
  const images = Array.from({ length: 9 }, (_, i) => ({
    key: `k${i}`, filename: `f${i}.png`, size: 1, contentType: 'image/png', url: `blob://x/${i}`,
  }));
  const res = await http.submitRfpProposal({ params: { token: rawToken }, body: { ...goodProposal(), portfolioImages: images } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'too_many_images');
});

test('submit: closed phase → 410 rfp_closed; declined token → 404', async () => {
  const { http, sender, store } = build();
  await madeRfp(http);
  await sendRfpView(http);
  const rawToken = tokenFor(sender.sent[0].html);

  store._phases.get(PHASE).status = 'signed_off';
  const closed = await http.submitRfpProposal({ params: { token: rawToken }, body: goodProposal() });
  assert.equal(closed.status, 410);
  assert.equal(closed.body.error.code, 'rfp_closed');

  store._phases.get(PHASE).status = 'active';
  store._recipients[0].status = 'declined';
  const dead = await http.submitRfpProposal({ params: { token: rawToken }, body: goodProposal() });
  assert.equal(dead.status, 404);
});