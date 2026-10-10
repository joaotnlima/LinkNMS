// PRD-04 store behaviour over the REAL v2 migrations (throwaway DB). Skipped
// without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/bid-requests.pg.test.mjs
//
// Proves:
//   0023  listed ⇔ visibility (trigger, both directions); specialty_codes from
//         the package rows' task.specialty_code;
//   X-13  ask to bid is idempotent per (RFP, org), ledgered rfp_private with no
//         organisation, on the outbox with it; approval creates the lane
//         (source asked_to_bid) — or ADOPTS a prior e-mail invite to the org's
//         address — in one transaction with its event; decline;
//   X-1   recipients carry source + company name; "invite more" on a sent RFP
//         publishes tendering.rfp.recipients_added;
//   X-9/10 the inbox reads; declining an invitation;
//   X-2/§6.3 address-only invitees of a sent RFP; the claim back-fill.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createTenderingStore } from './pg-store.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the tendering Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_tendering_prd04_test';

const OWNER_ORG = randomUUID();
const ROOFER_ORG = randomUUID();
const CLAIMANT_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const ROOT_TASK = randomUUID();
const CHILD = randomUUID();
const ACTOR = { personId: PERSON, orgId: OWNER_ORG, orgRole: 'manager', channel: 'ui' };
const ROOFER_ACTOR = { personId: PERSON, orgId: ROOFER_ORG, orgRole: 'manager', channel: 'ui' };

