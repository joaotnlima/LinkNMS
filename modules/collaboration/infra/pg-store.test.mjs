// Collaboration store + use cases over the REAL v2 migrations (throwaway DB,
// like the sibling modules). Skipped without DATABASE_URL.
//
// Proves the phase-7 acceptance (AGENT-INDEX §5) at the database level:
//   — QUESTION LIFECYCLE END TO END: ask (ledger+outbox in the comment's
//     transaction) → notification to the addressee via the outbox consumer →
//     answer (addressee only, one tx with the status move) → notification to
//     the asker → resolve (asker only, from answered only);
//   — DIGEST NOTIFICATIONS END TO END: three variation events inside the
//     15-minute window fold into ONE unread notification (count=3), replays
//     absorbed, and a person who disabled the category gets nothing;
// plus minutes (author-only circulate, per-org ack, all-acked flip, ledger)
// and the viewer-filtered activity feed (contract-scoped events hidden from
// non-parties).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createCollaborationStore } from './pg-store.mjs';
import { collaborationConsumers } from '../application/consumers.mjs';
import {
  createComment, answerQuestion, resolveQuestion, listMyQuestions,
  createMinute, circulateMinute, acknowledgeMinute, listActivity,
  listNotifications, markNotificationsRead, putNotificationPreferences,
} from '../application/use-cases.mjs';
import { dispatchPending, publishEvent } from '../../../platform/outbox.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the collaboration Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_collaboration_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const STRANGER_ORG = randomUUID();
const OWNER_PERSON = randomUUID();
const GC_PERSON = randomUUID();
const PROJECT = randomUUID();
const PRIME = randomUUID();
const TASK = randomUUID();

function viewer(orgId, clerkUserId, over = {}) {
  return { clerkUserId, orgId, orgRole: 'admin', channel: 'ui', has: () => true, ...over };
}
const owner = () => viewer(OWNER_ORG, 'user_silva');
const gc = () => viewer(GC_ORG, 'user_douro');

function variationEvent(over = {}) {
  return {
    event_id: randomUUID(),
    type: 'planning.variation.recorded',
    project_id: PROJECT,
    actor: { person_id: GC_PERSON, org_id: GC_ORG },
    scope: { type: 'project', id: PROJECT },
    data: { variation_id: randomUUID(), kind: 'time', task_id: TASK },
    ...over,
  };
}

