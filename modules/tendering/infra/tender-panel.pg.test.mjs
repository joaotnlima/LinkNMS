// PRD-02 store behaviour over the REAL v2 migrations (throwaway DB). Skipped
// without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/tender-panel.pg.test.mjs
//
// Proves:
//   T-7  a draft's recipients hold no usable link; publish mints one per queued
//        recipient IN the publish transaction (ledger + event), stored as sha256;
//   T-6  a queued recipient (and its untouched lane) leaves a draft cleanly; a
//        published RFP refuses;
//   T-10 each transition stamps its moment; award stamps awarded_at;
//   T-19 cancel keeps the issuer's reason; task-procurement carries it;
//   T-3  excluded_task_ids persist on create and update.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

import { createTenderingStore } from './pg-store.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the tendering Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_tendering_panel_test';

const OWNER_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const ROOT_TASK = randomUUID();
const CHILD_A = randomUUID();
const CHILD_B = randomUUID();
const ACTOR = { personId: PERSON, orgId: OWNER_ORG, orgRole: 'manager', channel: 'ui' };
const sha = (t) => createHash('sha256').update(t).digest('hex');

describe('PRD-02 tendering store over Postgres', { skip }, () => {
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
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES ($1, 'org_o', 'household', 'Família Silva')`,
      [OWNER_ORG],
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
         ($1, $4, NULL, 1, 'aa', 'summary', 'Cobertura'),
         ($2, $4, $1, 2, 'aa', 'task', 'Estrutura'),
         ($3, $4, $1, 2, 'ab', 'task', 'Caleiras')`,
      [ROOT_TASK, CHILD_A, CHILD_B, PROJECT],
    );
    store = createTenderingStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  async function draft(extra = {}) {
    const snapshot = await store.snapshotPackage(PROJECT, [ROOT_TASK]);
    return store.createRfp({
      id: randomUUID(), projectId: PROJECT, issuerOrgId: OWNER_ORG, level: 'owner',
      parentContractId: null, title: 'Cobertura', scopeText: null, visibility: 'invite_only',
      questionsDeadline: null, submissionDeadline: '2027-01-15T17:00:00Z',
      rootTaskIds: [ROOT_TASK], packageRows: snapshot.rows, packageItems: snapshot.items,
      actor: ACTOR, ...extra,
    });
  }

  test('T-3: excluded_task_ids persist on create and on a draft update', async () => {
    const rfp = await draft({ excludedTaskIds: [CHILD_B] });
    assert.deepEqual(rfp.excluded_task_ids, [CHILD_B]);
    const updated = await store.updateRfp({
      rfpId: rfp.id, expectedVersion: rfp.version, set: {}, rootTaskIds: null,
      excludedTaskIds: [], packageRows: null, packageItems: null, actor: ACTOR,
    });
    assert.deepEqual(updated.excluded_task_ids, []);
    // An update that does not touch the exclusions keeps them.
    const again = await store.updateRfp({
      rfpId: rfp.id, expectedVersion: updated.version, set: { title: 'Cobertura v2' },
      rootTaskIds: null, packageRows: null, packageItems: null, actor: ACTOR,
    });
    assert.deepEqual(again.excluded_task_ids, []);
  });

  test('T-6/T-7: publish mints a link per queued recipient in one transaction; removal is draft-only', async () => {
    const rfp = await draft();
    const created = await store.addRecipients({
      rfpId: rfp.id, projectId: PROJECT, actor: ACTOR,
      recipients: [{ orgId: null, email: 'a@x.pt' }, { orgId: null, email: 'b@x.pt' }],
    });
    const draftHashes = new Map(created.map(({ recipient }) => [recipient.id, recipient.token_hash]));

    // Take one off the draft: the recipient and its lane go.
    const gone = created.find((c) => c.recipient.email === 'b@x.pt').recipient;
    assert.equal(await store.removeDraftRecipient({ rfpId: rfp.id, recipientId: gone.id, projectId: PROJECT, actor: ACTOR }), true);
    const { rows: lanes } = await pool.query('SELECT * FROM tendering.proposal WHERE rfp_id = $1', [rfp.id]);
    assert.equal(lanes.length, 1);

    const out = await store.publishRfp({
      rfpId: rfp.id, from: 'draft', to: 'published', eventType: 'tendering.rfp.published',
      projectId: PROJECT, data: { visibility: 'invite_only' }, actor: ACTOR,
    });
    assert.equal(out.rfp.status, 'published');
    assert.ok(out.rfp.published_at, 'published_at stamped');
    assert.equal(out.links.length, 1);
    const [{ recipient, token }] = out.links;
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(recipient.token_hash, sha(token), 'only the sha256 is stored');
    assert.notEqual(recipient.token_hash, draftHashes.get(recipient.id), 'a fresh link, not the draft placeholder');

    const { rows: ledger } = await pool.query(
      `SELECT type, payload FROM record.audit_event WHERE object_id = $1 AND type = 'tendering.rfp.published'`,
      [rfp.id],
    );
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].payload.links_minted, 1);
    const { rows: removed } = await pool.query(
      `SELECT 1 FROM record.audit_event WHERE object_id = $1 AND type = 'tendering.rfp.recipient_removed'`,
      [rfp.id],
    );
    assert.equal(removed.length, 1);

    // After publish the remaining recipient cannot be removed.
    assert.equal(await store.removeDraftRecipient({ rfpId: rfp.id, recipientId: recipient.id, projectId: PROJECT, actor: ACTOR }), null);
  });

  test('T-10/T-19: close and cancel stamp their moment; cancel keeps the reason, task-procurement reports it', async () => {
    const rfp = await draft();
    await store.publishRfp({
      rfpId: rfp.id, from: 'draft', to: 'published', eventType: 'tendering.rfp.published',
      projectId: PROJECT, data: {}, actor: ACTOR,
    });
    const closed = await store.transitionRfp({
      rfpId: rfp.id, from: 'published', to: 'closed', eventType: 'tendering.rfp.closed',
      projectId: PROJECT, data: {}, actor: ACTOR,
    });
    assert.ok(closed.closed_at);
    const cancelled = await store.transitionRfp({
      rfpId: rfp.id, from: 'closed', to: 'cancelled', eventType: 'tendering.rfp.cancelled',
      projectId: PROJECT, data: { reason: 'Owner changed the roof design' }, actor: ACTOR,
    });
    assert.ok(cancelled.cancelled_at);
    assert.equal(cancelled.cancel_reason, 'Owner changed the roof design');

    const rows = await store.taskProcurementOfProject(PROJECT, OWNER_ORG);
    const mine = rows.find((r) => r.id === rfp.id);
    assert.equal(mine.cancel_reason, 'Owner changed the roof design');
    assert.ok(mine.cancelled_at && mine.closed_at && mine.published_at);
  });
});
