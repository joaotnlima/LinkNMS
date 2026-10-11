// PRD-08 store behaviour over the REAL v2 migrations (throwaway DB). Skipped
// without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/clarifications.pg.test.mjs
//
// Proves:
//   H-6  a link-only recipient (no org) can be recorded as the asker (0015);
//        a question with no asker at all is refused by the DB;
//   H-8  the answer commits its ledger entry AND the outbox event together;
//        the link lookup carries the questions deadline;
//   H-7  task-procurement and the tendering home count the open questions;
//   H-1  projectRfps: the issuer sees its draft, a bidder org never sees a
//        draft, and sees the published RFP it was invited to, with the
//        package roots named from the snapshot — one statement.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createTenderingStore } from './pg-store.mjs';
import { createTenderingAudience } from '../application/audience.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the tendering Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_tendering_clarif_test';

const OWNER_ORG = randomUUID();
const BIDDER_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const ROOT_TASK = randomUUID();
const CHILD = randomUUID();
const ACTOR = { personId: PERSON, orgId: OWNER_ORG, orgRole: 'manager', channel: 'ui' };

describe('PRD-08 clarifications + tendering home over Postgres', { skip }, () => {
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
         ($1, 'org_o', 'household', 'Família Silva'), ($2, 'org_b', 'contractor', 'Telhados do Norte')`,
      [OWNER_ORG, BIDDER_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_ana', 'ana@casa.pt', 'Ana')`,
      [PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status)
       VALUES ($1, $2, $2, 'Casa Silva', '1306', 'draft')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, parent_id, depth, position, kind, name) VALUES
         ($1, $3, NULL, 1, 'aa', 'summary', 'Cobertura'),
         ($2, $3, $1, 2, 'aa', 'task', 'Estrutura')`,
      [ROOT_TASK, CHILD, PROJECT],
    );
    store = createTenderingStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  async function published({ questionsDeadline = null } = {}) {
    const snapshot = await store.snapshotPackage(PROJECT, [ROOT_TASK]);
    const rfp = await store.createRfp({
      id: randomUUID(), projectId: PROJECT, issuerOrgId: OWNER_ORG, level: 'owner',
      parentContractId: null, title: 'Cobertura', scopeText: null, visibility: 'invite_only',
      questionsDeadline, submissionDeadline: '2099-01-15T17:00:00Z',
      rootTaskIds: [ROOT_TASK], packageRows: snapshot.rows, packageItems: snapshot.items, actor: ACTOR,
    });
    await store.addRecipients({
      rfpId: rfp.id, projectId: PROJECT, actor: ACTOR,
      recipients: [{ orgId: BIDDER_ORG, email: 'norte@telhados.pt' }, { orgId: null, email: 'c@solo.pt' }],
    });
    const out = await store.publishRfp({
      rfpId: rfp.id, from: 'draft', to: 'published', eventType: 'tendering.rfp.published',
      projectId: PROJECT, data: {}, actor: ACTOR,
    });
    const linkOnly = out.links.find((l) => l.recipient.email === 'c@solo.pt');
    return { rfp: out.rfp, linkOnly };
  }

  test('H-6/H-8: a link-only asker is stored; the answer ledgers and publishes in one commit', async () => {
    const { rfp, linkOnly } = await published({ questionsDeadline: '2099-01-10T00:00:00Z' });
    const rec = await store.findRecipientByToken(linkOnly.token);
    assert.equal(rec.org_id, null);
    assert.ok(rec.questions_deadline, 'the link lookup carries the questions deadline');

    const id = randomUUID();
    const q = await store.askClarification({
      id, rfpId: rfp.id, projectId: PROJECT, askedByRecipientId: rec.id,
      question: 'Andaimes incluídos?', actor: { personId: null, orgId: null, orgRole: null, channel: 'ui' },
    });
    assert.equal(q.asked_by_org_id, null);
    assert.equal(q.asked_by_recipient_id, rec.id);
    assert.ok(q.asked_at);

    await assert.rejects(pool.query(
      `INSERT INTO tendering.clarification (id, rfp_id, question) VALUES ($1, $2, 'x')`, [randomUUID(), rfp.id],
    ), /clarification_has_asker/);

    const home = (await store.projectRfps(PROJECT, OWNER_ORG)).items.find((r) => r.id === rfp.id);
    assert.equal(home.open_question_count, 1);
    const proc = (await store.taskProcurementOfProject(PROJECT, OWNER_ORG)).items.find((r) => r.id === rfp.id);
    assert.equal(proc.open_question_count, 1);

    const answered = await store.answerClarification({
      clarificationId: id, rfpId: rfp.id, projectId: PROJECT, answer: 'Sim.', actor: ACTOR,
    });
    assert.equal(answered.status, 'answered');
    assert.equal(await store.answerClarification({
      clarificationId: id, rfpId: rfp.id, projectId: PROJECT, answer: 'Again', actor: ACTOR,
    }), null, 'a second answer is a no-op');
    const { rows: outbox } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'tendering.clarification.answered'`,
    );
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].data.clarification_id, id);
    const { rows: ledger } = await pool.query(
      `SELECT 1 FROM record.audit_event WHERE object_id = $1 AND type = 'tendering.clarification.answered'`, [id],
    );
    assert.equal(ledger.length, 1);

    const emails = (await store.tokenOnlyRecipients(rfp.id)).map((r) => r.email);
    assert.deepEqual(emails, ['c@solo.pt'], 'only the bidder with no org is email-only');
  });

  test('H-1: one read — issuer sees its draft and the roots by name; a bidder never sees a draft', async () => {
    const { rfp } = await published();
    const snapshot = await store.snapshotPackage(PROJECT, [ROOT_TASK]);
    const draft = await store.createRfp({
      id: randomUUID(), projectId: PROJECT, issuerOrgId: OWNER_ORG, level: 'owner',
      parentContractId: null, title: 'Draft', scopeText: null, visibility: 'invite_only',
      questionsDeadline: null, submissionDeadline: '2099-02-01T17:00:00Z',
      rootTaskIds: [ROOT_TASK], packageRows: snapshot.rows, packageItems: snapshot.items, actor: ACTOR,
    });
    await store.addRecipients({
      rfpId: draft.id, projectId: PROJECT, actor: ACTOR, recipients: [{ orgId: BIDDER_ORG, email: 'norte@telhados.pt' }],
    });

    const { items: issuer } = await store.projectRfps(PROJECT, OWNER_ORG);
    const ids = issuer.map((r) => r.id);
    assert.ok(ids.includes(draft.id) && ids.includes(rfp.id));
    const pub = issuer.find((r) => r.id === rfp.id);
    assert.deepEqual(pub.covers, [{ task_id: ROOT_TASK, name: 'Cobertura' }]);
    assert.equal(pub.covered_task_count, 2);
    assert.equal(pub.lane_counts.invited, 2);

    const { items: bidder } = await store.projectRfps(PROJECT, BIDDER_ORG);
    assert.ok(!bidder.some((r) => r.id === draft.id), 'a draft is private to its issuer');
    const mine = bidder.find((r) => r.id === rfp.id);
    assert.ok(mine.my_proposal_id, "the bidder's own lane comes back");
    assert.deepEqual(await store.projectRfps(PROJECT, randomUUID()), { items: [], nextCursor: null });

    // Keyset pages (audit S6): one row a page walks the same set, newest first, once each.
    const walked = [];
    let cursor = null;
    do {
      const page = await store.projectRfps(PROJECT, OWNER_ORG, { cursor, limit: 1 });
      walked.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(walked, ids);
    const proc = await store.taskProcurementOfProject(PROJECT, OWNER_ORG, { limit: 1 });
    assert.equal(new Set(proc.items.map((r) => r.task_id)).size, 1, 'a page carries every tender of its task');
  });

  test('PRD-12 N-1: the audience port names issuer, package roots and bidder ORGS only', async () => {
    const { rfp } = await published();
    const audience = createTenderingAudience(store);
    const a = await audience.rfpAudience(rfp.id);
    assert.equal(a.issuer_org_id, OWNER_ORG);
    assert.equal(a.project_id, PROJECT);
    assert.deepEqual(a.root_task_ids, [ROOT_TASK]);
    assert.deepEqual(a.bidders.map((b) => b.org_id), [BIDDER_ORG], 'the link-only recipient has no org — not here');
    assert.equal(a.bidders[0].active, true);
    assert.ok(!('email' in a.bidders[0]), 'no contact data crosses the port');

    await pool.query(`UPDATE tendering.rfp_recipient SET status = 'declined' WHERE rfp_id = $1 AND org_id = $2`, [rfp.id, BIDDER_ORG]);
    assert.equal((await audience.rfpAudience(rfp.id)).bidders[0].active, false, 'a declined invitation is out of the tender');
    assert.equal(await audience.rfpAudience(randomUUID()), null);
  });
});
