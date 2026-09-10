// Integration tests for plan templates against a real Postgres (LINA-241;
// ADR-0018). Like the other schedule pg-store suites, they run only when
// DATABASE_URL points at the migrator/owner connection (a throwaway Neon branch)
// and SKIP otherwise, so CI on a DB-less machine stays green.
//
// What they prove beyond the in-memory contract tests — that the invariants hold
// in the DATABASE:
//   * migration 0008 applies (owner_scope check, system⟺owner_id check, the
//     partial unique index) and seeds exactly ONE system default whose body is
//     byte-identical to plan-skeleton.mjs (the single source of truth);
//   * the resolve ladder (user → system) is served from real rows;
//   * upsert writes the caller's single user default and a second upsert REPLACES
//     it — the partial unique index makes a 2nd default impossible;
//   * the DB refuses a 2nd system default (NULLS NOT DISTINCT) and a scope/owner
//     mismatch (the biconditional CHECK).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { sslFor } from '../ledger/db.mjs';
import { createPgStore } from './pg-store.mjs';
import { createPlanTemplateService } from './plan-template.mjs';
import { PLAN_SKELETON_BODY } from './plan-skeleton.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const DB = process.env.DATABASE_URL;
const ssl = sslFor(DB);

describe('Postgres plan templates (schedule.plan_template)', { skip: DB ? false : 'set DATABASE_URL to run' }, () => {
  let pool;
  let store;
  let planTemplate;

  before(async () => {
    pool = new Pool({ connectionString: DB, ssl, max: 4 });
    // The base schema is expected present; ensure it, then apply 0008. Each apply
    // is idempotent — a duplicate-object/column error means it's already there.
    const have = await pool.query("select to_regclass('schedule.stage') as s");
    if (!have.rows[0].s) {
      try { await pool.query(await readFile(join(here, 'migrations', '0001_schedule.sql'), 'utf8')); }
      catch (err) { if (!['42P07', '42P06'].includes(err.code)) throw err; }
    }
    try { await pool.query(await readFile(join(here, 'migrations', '0008_plan_template.sql'), 'utf8')); }
    catch (err) { if (!['42P07', '42P06', '42701'].includes(err.code)) throw err; }
    store = createPgStore({ pool });
    planTemplate = createPlanTemplateService({ store });
  });

  after(async () => { if (pool) await pool.end(); });

  test('seeds exactly one system default, body identical to PLAN_SKELETON', async () => {
    const { rows } = await pool.query(
      "select count(*)::int n from schedule.plan_template where owner_scope='system' and is_default");
    assert.equal(rows[0].n, 1);
    const sys = await store.getSystemDefaultTemplate();
    assert.equal(sys.owner_id, null);
    assert.deepEqual(sys.body, PLAN_SKELETON_BODY);
  });

  test('resolve ladder: system default when no user default, then the user default', async () => {
    const alice = randomUUID();
    const before = await planTemplate.resolveDefault(alice);
    assert.equal(before.source, 'system');

    const myBody = [{ name: 'Sitework', tasks: ['Clear', 'Grade'] }];
    await planTemplate.saveDefault(alice, { name: 'Mine', body: myBody });
    const after = await planTemplate.resolveDefault(alice);
    assert.equal(after.source, 'user');
    assert.deepEqual(after.body, myBody);
  });

  test('a second upsert replaces the caller\'s default — never a 2nd default row', async () => {
    const bob = randomUUID();
    await planTemplate.saveDefault(bob, { body: [{ name: 'v1', tasks: [] }] });
    await planTemplate.saveDefault(bob, { body: [{ name: 'v2', tasks: ['x'] }] });
    const { rows } = await pool.query(
      "select count(*)::int n from schedule.plan_template where owner_scope='user' and owner_id=$1 and is_default",
      [bob]);
    assert.equal(rows[0].n, 1);
    const resolved = await planTemplate.resolveDefault(bob);
    assert.deepEqual(resolved.body, [{ name: 'v2', tasks: ['x'] }]);
  });

  test('the DB refuses a 2nd system default (partial unique index, NULLS NOT DISTINCT)', async () => {
    await assert.rejects(
      pool.query(
        `insert into schedule.plan_template (owner_scope, owner_id, name, is_default, body)
         values ('system', null, 'dupe', true, '[]'::jsonb)`),
      /plan_template_one_default_per_owner|unique/);
  });

  test('the DB refuses a scope/owner mismatch (system must have NULL owner; user must name one)', async () => {
    await assert.rejects(
      pool.query(
        `insert into schedule.plan_template (owner_scope, owner_id, name, is_default, body)
         values ('system', $1, 'bad', false, '[]'::jsonb)`, [randomUUID()]),
      /plan_template_system_has_no_owner|check/);
    await assert.rejects(
      pool.query(
        `insert into schedule.plan_template (owner_scope, owner_id, name, is_default, body)
         values ('user', null, 'bad', false, '[]'::jsonb)`),
      /plan_template_system_has_no_owner|check/);
  });
});
