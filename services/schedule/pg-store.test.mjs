// Integration tests for the Schedule & Progress Postgres store + REAL ledger
// wiring (LINA-69; ADR-0005/0006 §1; spec §8). These run against a real Postgres
// (a throwaway Neon branch) — set DATABASE_URL to the migrator/owner connection
// string. Without it the suite skips, so CI on a machine with no DB stays green
// while the DB job runs the real thing (same convention as change_order/pg-store).
//
// What they prove, beyond the in-memory contract tests, is that the invariants
// hold in the DATABASE and across the schedule↔ledger seam:
//   * add/update/report write the projection AND the audit event in one commit;
//   * a stage's current status is DERIVED from the latest append-only row under a
//     total (reported_at, seq) order — including two reports in the same second
//     (spec §8.1, AC-P9);
//   * stage_progress is append-only in the DB (percent_only_in_progress CHECK);
//   * NO budget_event is ever written by Schedule & Progress, and the rollup is
//     unweighted, so a stage-cost change cannot move the budget (AC-P5/P12).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { sslFor } from '../ledger/db.mjs';
import { createPgLedger } from '../ledger/pg-ledger.mjs';
import { createPgStore } from './pg-store.mjs';
import { createScheduleService, HEADLINE } from './schedule.mjs';
import { DomainError } from './ports.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const ledgerDir = join(here, '..', 'ledger');
const DB = process.env.DATABASE_URL;
const ssl = sslFor(DB);

