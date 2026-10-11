// planning.project_setting (0014) over the REAL v2 migrations: absent row ⇒
// defaults, an upsert lands WITH its ledger entry, the range check holds in
// the schema. Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/planning-settings.pg.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createPlanningStore } from './pg-store.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the planning Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_planning_settings_test';

const OWNER_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const ACTOR = { personId: PERSON, orgId: OWNER_ORG, orgRole: 'manager', channel: 'ui' };

describe('planning settings over Postgres', { skip }, () => {
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
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES ($1, 'org_o', 'household', 'Família Almeida')`,
      [OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status)
       VALUES ($1, $2, $2, 'Casa da Encosta', '1111', 'draft')`,
      [PROJECT, OWNER_ORG],
    );
    store = createPlanningStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('absent row ⇒ null (the caller applies the defaults)', async () => {
    assert.equal(await store.getPlanningSettings(PROJECT), null);
  });

  test('upsert lands with its ledger entry; a second write updates in place', async () => {
    await store.putPlanningSettings({ projectId: PROJECT, mobilisationLeadWd: 8, actor: ACTOR });
    const saved = await store.putPlanningSettings({ projectId: PROJECT, mobilisationLeadWd: 3, actor: ACTOR });
    assert.equal(saved.mobilisation_lead_wd, 3);
    assert.equal((await store.getPlanningSettings(PROJECT)).mobilisation_lead_wd, 3);
    const { rows } = await pool.query(
      `SELECT payload FROM record.audit_event WHERE project_id = $1 AND type = 'planning.settings.updated' ORDER BY seq`,
      [PROJECT],
    );
    assert.deepEqual(rows.map((r) => r.payload.mobilisation_lead_wd), [8, 3]);
  });

  test('the schema refuses a lead outside 0–60', async () => {
    await assert.rejects(store.putPlanningSettings({ projectId: PROJECT, mobilisationLeadWd: 61, actor: ACTOR }));
    assert.equal((await store.getPlanningSettings(PROJECT)).mobilisation_lead_wd, 3);
  });
});
