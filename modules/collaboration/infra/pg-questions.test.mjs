// Questions, minutes and coordination notifications over the REAL v2
// migrations (PRD-12 N-3, N-5..N-7; db/v2 0028). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-questions.test.mjs
// Proves: the topic and the design-change decision land on the question (and
// the DB refuses a decision anywhere else), a scope gap reaches the owner via
// the project's build port, the build's question list holds only the viewer
// org's exchanges, drafts stay with their writer, and quality.nonconformity.*
// notify whose move it is with a deep link to the quality page.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createCollaborationStore } from './pg-store.mjs';
import { collaborationConsumers } from '../application/consumers.mjs';
import { createComment, answerQuestion, listMyQuestions, createMinute } from '../application/use-cases.mjs';
import { listProjectQuestions, listMinutes } from '../application/questions.mjs';
import { createIdentityAudience } from '../../identity/application/audience.mjs';
import { createIdentityStore } from '../../identity/infra/pg-store.mjs';
import { createBuildPort } from '../../project/application/build-port.mjs';
import { createProjectStore } from '../../project/infra/pg-store.mjs';
import { dispatchPending, publishEvent } from '../../../platform/outbox.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the collaboration questions Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_collaboration_questions_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const ARCH_ORG = randomUUID();
const OWNER_PERSON = randomUUID();
const GC_PERSON = randomUUID();
const ARCH_PERSON = randomUUID();
const PROJECT = randomUUID();

const viewer = (orgId, clerkUserId) => ({ clerkUserId, orgId, orgRole: 'admin', channel: 'ui', has: () => true });
const owner = () => viewer(OWNER_ORG, 'user_owner');
const gc = () => viewer(GC_ORG, 'user_gc');
const arch = () => viewer(ARCH_ORG, 'user_arch');