describe('collaboration store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store, consumers;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    const migrations = readdirSync(join(ROOT, 'db', 'v2')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const f of migrations) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_owner', 'household', 'Família Silva'),
         ($2, 'org_gc', 'contractor', 'Douro Construções'),
         ($3, 'org_stranger', 'contractor', 'Alheia Lda')`,
      [OWNER_ORG, GC_ORG, STRANGER_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES
         ($1, 'user_silva', 'silva@casa.pt', 'Sr. Silva'),
         ($2, 'user_douro', 'douro@gc.pt', 'Eng. Douro')`,
      [OWNER_PERSON, GC_PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code)
       VALUES ($1, $2, $2, 'Casa Silva', '1306')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id) VALUES
         ($1, $2, 'owner', 'project', NULL),
         ($1, $3, 'prime_contractor', 'contract', $4)`,
      [PROJECT, OWNER_ORG, GC_ORG, PRIME],
    );
    await pool.query(
      `INSERT INTO identity.project_staffing (project_id, org_id, person_id, staffed_by) VALUES
         ($1, $2, $3, $3), ($1, $4, $5, $5)`,
      [PROJECT, OWNER_ORG, OWNER_PERSON, GC_ORG, GC_PERSON],
    );
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, client_org_id, supplier_org_id, reference, origin, status)
       VALUES ($1, $2, 'prime', $3, $4, 'PRIME-1', 'direct_entry', 'active')`,
      [PRIME, PROJECT, OWNER_ORG, GC_ORG],
    );
    await pool.query(
      `INSERT INTO planning.task (id, project_id, depth, position, name, branch_contract_id)
       VALUES ($1, $2, 2, 'aa', 'Reboco WC', $3)`,
      [TASK, PROJECT, PRIME],
    );
    store = createCollaborationStore(pool);
    consumers = collaborationConsumers(store);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('question lifecycle end to end: ask → notify addressee → answer → notify asker → resolve', async () => {
    const questionId = randomUUID();
    const asked = await createComment({
      viewer: owner(), store, objectType: 'task', objectId: TASK,
      body: {
        id: questionId, kind: 'question', addressee_org_id: GC_ORG,
        body: 'Porque mudou o prazo do reboco?',
      },
    });
    assert.equal(asked.status, 201);
    assert.equal(asked.body.question_status, 'open');

    // Opened in the same commit as ledger + outbox (§6.4).
    const { rows: ledger } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 AND type LIKE 'collaboration.question.%'`, [PROJECT],
    );
    assert.deepEqual(ledger.map((r) => r.type), ['collaboration.question.opened']);

    // The addressee sees it in the queue; a stranger org sees nothing.
    const queue = await listMyQuestions({ viewer: gc(), store, query: {} });
    assert.equal(queue.body.items.length, 1);
    const strangerQueue = await listMyQuestions({ viewer: viewer(STRANGER_ORG, 'user_douro'), store, query: {} });
    assert.equal(strangerQueue.body.items.length, 0);

    // Consumer: the addressee org's staffed person is notified once, even
    // under at-least-once delivery.
    await dispatchPending(pool, consumers);
    await pool.query(`UPDATE platform.outbox SET dispatched_at = NULL`); // simulate redelivery
    await dispatchPending(pool, consumers);
    const gcInbox = await listNotifications({ viewer: gc(), store, query: {} });
    assert.equal(gcInbox.body.items.length, 1);
    assert.equal(gcInbox.body.items[0].category, 'questions');

    // Resolving before an answer is refused; the owner cannot answer itself.
    await assert.rejects(resolveQuestion({ viewer: owner(), store, commentId: questionId }), /answer it first/);
    await assert.rejects(
      answerQuestion({ viewer: owner(), store, commentId: questionId, body: { id: randomUUID(), body: 'eu respondo' } }),
      /addressed to/,
    );

    const answered = await answerQuestion({
      viewer: gc(), store, commentId: questionId,
      body: { id: randomUUID(), body: 'Choveu duas semanas — variação de tempo registada.' },
    });
    assert.equal(answered.status, 201);
    assert.equal(answered.body.kind, 'answer');
    assert.equal(answered.body.answers_comment_id, questionId);

    await dispatchPending(pool, consumers);
    const ownerInbox = await listNotifications({ viewer: owner(), store, query: {} });
    assert.ok(ownerInbox.body.items.some((n) => n.title === 'Your question was answered'));

    // Only the asker resolves — and only from answered.
    await assert.rejects(resolveQuestion({ viewer: gc(), store, commentId: questionId }), /asked/);
    const resolved = await resolveQuestion({ viewer: owner(), store, commentId: questionId });
    assert.equal(resolved.body.question_status, 'resolved');

    const { rows: trail } = await pool.query(
      `SELECT type FROM record.audit_event WHERE project_id = $1 AND type LIKE 'collaboration.question.%' ORDER BY seq`, [PROJECT],
    );
    assert.deepEqual(trail.map((r) => r.type), [
      'collaboration.question.opened', 'collaboration.question.answered', 'collaboration.question.resolved',
    ]);
  });

  test('digest: three variations in the window fold into ONE unread notification', async () => {
    const events = [variationEvent(), variationEvent(), variationEvent()];
    for (const evt of events) await publishEvent(pool, evt);
    await dispatchPending(pool, consumers);
    // Redelivery of the whole batch is absorbed by event_ids in object_ref.
    await pool.query(`UPDATE platform.outbox SET dispatched_at = NULL WHERE type LIKE 'planning.variation.%'`);
    await dispatchPending(pool, consumers);

    const { rows } = await pool.query(
      `SELECT * FROM collaboration.notification WHERE person_id = $1 AND category = 'variations'`,
      [OWNER_PERSON],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].object_ref.count, 3);
    assert.match(rows[0].title, /^3 variations/);
    assert.equal(rows[0].read_at, null);

    // Reading the digest closes the window: the next variation opens a new one.
    await markNotificationsRead({ viewer: owner(), store, body: { ids: [rows[0].id] } });
    await publishEvent(pool, variationEvent());
    await dispatchPending(pool, consumers);
    const { rows: after } = await pool.query(
      `SELECT count(*)::int AS n FROM collaboration.notification WHERE person_id = $1 AND category = 'variations'`,
      [OWNER_PERSON],
    );
    assert.equal(after[0].n, 2);
  });

  test('preferences: disabling in_app for a category silences it', async () => {
    const saved = await putNotificationPreferences({
      viewer: gc(), store,
      body: { items: [{ category: 'variations', channel: 'in_app', enabled: false }] },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.items.length, 1);

    // GC subscribes to time variations — but its person disabled the category.
    await pool.query(
      `INSERT INTO collaboration.variation_subscription (project_id, org_id, kinds) VALUES ($1, $2, '{time}')`,
      [PROJECT, GC_ORG],
    );
    await publishEvent(pool, variationEvent());
    await dispatchPending(pool, consumers);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM collaboration.notification WHERE person_id = $1 AND category = 'variations'`,
      [GC_PERSON],
    );
    assert.equal(rows[0].n, 0);
  });

  test('minutes: author circulates, each attendee org acks once, all-acked flips the status', async () => {
    const minuteId = randomUUID();
    const created = await createMinute({
      viewer: gc(), store, projectId: PROJECT,
      body: {
        id: minuteId, date: '2026-09-26', attendees: [OWNER_ORG, GC_ORG],
        items: [{ text: 'Owner requests extra patio drainage', owner_org_id: GC_ORG, due_date: '2026-10-03' }],
      },
    });
    assert.equal(created.body.status, 'draft');

    // Acking a draft is illegal; only the author circulates.
    await assert.rejects(acknowledgeMinute({ viewer: owner(), store, minuteId }), /cannot acknowledge/);
    await assert.rejects(circulateMinute({ viewer: owner(), store, minuteId }), /wrote the minute/);
    const circulated = await circulateMinute({ viewer: gc(), store, minuteId });
    assert.equal(circulated.body.status, 'circulated');

    const one = await acknowledgeMinute({ viewer: gc(), store, minuteId });
    assert.equal(one.body.status, 'circulated');
    assert.equal(one.body.acks.length, 1);
    const replay = await acknowledgeMinute({ viewer: gc(), store, minuteId });
    assert.equal(replay.body.acks.length, 1); // absorbed, not doubled

    const all = await acknowledgeMinute({ viewer: owner(), store, minuteId });
    assert.equal(all.body.status, 'acknowledged');
    assert.equal(all.body.acks.length, 2);

    const { rows: acked } = await pool.query(
      `SELECT count(*)::int AS n FROM record.audit_event WHERE project_id = $1 AND type = 'collaboration.minute.acknowledged'`,
      [PROJECT],
    );
    assert.equal(acked[0].n, 2); // one ledger entry per org, replays silent
  });

  test('activity feed: participants see project events; contract-scoped stays with the parties', async () => {
    await publishEvent(pool, {
      event_id: randomUUID(),
      type: 'contracting.measurement.submitted',
      project_id: PROJECT,
      actor: { person_id: GC_PERSON, org_id: GC_ORG },
      scope: { type: 'contract', id: PRIME },
      data: { contract_id: PRIME, gross_cents: 125000 },
    });
    const forOwner = await listActivity({ viewer: owner(), store, projectId: PROJECT, query: {} });
    assert.ok(forOwner.body.items.some((i) => i.type === 'contracting.measurement.submitted'));
    assert.ok(forOwner.body.items.some((i) => i.type === 'collaboration.question.opened'));

    // A participant org outside the prime contract exists on other builds —
    // simulate one: stranger org joins the project without any contract.
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES ($1, $2, 'consultant', 'invitation')`,
      [PROJECT, STRANGER_ORG],
    );
    const forStranger = await listActivity({
      viewer: viewer(STRANGER_ORG, 'user_douro'), store, projectId: PROJECT, query: {},
    });
    assert.ok(!forStranger.body.items.some((i) => i.type === 'contracting.measurement.submitted'),
      'money event leaked outside the contract parties');
    assert.ok(forStranger.body.items.some((i) => i.type === 'collaboration.question.opened'));
  });

  test('threads hide unreadable objects: a proposal thread stays inside its lane', async () => {
    const rfpId = randomUUID();
    const recipientId = randomUUID();
    const proposalId = randomUUID();
    await pool.query(
      `INSERT INTO tendering.rfp (id, project_id, issuer_org_id, level, title, status, submission_deadline)
       VALUES ($1, $2, $3, 'owner', 'Cozinha', 'published', now() + interval '14 days')`,
      [rfpId, PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO tendering.rfp_recipient (id, rfp_id, org_id, email, token_hash)
       VALUES ($1, $2, $3, 'douro@gc.pt', $4)`,
      [recipientId, rfpId, GC_ORG, 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO tendering.proposal (id, rfp_id, recipient_id, bidder_org_id, status)
       VALUES ($1, $2, $3, $4, 'draft')`,
      [proposalId, rfpId, recipientId, GC_ORG],
    );
    // The bidder comments in its lane; a mere project participant gets 404.
    const inLane = await createComment({
      viewer: gc(), store, objectType: 'proposal', objectId: proposalId,
      body: { id: randomUUID(), kind: 'note', body: 'Confirmo visita quinta.' },
    });
    assert.equal(inLane.status, 201);
    await assert.rejects(
      createComment({
        viewer: viewer(STRANGER_ORG, 'user_douro'), store, objectType: 'proposal', objectId: proposalId,
        body: { id: randomUUID(), kind: 'note', body: 'posso ver?' },
      }),
      /Not found/i,
    );
  });
});
