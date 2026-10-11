// PRD-10 E-13 over the REAL v2 migrations (throwaway DB). Skipped without
// DATABASE_URL. planning.baseline.taken, delivered through the outbox to the
// project consumers, seeds the phases of an unseeded build and moves the
// execution phase pending → active (procurement stays active); a replay and a
// later baseline change nothing; a signed-off phase is never walked back.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { publishEvent, dispatchPending } from '../../../platform/outbox.mjs';
import { createProjectStore } from './pg-store.mjs';
import { projectConsumers } from '../application/consumers.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the project Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_project_phase_activation_test';
const OWNER_ORG = randomUUID();
const PROJECT = randomUUID();

describe('execution phase activation on the first baseline (PRD-10 E-13)', { skip }, () => {
  let pg, admin, pool, store;

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
    await pool.query(`INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES ($1, 'o1', 'household', 'Família')`, [OWNER_ORG]);
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code) VALUES ($1, $2, $2, 'Casa', '1111')`,
      [PROJECT, OWNER_ORG],
    );
    store = createProjectStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin?.end();
  });

  const baselineTaken = async (version = 1) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await publishEvent(client, {
        event_id: randomUUID(), type: 'planning.baseline.taken', version: 1, project_id: PROJECT,
        actor: { person_id: null, org_id: OWNER_ORG }, scope: { type: 'project', id: PROJECT },
        data: { baseline_id: randomUUID(), contract_id: randomUUID(), version, reason: 'award', root_task_ids: [] },
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await dispatchPending(pool, projectConsumers(store));
  };
  const phases = async () => Object.fromEntries((await store.listPhasesByProject(PROJECT)).map((p) => [p.kind, p.status]));

  test('the first baseline seeds the phases and activates execution; procurement stays active', async () => {
    await baselineTaken();
    assert.deepEqual(await phases(), { procurement: 'active', execution: 'active' });
  });

  test('replays and later baselines change nothing; a signed-off phase stays signed off', async () => {
    await baselineTaken(2);
    assert.deepEqual(await phases(), { procurement: 'active', execution: 'active' });
    await pool.query(`UPDATE project.project_phase SET status = 'signed_off' WHERE project_id = $1 AND kind = 'execution'`, [PROJECT]);
    await baselineTaken(3);
    assert.deepEqual(await phases(), { procurement: 'active', execution: 'signed_off' });
  });
});