describe('PRD-04 tendering store over Postgres', { skip }, () => {
  let pg, admin, pool, store;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    const migrations = readdirSync(join(ROOT, 'db', 'v2')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const f of migrations) await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_o', 'household', 'Família Silva'), ($2, 'org_r', 'contractor', 'Telhados do Norte')`,
      [OWNER_ORG, ROOFER_ORG],
    );
    await pool.query(`INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'ana@casa.pt', 'Ana')`, [PERSON]);
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status)
       VALUES ($1, $2, $2, 'Casa da Encosta', '1111', 'draft')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, parent_id, depth, position, kind, name, specialty_code) VALUES
         ($1, $3, NULL, 1, 'aa', 'summary', 'Cobertura', 'roofing'),
         ($2, $3, $1, 2, 'aa', 'task', 'Telha', 'roofing-tiled')`,
      [ROOT_TASK, CHILD, PROJECT],
    );
    store = createTenderingStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  async function rfp({ listed = false, publish = true } = {}) {
    const snapshot = await store.snapshotPackage(PROJECT, [ROOT_TASK]);
    const created = await store.createRfp({
      id: randomUUID(), projectId: PROJECT, issuerOrgId: OWNER_ORG, level: 'owner', parentContractId: null,
      title: 'Cobertura', scopeText: null, listed, questionsDeadline: null, submissionDeadline: '2099-01-15T17:00:00Z',
      rootTaskIds: [ROOT_TASK], packageRows: snapshot.rows, packageItems: snapshot.items, actor: ACTOR,
    });
    if (!publish) return created;
    const out = await store.publishRfp({
      rfpId: created.id, from: 'draft', to: 'published', eventType: 'tendering.rfp.published',
      projectId: PROJECT, data: {}, actor: ACTOR,
    });
    return out.rfp;
  }

  const outbox = async (type) => (await pool.query('SELECT data FROM platform.outbox WHERE type = $1 ORDER BY occurred_at', [type])).rows;

  test('0023: listed and the deprecated visibility move together; specialty codes come from the package', async () => {
    const r = await rfp({ listed: true, publish: false });
    assert.equal(r.listed, true);
    assert.equal(r.visibility, 'open');
    assert.deepEqual(r.specialty_codes, ['roofing', 'roofing-tiled']);
    await pool.query(`UPDATE tendering.rfp SET visibility = 'invite_only' WHERE id = $1`, [r.id]);
    let { rows } = await pool.query('SELECT listed, visibility FROM tendering.rfp WHERE id = $1', [r.id]);
    assert.deepEqual(rows[0], { listed: false, visibility: 'invite_only' });
    const updated = await store.updateRfp({
      rfpId: r.id, expectedVersion: r.version + 0, set: { listed: true }, rootTaskIds: null, packageRows: null, packageItems: null, actor: ACTOR,
    });
    assert.equal(updated.listed, true);
    assert.equal(updated.visibility, 'open');
    ({ rows } = await pool.query(
      `INSERT INTO tendering.rfp (id, project_id, issuer_org_id, level, title, visibility, submission_deadline)
       VALUES ($1, $2, $3, 'owner', 'Legacy writer', 'open', now()) RETURNING listed`,
      [randomUUID(), PROJECT, OWNER_ORG],
    ));
    assert.equal(rows[0].listed, true, 'a pre-PRD-04 writer of visibility=open lands listed');
  });

  test('X-13: ask is idempotent; ledger rfp_private without the org; outbox carries it', async () => {
    const r = await rfp({ listed: true });
    const first = await store.createBidRequest({ id: randomUUID(), rfpId: r.id, projectId: PROJECT, orgId: ROOFER_ORG, actor: ROOFER_ACTOR });
    const again = await store.createBidRequest({ id: randomUUID(), rfpId: r.id, projectId: PROJECT, orgId: ROOFER_ORG, actor: ROOFER_ACTOR });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.request.id, first.request.id);
    const { rows: ledger } = await pool.query(
      `SELECT scope_type, payload FROM record.audit_event WHERE type = 'tendering.bid_request.requested' AND object_id = $1`,
      [first.request.id],
    );
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].scope_type, 'rfp_private');
    assert.equal(ledger[0].payload.org_id, undefined);
    const events = (await outbox('tendering.bid_request.requested')).filter((e) => e.data.bid_request_id === first.request.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.org_id, ROOFER_ORG);
    assert.equal((await store.getBidRequest(first.request.id)).rfp_status, 'published');
  });

  test('X-13: approval creates the asked_to_bid lane; a second decision is refused', async () => {
    const r = await rfp({ listed: true });
    const { request } = await store.createBidRequest({ id: randomUUID(), rfpId: r.id, projectId: PROJECT, orgId: ROOFER_ORG, actor: ROOFER_ACTOR });
    const out = await store.approveBidRequest({
      requestId: request.id, rfpId: r.id, projectId: PROJECT, orgId: ROOFER_ORG, email: 'geral@telhados.pt', actor: ACTOR,
    });
    assert.equal(out.request.status, 'approved');
    assert.equal(out.recipient.source, 'asked_to_bid');
    assert.match(out.token, /^[0-9a-f]{64}$/);
    const { rows: lanes } = await pool.query('SELECT bidder_org_id, status FROM tendering.proposal WHERE recipient_id = $1', [out.recipient.id]);
    assert.deepEqual(lanes, [{ bidder_org_id: ROOFER_ORG, status: 'invited' }]);
    assert.equal(await store.declineBidRequest({ requestId: request.id, projectId: PROJECT, actor: ACTOR }), null);
    assert.equal((await outbox('tendering.bid_request.approved')).at(-1).data.adopted, false);
  });

  test('X-13: approval ADOPTS a prior e-mail invite to the org address — one lane, no new link', async () => {
    const r = await rfp({ listed: true, publish: false });
    await store.addRecipients({ rfpId: r.id, projectId: PROJECT, actor: ACTOR, recipients: [{ orgId: null, email: 'geral@telhados.pt', source: 'email' }] });
    await store.publishRfp({ rfpId: r.id, from: 'draft', to: 'published', eventType: 'tendering.rfp.published', projectId: PROJECT, data: {}, actor: ACTOR });
    const { request } = await store.createBidRequest({ id: randomUUID(), rfpId: r.id, projectId: PROJECT, orgId: ROOFER_ORG, actor: ROOFER_ACTOR });
    const out = await store.approveBidRequest({
      requestId: request.id, rfpId: r.id, projectId: PROJECT, orgId: ROOFER_ORG, email: 'geral@telhados.pt', actor: ACTOR,
    });
    assert.equal(out.token, null);
    assert.equal(out.recipient.source, 'email', 'the invite keeps where it came from');
    const { rows } = await pool.query(
      `SELECT rec.org_id, p.bidder_org_id FROM tendering.rfp_recipient rec JOIN tendering.proposal p ON p.recipient_id = rec.id
        WHERE rec.rfp_id = $1`, [r.id],
    );
    assert.deepEqual(rows, [{ org_id: ROOFER_ORG, bidder_org_id: ROOFER_ORG }]);
  });

  test('decline: the request is stamped, no lane', async () => {
    const r = await rfp({ listed: true });
    const { request } = await store.createBidRequest({ id: randomUUID(), rfpId: r.id, projectId: PROJECT, orgId: ROOFER_ORG, actor: ROOFER_ACTOR });
    const declined = await store.declineBidRequest({ requestId: request.id, projectId: PROJECT, actor: ACTOR });
    assert.equal(declined.status, 'declined');
    assert.equal(declined.decided_by_person_id, PERSON);
    assert.equal((await store.listBidRequests(r.id))[0].status, 'declined');
    const { rows } = await pool.query('SELECT 1 FROM tendering.rfp_recipient WHERE rfp_id = $1', [r.id]);
    assert.equal(rows.length, 0);
  });

  test('X-1: source and company name persist; invite-more on a sent RFP is an outbox event', async () => {
    const r = await rfp();
    const before = (await outbox('tendering.rfp.recipients_added')).length;
    const added = await store.addRecipients({
      rfpId: r.id, projectId: PROJECT, actor: ACTOR, published: true,
      recipients: [{ orgId: ROOFER_ORG, email: 'geral@telhados.pt', source: 'directory', companyName: 'Telhados do Norte' },
        { orgId: null, email: 'obra@amigo.pt', source: 'email' }],
    });
    assert.deepEqual(added.map((a) => [a.recipient.source, a.recipient.company_name]),
      [['directory', 'Telhados do Norte'], ['email', null]]);
    const after = await outbox('tendering.rfp.recipients_added');
    assert.equal(after.length, before + 1);
    assert.equal(after.at(-1).data.count, 2);
    assert.deepEqual(await store.emailInvitees(r.id), { emails: ['obra@amigo.pt'], specialty_codes: ['roofing', 'roofing-tiled'] });
  });

  test('X-9/X-10: the inbox reads and declining an invitation', async () => {
    const listed = await rfp({ listed: true });
    const invited = await rfp();
    await store.addRecipients({
      rfpId: invited.id, projectId: PROJECT, actor: ACTOR, published: true,
      recipients: [{ orgId: ROOFER_ORG, email: 'roofer@telhados.pt', source: 'directory', companyName: 'Telhados do Norte' }],
    });
    const open = await store.listedOpenRfps({ orgId: ROOFER_ORG });
    assert.ok(open.some((o) => o.id === listed.id));
    assert.ok(!open.some((o) => o.id === invited.id), 'an RFP the org is invited to is not an open request for it');
    assert.equal(Number(open.find((o) => o.id === listed.id).task_count), 2);
    assert.ok(!(await store.listedOpenRfps({ orgId: OWNER_ORG })).some((o) => o.id === listed.id), 'never the issuer’s own');

    const page = await store.requestsForOrg(ROOFER_ORG, { cursor: null, limit: 50 });
    const mine = page.items.find((i) => i.rfp_id === invited.id);
    assert.equal(mine.source, 'directory');
    assert.equal(Number(mine.task_count), 2);
    assert.equal(mine.proposal_status, 'invited');

    const invite = await store.invitationOf(invited.id, ROOFER_ORG);
    assert.equal(await store.declineInvitation({ rfpId: invited.id, recipientId: invite.id, projectId: PROJECT, actor: ROOFER_ACTOR }), true);
    assert.equal(await store.declineInvitation({ rfpId: invited.id, recipientId: invite.id, projectId: PROJECT, actor: ROOFER_ACTOR }), false);
    assert.equal((await store.requestForOrg(invited.id, ROOFER_ORG)).recipient_status, 'declined');
  });

  test('§6.3: the claim back-fills every past invite to the address and its lane, never the claimant’s own', async () => {
    const a = await rfp();
    const b = await rfp();
    for (const r of [a, b]) {
      await store.addRecipients({ rfpId: r.id, projectId: PROJECT, actor: ACTOR, published: true,
        recipients: [{ orgId: null, email: 'Obra@Silva-Roofing.pt', source: 'email' }] });
    }
    assert.equal(await store.adoptClaimedAddress({ orgId: CLAIMANT_ORG, email: 'obra@silva-roofing.pt' }), 2);
    assert.equal(await store.adoptClaimedAddress({ orgId: CLAIMANT_ORG, email: 'obra@silva-roofing.pt' }), 0, 'idempotent');
    const { rows } = await pool.query(
      `SELECT rec.org_id, p.bidder_org_id FROM tendering.rfp_recipient rec JOIN tendering.proposal p ON p.recipient_id = rec.id
        WHERE lower(rec.email) = 'obra@silva-roofing.pt'`,
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.org_id === CLAIMANT_ORG && r.bidder_org_id === CLAIMANT_ORG));
    assert.equal(await store.adoptClaimedAddress({ orgId: OWNER_ORG, email: 'obra@amigo.pt' }), 0, 'the issuer never adopts its own invites');
  });
});