describe('questions and minutes over Postgres (PRD-12)', { skip }, () => {
  let pg, admin, pool, store, ports, consumers;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 2 });
    for (const f of readdirSync(join(ROOT, 'db', 'v2')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'org_o', 'household', 'Família Silva'), ($2, 'org_g', 'contractor', 'Douro'), ($3, 'org_a', 'consultant', 'Atelier')`,
      [OWNER_ORG, GC_ORG, ARCH_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES
         ($1, 'user_owner', 'o@x.pt', 'O'), ($2, 'user_gc', 'g@x.pt', 'G'), ($3, 'user_arch', 'a@x.pt', 'A')`,
      [OWNER_PERSON, GC_PERSON, ARCH_PERSON],
    );
    await pool.query(
      `INSERT INTO identity.org_membership (org_id, person_id, org_role) VALUES ($1, $2, 'admin'), ($3, $4, 'admin'), ($5, $6, 'admin')`,
      [OWNER_ORG, OWNER_PERSON, GC_ORG, GC_PERSON, ARCH_ORG, ARCH_PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code) VALUES ($1, $2, $2, 'Casa', '1306')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source) VALUES
         ($1, $2, 'owner', 'project'), ($1, $3, 'prime_contractor', 'project'), ($1, $4, 'consultant', 'invitation')`,
      [PROJECT, OWNER_ORG, GC_ORG, ARCH_ORG],
    );
    await pool.query(
      `INSERT INTO identity.project_staffing (project_id, org_id, person_id, staffed_by) VALUES
         ($1, $2, $3, $3), ($1, $4, $5, $5), ($1, $6, $7, $7)`,
      [PROJECT, OWNER_ORG, OWNER_PERSON, GC_ORG, GC_PERSON, ARCH_ORG, ARCH_PERSON],
    );
    store = createCollaborationStore(pool);
    ports = { builds: createBuildPort(createProjectStore(pool)) };
    consumers = collaborationConsumers(store, { identity: createIdentityAudience(createIdentityStore(pool)), logger: { error: () => {} } });
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('scope gap → the owner (build port); design change → decision on the question; lists', async () => {
    const gapId = randomUUID();
    const gap = await createComment({
      viewer: gc(), store, ports, objectType: 'project', objectId: PROJECT,
      body: { id: gapId, kind: 'question', topic: 'scope_gap', body: 'Ninguém tem a cobertura' },
    });
    assert.equal(gap.body.addressee_org_id, OWNER_ORG);
    const { rows: [evt] } = await pool.query(
      `SELECT data FROM platform.outbox WHERE type = 'collaboration.question.opened' AND data->>'comment_id' = $1`, [gapId],
    );
    assert.equal(evt.data.topic, 'scope_gap');

    const dcId = randomUUID();
    await createComment({
      viewer: gc(), store, ports, objectType: 'project', objectId: PROJECT,
      body: { id: dcId, kind: 'question', topic: 'design_change', addressee_org_id: ARCH_ORG, body: 'Caixilharia em alumínio?' },
    });
    const queue = await listMyQuestions({ viewer: arch(), store, query: { topic: 'design_change', project: PROJECT } });
    assert.deepEqual(queue.body.items.map((q) => [q.id, q.project_id, q.actions]), [[dcId, PROJECT, ['answer']]]);

    await answerQuestion({ viewer: arch(), store, commentId: dcId, body: { id: randomUUID(), body: 'Não', decision: 'rejected' } });
    const { rows: [q] } = await pool.query('SELECT decision, question_status FROM collaboration.comment WHERE id = $1', [dcId]);
    assert.deepEqual(q, { decision: 'rejected', question_status: 'answered' });
    // The DB refuses a decision on anything but an answered design change.
    await assert.rejects(pool.query(`UPDATE collaboration.comment SET decision = 'approved' WHERE id = $1`, [gapId]));

    // The owner sees its scope gap; the architect sees only its own exchange.
    const ownerList = await listProjectQuestions({ viewer: owner(), store, projectId: PROJECT, query: { role: 'addressed' } });
    assert.deepEqual(ownerList.body.items.map((i) => i.id), [gapId]);
    const archList = await listProjectQuestions({ viewer: arch(), store, projectId: PROJECT, query: {} });
    assert.deepEqual(archList.body.items.map((i) => [i.id, i.decision]), [[dcId, 'rejected']]);
    const gcAsked = await listProjectQuestions({ viewer: gc(), store, projectId: PROJECT, query: { role: 'asked', limit: '1' } });
    assert.equal(gcAsked.body.items.length, 1);
    assert.ok(gcAsked.body.next_cursor);
    const next = await listProjectQuestions({ viewer: gc(), store, projectId: PROJECT, query: { role: 'asked', cursor: gcAsked.body.next_cursor } });
    assert.equal(next.body.items.length, 1);
    assert.notEqual(next.body.items[0].id, gcAsked.body.items[0].id);

    // Notifications: the owner hears of the gap, the asker of the rejection.
    await dispatchPending(pool, consumers);
    const { rows: notes } = await pool.query(
      `SELECT person_id, title, object_ref->>'url' AS url FROM collaboration.notification WHERE category = 'questions' ORDER BY created_at`,
    );
    assert.ok(notes.some((n) => n.person_id === OWNER_PERSON && /scope gap/.test(n.title) && n.url === `/projects/${PROJECT}/questions?q=${gapId}`));
    assert.ok(notes.some((n) => n.person_id === GC_PERSON && n.title === 'Your design change was rejected'));
  });

  test('minutes: a draft stays with its writer; items and acks come in batch', async () => {
    const minuteId = randomUUID();
    await createMinute({
      viewer: gc(), store, projectId: PROJECT,
      body: { id: minuteId, date: '2026-10-09', attendees: [GC_ORG, OWNER_ORG], items: [{ text: 'Betonagem sexta', owner_org_id: GC_ORG }] },
    });
    assert.equal((await listMinutes({ viewer: owner(), store, projectId: PROJECT, query: {} })).body.items.length, 0);
    const mine = await listMinutes({ viewer: gc(), store, projectId: PROJECT, query: {} });
    assert.deepEqual(mine.body.items.map((m) => [m.id, m.actions, m.items.length]), [[minuteId, ['circulate'], 1]]);
  });

  test('quality.nonconformity.fixed → the raiser, with the quality deep link', async () => {
    const nc = randomUUID();
    await publishEvent(pool, {
      event_id: randomUUID(), type: 'quality.nonconformity.fixed', project_id: PROJECT,
      actor: { person_id: GC_PERSON, org_id: GC_ORG }, scope: { type: 'project', id: PROJECT },
      data: { nonconformity_id: nc, raised_by_org_id: ARCH_ORG, assigned_to_org_id: GC_ORG, kind: 'quality', status: 'fixed' },
    });
    await dispatchPending(pool, consumers);
    const { rows } = await pool.query(
      `SELECT person_id, object_ref FROM collaboration.notification WHERE category = 'quality'`,
    );
    assert.deepEqual(rows.map((r) => [r.person_id, r.object_ref.url, r.object_ref.id]), [[ARCH_PERSON, `/projects/${PROJECT}/quality?nc=${nc}`, nc]]);
  });
});