// A permissive Identity port: it authorizes the GC for writes and both parties for
// reads, so these tests focus on the DB-level invariants. The full GC-only /
// homeowner-denied authorization logic is covered by schedule.test.mjs.
function identityFor(members) {
  const roleOf = (partyId) => members.get(partyId) ?? null;
  return {
    authorize({ actorPartyId }) {
      if (!actorPartyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
      const role = roleOf(actorPartyId);
      if (role !== 'counterparty') throw new DomainError(403, 'forbidden', 'GC only');
      return { role };
    },
    requireMember(partyId) {
      if (!partyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
      const role = roleOf(partyId);
      if (!role) throw new DomainError(403, 'forbidden', 'not a member');
      return { partyId, role };
    },
  };
}

describe('Postgres Schedule & Progress store + ledger wiring', { skip: DB ? false : 'set DATABASE_URL to run' }, () => {
  let pool;
  let ledger;
  let store;

  before(async () => {
    pool = new Pool({ connectionString: DB, ssl, max: 4 });
    // The ledger + schedule schemas are expected migrated on the target branch;
    // if the base tables are absent, apply the base migrations (a duplicate-object
    // error means they already exist and is safely ignored).
    const have = await pool.query(
      "select to_regclass('schedule.stage') as s, to_regclass('ledger.audit_event') as l",
    );
    if (!have.rows[0].s || !have.rows[0].l) {
      for (const f of [join(ledgerDir, 'migrations', '0001_ledger.sql'),
        join(here, 'migrations', '0001_schedule.sql')]) {
        try { await pool.query(await readFile(f, 'utf8')); }
        catch (err) { if (err.code !== '42P07' && err.code !== '42P06') throw err; }
      }
    }
    ledger = createPgLedger({ pool });
    store = createPgStore({ pool });
  });

  after(async () => { if (pool) await pool.end(); });

  // Fresh project (unique UUIDs so reruns never collide) with a project_created
  // genesis carrying the baseline the ledger derives budget from.
  async function seed({ baselineBudgetCents = 5_000_000 } = {}) {
    const projectId = randomUUID();
    const homeowner = randomUUID();
    const gc = randomUUID();
    await ledger.appendEvent({
      projectId, type: 'project_created', actorPartyId: homeowner,
      occurredAt: '2026-08-28T09:00:00.000Z',
      payload: { name: 'Maple St build', baselineBudgetCents, ownerPartyId: homeowner },
    });
    const identity = identityFor(new Map([[homeowner, 'owner'], [gc, 'counterparty']]));
    const svc = createScheduleService({ store, ledger, identity });
    return { svc, projectId, homeowner, gc, baselineBudgetCents };
  }

  test('addStage persists the projection + a stage_added event, in plan order', async () => {
    const { svc, projectId, gc, homeowner } = await seed();
    await svc.addStage(projectId, gc, { name: 'Foundation', position: 1, plannedCostCents: 1_000_000 });
    await svc.addStage(projectId, gc, { name: 'Framing', position: 2 });
    const plan = await svc.getPlan(projectId, homeowner);
    assert.deepEqual(plan.stages.map((s) => s.name), ['Foundation', 'Framing']);
    assert.equal(plan.stages[0].currentStatus, 'not_started');

    const audit = await pool.query(
      "select type from ledger.audit_event where project_id = $1 and type = 'stage_added'",
      [projectId],
    );
    assert.equal(audit.rows.length, 2);
  });

  test('progress is append-only and current status is derived from the latest row', async () => {
    const { svc, projectId, gc, homeowner } = await seed();
    const s = await svc.addStage(projectId, gc, { name: 'Foundation', position: 1 });
    await svc.reportProgress(s.id, gc, { status: 'in_progress', percent: 60 });
    await svc.reportProgress(s.id, gc, { status: 'blocked', note: 'inspector' });
    const done = await svc.reportProgress(s.id, gc, { status: 'done' });

    assert.equal(done.currentStatus, 'done');
    assert.deepEqual(done.history.map((h) => h.status), ['in_progress', 'blocked', 'done']);
    // Three rows physically present — nothing overwritten.
    const rows = await pool.query('select count(*)::int n from schedule.stage_progress where stage_id = $1', [s.id]);
    assert.equal(rows.rows[0].n, 3);
  });

  test('the percent_only_in_progress CHECK rejects a done row carrying a percent', async () => {
    const { svc, projectId, gc } = await seed();
    const s = await svc.addStage(projectId, gc, { name: 'Foundation', position: 1 });
    // Bypass the service and hit the table directly to prove the DB is the backstop.
    await assert.rejects(
      () => pool.query(
        `insert into schedule.stage_progress (id, stage_id, project_id, status, percent, reported_by_party_id, reported_at)
         values ($1,$2,$3,'done',80,$4, now())`,
        [randomUUID(), s.id, projectId, randomUUID()],
      ),
      (err) => err.code === '23514',
    );
  });

  test('AC-P5/P12: a tripled stage cost moves no budget_event and no rollup', async () => {
    const { svc, projectId, gc, homeowner, baselineBudgetCents } = await seed();
    const a = await svc.addStage(projectId, gc, { name: 'A', position: 1, plannedCostCents: 1_000_000 });
    const b = await svc.addStage(projectId, gc, { name: 'B', position: 2, plannedCostCents: 1_000_000 });
    await svc.reportProgress(a.id, gc, { status: 'done' });

    let plan = await svc.getPlan(projectId, homeowner);
    const pctBefore = plan.percentComplete;
    assert.equal(plan.allocation.baselineCents, baselineBudgetCents);

    await svc.updateStage(b.id, gc, { plannedCostCents: 30_000_000 });
    plan = await svc.getPlan(projectId, homeowner);

    assert.equal(plan.allocation.baselineCents, baselineBudgetCents, 'baseline unmoved');
    assert.ok(plan.allocation.allocatedCents > baselineBudgetCents);
    assert.equal(plan.percentComplete, pctBefore, 'unweighted rollup unchanged');
    // No budget_event exists for this project — Schedule cannot write one.
    const be = await pool.query('select count(*)::int n from ledger.budget_event where project_id = $1', [projectId]);
    assert.equal(be.rows[0].n, 0);
  });

  test('AC-P9: two reports in the same instant resolve to one stable status via seq', async () => {
    const { svc, projectId, gc, homeowner } = await seed();
    const s = await svc.addStage(projectId, gc, { name: 'A', position: 1 });
    // Insert two progress rows with an identical reported_at directly, so the only
    // tie-break is seq (the higher one wins deterministically).
    const at = '2026-08-28T12:00:00.000Z';
    await pool.query(
      `insert into schedule.stage_progress (id, stage_id, project_id, status, percent, reported_by_party_id, reported_at)
       values ($1,$2,$3,'in_progress',10,$4,$5)`,
      [randomUUID(), s.id, projectId, gc, at],
    );
    await pool.query(
      `insert into schedule.stage_progress (id, stage_id, project_id, status, note, reported_by_party_id, reported_at)
       values ($1,$2,$3,'blocked','x',$4,$5)`,
      [randomUUID(), s.id, projectId, gc, at],
    );
    for (let i = 0; i < 5; i += 1) {
      const plan = await svc.getPlan(projectId, homeowner);
      assert.equal(plan.stages[0].currentStatus, 'blocked');
      assert.equal(plan.headline, HEADLINE.ATTENTION);
    }
  });
});
