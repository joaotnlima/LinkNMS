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
import ExcelJS from 'exceljs';

import { sslFor } from '../ledger/db.mjs';
import { createPgLedger } from '../ledger/pg-ledger.mjs';
import { createPgStore } from './pg-store.mjs';
import { createScheduleService, HEADLINE } from './schedule.mjs';
import { createPlanVersionService } from './plan-version.mjs';
import { createPlanImportService } from './plan-import.mjs';
import { createPhaseService } from './phases.mjs';
import { PARSER } from './plan-import-parser.mjs';
import { DomainError } from './ports.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const ledgerDir = join(here, '..', 'ledger');
const DB = process.env.DATABASE_URL;
const ssl = sslFor(DB);

// Shared connection + adapters for every DB-backed suite in this file. Hoisted
// to module scope so nested suites (plan-version authoring below) reuse the same
// pool/ledger/store the outer suite's `before` hook assigns.
let pool;
let ledger;
let store;

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
    // Slice B1 (LINA-206): plan_import / stage_dependency tables + the WBS
    // columns on schedule.stage. Applied when the base exists but this is still
    // missing (a fresh branch), or no-op when the Architect has applied it.
    try { await pool.query(await readFile(join(here, 'migrations', '0002_plan_wbs_and_import.sql'), 'utf8')); }
    catch (err) { if (!['42P07', '42P06', '42701'].includes(err.code)) throw err; }
    // Slice B2 + LINA-234/233 feature migrations (plan versioning, draft status,
    // stage description, guarded dependency DELETE). Applied when missing so these
    // integration tests run on any target (fresh or already-migrated branch);
    // each file is a single idempotent unit — duplicate-object / already-applied
    // errors mean it exists and are safely ignored.
    for (const f of ['0003_plan_versioning.sql', '0005_plan_draft_status.sql',
      '0006_stage_description.sql', '0007_stage_dependency_draft_delete.sql',
      '0012_project_phases_rfp_signoff.sql', '0013_phase_sign_off_grant_update.sql']) {
      try { await pool.query(await readFile(join(here, 'migrations', f), 'utf8')); }
      catch (err) {
        // 42704 = DROP CONSTRAINT on a constraint 0005 already dropped (re-run);
        // 42723 = CREATE FUNCTION already exists (re-run) — both are the applied signature.
        if (!['42P07', '42P06', '42701', '42710', '42704', '42723'].includes(err.code)) throw err;
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

  describe('plan import (Slice B1, LINA-206)', () => {
    // A tiny valid workbook: two top-level Actions, one sub-action each, one
    // intra-import predecessor. Build in memory — no binary fixtures in the repo.
    async function makeWorkbook() {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Plan');
      ws.addRow(['Action', 'Sub-action', 'Start', 'End', 'Trade', 'Dependency']);
      ws.addRow(['Foundation', '', '2026-01-05', '2026-02-02', 'Civil', '']);
      ws.addRow(['Foundation', 'Excavate', '2026-01-05', '2026-01-15', 'Civil', 'R2']);
      ws.addRow(['Framing', '', '2026-02-10', '2026-03-20', 'Carpentry', 'R3']);
      ws.addRow(['Framing', 'Walls', '2026-02-10', '2026-03-01', 'Carpentry', 'R3']);
      return Buffer.from(await wb.xlsx.writeBuffer());
    }

    async function planHarness() {
      const { projectId, gc, homeowner } = await seed();
      const identity = identityFor(new Map([[homeowner, 'owner'], [gc, 'counterparty']]));
      const planImport = createPlanImportService({ store, parser: PARSER, ledger, identity });
      return { planImport, projectId, gc, homeowner };
    }

    test('confirm commits projection + ONE plan_import event; stage ids ride the event in WBS pre-order', async () => {
      const { planImport, projectId, gc } = await planHarness();
      const buf = await makeWorkbook();
      const res = await planImport.confirm(projectId, gc, {
        filename: 'plan.xlsx', buffer: buf, sheet: 'Plan',
        mapping: { action: 1, subAction: 2, start: 3, end: 4, trade: 5, dependency: 6 },
        idempotencyKey: `idem-${randomUUID()}`,
      });
      assert.equal(res.stageCount, 4);
      assert.equal(res.rootCount, 2);

      const ev = await pool.query(
        'select payload from ledger.audit_event where project_id = $1 and type = $2',
        [projectId, 'plan_import'],
      );
      assert.equal(ev.rows.length, 1, 'the whole batch is exactly ONE audit event');
      const { stageIds, importId } = ev.rows[0].payload;

      const stages = await pool.query(
        `select source_row_ref, position, parent_id, import_id
           from schedule.stage where project_id = $1 order by position`,
        [projectId],
      );
      const rows = stages.rows;
      assert.equal(rows.length, 4);
      assert.deepEqual(stages.rows.map((r) => r.source_row_ref), ['R2', 'R3', 'R4', 'R5']);
      assert.equal(rows[0].parent_id, null, 'roots carry no parent');
      assert.notEqual(rows[1].parent_id, null, 'sub-actions chain to their root');
      assert.equal(rows.every((r) => r.import_id === importId), true);
      // Stage ids written == ids on the audit event, in order.
      const writtenIds = await pool.query('select id from schedule.stage where project_id = $1 order by position', [projectId]);
      assert.deepEqual(writtenIds.rows.map((r) => r.id), stageIds);

      const deps = await pool.query(
        `select s.source_row_ref as from, d.source_row_ref as to
           from schedule.stage_dependency sd
           join schedule.stage s on s.id = sd.stage_id
           join schedule.stage d on d.id = sd.depends_on_stage_id
          where s.project_id = $1 order by 1, 2`,
        [projectId],
      );
      assert.deepEqual(deps.rows.map((r) => `${r.from}->${r.to}`), ['R3->R2', 'R4->R3', 'R5->R3']);

      // The import SEEDS the proposal (LINA-215 #1, B2 contract §4 "import-seed"):
      // a plan_proposed event, a proposed v1 plan_version bound to the import, the
      // importer's authorship stamp, and every stage bound to the version.
      const proposedEv = await pool.query(
        'select id, payload from ledger.audit_event where project_id = $1 and type = $2',
        [projectId, 'plan_proposed'],
      );
      assert.equal(proposedEv.rows.length, 1, 'exactly one import-seed plan_proposed event');
      assert.equal(proposedEv.rows[0].payload.sourceImportId, importId);

      const versions = await pool.query(
        'select * from schedule.plan_version where project_id = $1',
        [projectId],
      );
      assert.equal(versions.rows.length, 1);
      assert.equal(versions.rows[0].version_no, 1);
      assert.equal(versions.rows[0].status, 'proposed');
      assert.equal(versions.rows[0].source_import_id, importId);
      assert.equal(versions.rows[0].supersedes_version_id, null);
      assert.equal(versions.rows[0].proposed_by_party_id, gc);
      assert.equal(proposedEv.rows[0].payload.planVersionId, versions.rows[0].id,
        'the plan_proposed event names the version it creates');

      const votes = await pool.query(
        'select * from schedule.plan_acceptance where plan_version_id = $1',
        [versions.rows[0].id],
      );
      assert.equal(votes.rows.length, 1);
      assert.equal(votes.rows[0].kind, 'proposed');
      assert.equal(votes.rows[0].party_id, gc);
      assert.equal(votes.rows[0].audit_event_id, proposedEv.rows[0].id,
        'the authorship stamp links the plan_proposed event (append-only)');
      const bound = await pool.query(
        'select plan_version_id from schedule.stage where project_id = $1',
        [projectId],
      );
      assert.equal(bound.rows.every((r) => r.plan_version_id === versions.rows[0].id), true,
        'every imported stage belongs to the seeded version');
    });

    test('the DB enforces idempotent confirm: a replay writes nothing and returns the original', async () => {
      const { planImport, projectId, gc } = await planHarness();
      const buf = await makeWorkbook();
      const opts = {
        filename: 'plan.xlsx', buffer: buf, sheet: 'Plan',
        mapping: { action: 1, subAction: 2, start: 3, end: 4, trade: 5, dependency: 6 },
        idempotencyKey: `retry-${randomUUID()}`,
      };
      const first = await planImport.confirm(projectId, gc, opts);
      const second = await planImport.confirm(projectId, gc, opts);
      assert.deepEqual(second, first, 'replay returns the ORIGINAL result');

      const count = await pool.query('select count(*)::int n from schedule.plan_import where project_id = $1', [projectId]);
      assert.equal(count.rows[0].n, 1, 'no second header');
      const events = await pool.query(
        'select count(*)::int n from ledger.audit_event where project_id = $1 and type = $2',
        [projectId, 'plan_import'],
      );
      assert.equal(events.rows[0].n, 1, 'the phantom event rolled back with the txn');
      const versions = await pool.query(
        'select count(*)::int n from schedule.plan_version where project_id = $1',
        [projectId],
      );
      assert.equal(versions.rows[0].n, 1, 'the replay creates no second seeded version');
      const proposedEvs = await pool.query(
        'select count(*)::int n from ledger.audit_event where project_id = $1 and type = $2',
        [projectId, 'plan_proposed'],
      );
      assert.equal(proposedEvs.rows[0].n, 1, 'the phantom plan_proposed rolled back with the txn');
    });

    test('duplicate idempotency_key is a 23505 on plan_import for the given constraint', async () => {
      const { projectId, gc } = await planHarness();
      const key = `raw-${randomUUID()}`;
      await pool.query(
        `insert into schedule.plan_import
           (id, project_id, filename, sheet_name, column_mapping, row_count,
            idempotency_key, imported_by_party_id, imported_at, audit_event_id)
         values ($1,$2,'p.xlsx','Plan','{"action":1}'::jsonb,1,$3,$4,now(),$5)`,
        [randomUUID(), projectId, key, gc, randomUUID()],
      );
      await assert.rejects(
        () => pool.query(
          `insert into schedule.plan_import
             (id, project_id, filename, sheet_name, column_mapping, row_count,
              idempotency_key, imported_by_party_id, imported_at, audit_event_id)
           values ($1,$2,'p.xlsx','Plan','{"action":1}'::jsonb,1,$3,$4,now(),$5)`,
          [randomUUID(), projectId, key, gc, randomUUID()],
        ),
        (err) => err.code === '23505' && err.constraint === 'plan_import_idempotency_key_key',
      );
    });
  });

  // ── plan-version authoring + the dependency freeze guard (LINA-233, real DB) ─
  // The migration-0007 deliverable proven in the DATABASE, not just the
  // in-memory mirror: a draft's dependency graph is written + REPLACED through
  // the real FK/trigger path, the new DELETE grant lands, and a frozen version's
  // dependency rows are refused by stage_dependency_freeze_delete_guard (the same
  // terminal set as the stage guard from 0005). Nested inside the suite whose
  // `before` opens the shared pool — the outer `after` ends it LAST.
  describe('plan-version authoring + dependency freeze guard (LINA-233)', () => {
  function seedVersionProject() {
    const projectId = randomUUID();
    const homeowner = randomUUID();
    const gc = randomUUID();
    const identity = identityFor(new Map([[homeowner, 'owner'], [gc, 'counterparty']]));
    return { projectId, homeowner, gc, identity };
  }

  test('authorPlan writes real stage_dependency rows; re-save REPLACES them atomically; getPlan resolves ids', async () => {
    const { projectId, homeowner, gc, identity } = seedVersionProject();
    const svc = createPlanVersionService({ store, ledger, identity });

    const genesis = await ledger.appendEvent({
      projectId, type: 'project_created', actorPartyId: homeowner,
      occurredAt: '2026-09-05T09:00:00.000Z',
      payload: { name: 'Real DB build', baselineBudgetCents: 5_000_000, ownerPartyId: homeowner },
    });
    assert.ok(genesis.seq >= 1);

    const draft = await svc.authorPlan(projectId, gc, {
      stages: [
        { name: 'Foundation', key: 'f' },
        { name: 'Framing', key: 'fr', dependsOn: ['f'] },
      ],
    });
    let deps = await store.listStageDependenciesByPlanVersion(draft.planVersionId);
    assert.equal(deps.length, 1, 'the single dependsOn edge lands in schedule.stage_dependency');

    const view = await svc.getPlan(projectId, gc);
    const [foundation, framing] = view.current.stages;
    assert.deepEqual(framing.dependsOn, [foundation.id], 'getPlan resolves the predecessor to a real stage id');

    // Re-save replaces the whole tree + graph in place — the FK on the old draft
    // rows would FAIL the stage DELETE if the dependency delete did not run first.
    await svc.authorPlan(projectId, gc, {
      stages: [
        { name: 'Excavate', key: 'ex' },
        { name: 'Haul', key: 'haul', dependsOn: ['ex'] },
        { name: 'Backfill', key: 'back', dependsOn: ['ex'] },
      ],
    });
    deps = await store.listStageDependenciesByPlanVersion(draft.planVersionId);
    assert.equal(deps.length, 2, 'EXACTLY the new edges survive; the old ones are gone');
    const stagesNow = await store.listStagesByPlanVersion(draft.planVersionId);
    assert.equal(stagesNow.length, 3, 'the stage tree was fully replaced too');
  });

  test('authorPlan persists dep_type — typed edges keep their type, bare strings default to starts_after (LINA-252)', async () => {
    const { projectId, homeowner, gc, identity } = seedVersionProject();
    await ledger.appendEvent({
      projectId, type: 'project_created', actorPartyId: homeowner,
      occurredAt: '2026-09-05T09:00:00.000Z',
      payload: { name: 'Typed deps build', baselineBudgetCents: 5_000_000, ownerPartyId: homeowner },
    });
    const svc = createPlanVersionService({ store, ledger, identity });

    const draft = await svc.authorPlan(projectId, gc, {
      stages: [
        { name: 'Foundation', key: 'f' },
        { name: 'Framing', key: 'fr', dependsOn: ['f'] },
        { name: 'MEP', key: 'mep', dependsOn: [
          { key: 'f', type: 'starts_with' },
          { key: 'fr', type: 'ends_with' },
        ] },
      ],
    });

    const deps = await store.listStageDependenciesByPlanVersion(draft.planVersionId);
    assert.equal(deps.length, 3);
    const countByType = (t) => deps.filter((d) => d.dep_type === t).length;
    assert.equal(countByType('starts_after'), 1, 'the bare-string edge lands as starts_after (column default)');
    assert.equal(countByType('starts_with'), 1, 'the starts_with edge persists its type');
    assert.equal(countByType('ends_with'), 1, 'the ends_with edge persists its type');

    // The read side round-trips the types to the FE (dual-emit with legacy ids).
    const view = await svc.getPlan(projectId, gc);
    const [, framing, mep] = view.current.stages;
    assert.deepEqual(framing.dependencies, [{ on: framing.dependsOn[0], type: 'starts_after' }]);
    assert.equal(mep.dependencies.length, 2);
    assert.deepEqual(
      mep.dependencies.map((d) => d.type).sort(),
      ['ends_with', 'starts_with'],
    );
    assert.ok(mep.dependencies.every((d) => typeof d.on === 'string' && d.on),
      'dependencies carry resolved stage ids');
    assert.ok(mep.dependencies.every((d) => ['starts_after', 'starts_with', 'ends_with'].includes(d.type)),
      'every typed dependency lands in the ADR-0020 vocabulary');
  });

  test('the dep_type CHECK column: unknown types are refused at the DB, migration 0010 (LINA-252)', async () => {
    // A raw UPDATE flipping an existing row's dep_type outside the CHECK set must
    // be rejected by the DB itself — the belt-and-braces under the
    // application-level 400 invalid_dependency_type.
    const { projectId, homeowner, gc, identity } = seedVersionProject();
    await ledger.appendEvent({
      projectId, type: 'project_created', actorPartyId: homeowner,
      occurredAt: '2026-09-05T09:00:00.000Z',
      payload: { name: 'Typed CHECK build', baselineBudgetCents: 5_000_000, ownerPartyId: homeowner },
    });
    const svc = createPlanVersionService({ store, ledger, identity });
    const draft = await svc.authorPlan(projectId, gc, {
      stages: [
        { name: 'A', key: 'a' },
        { name: 'B', key: 'b', dependsOn: ['a'] },
      ],
    });
    await assert.rejects(
      () => pool.query(
        `update schedule.stage_dependency
            set dep_type = 'finish_to_start'
          where stage_id in (select id from schedule.stage where plan_version_id = $1)`,
        [draft.planVersionId],
      ),
      (e) => e.code === '23514',
      'the DB rejects an unknown dep_type (check_violation)',
    );
    // And the vocabulary CHECK is present in the catalog.
    const check = await pool.query(
      `select 1 from pg_constraint
        where conrelid = 'schedule.stage_dependency'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) ilike '%starts_after%ends_with%'`,
    );
    assert.equal(check.rows.length, 1, 'dep_type CHECK constraint is installed');
  });

  test('the dependency freeze guard: a frozen version\u2019s rows are refused — as schedule_app\u2019s DELETE grant, in the DB', async () => {
    const { projectId, homeowner, gc, identity } = seedVersionProject();
    await ledger.appendEvent({
      projectId, type: 'project_created', actorPartyId: homeowner,
      occurredAt: '2026-09-05T09:00:00.000Z',
      payload: { name: 'Frozen build', baselineBudgetCents: 5_000_000, ownerPartyId: homeowner },
    });
    const svc = createPlanVersionService({ store, ledger, identity });

    const draft = await svc.authorPlan(projectId, gc, {
      stages: [
        { name: 'Foundation', key: 'f' },
        { name: 'Framing', key: 'fr', dependsOn: ['f'] },
      ],
    });
    assert.equal((await store.listStageDependenciesByPlanVersion(draft.planVersionId)).length, 1);

    // The migration-0007 DELETE grant for the app role — proven in the catalog.
    const grant = await pool.query(
      `select has_table_privilege('schedule_app', 'schedule.stage_dependency', 'DELETE') as can_delete`,
    );
    assert.equal(grant.rows[0].can_delete, true, 'GRANT DELETE landed for schedule_app');

    // The trigger is installed (named exactly stage_dependency_freeze_delete_guard).
    const trig = await pool.query(
      `select 1 from pg_trigger
        where tgname = 'stage_dependency_freeze_delete_guard'
          and tgrelid = 'schedule.stage_dependency'::regclass`,
    );
    assert.equal(trig.rows.length, 1);

    // Freeze: mimic the propose + second accept stamp directly (the reviewer path
    // is identity-run-specific; the DB guard keys off status, which is the point).
    // plan_version_draft_has_no_number demands a number once it leaves draft status.
    await pool.query(
      `update schedule.plan_version
          set status = 'accepted', version_no = coalesce(version_no, 1), frozen_at = now()
        where id = $1`, [draft.planVersionId]);

    // Direct deletes (both the pg-store helper and a raw SQL DELETE, exactly what
    // the grant allows schedule_app to issue) are refused by the trigger.
    await assert.rejects(
      () => store.deleteStageDependenciesByPlanVersion(pool, draft.planVersionId),
      (e) => e.code === 'P0001' && /frozen\/terminal plan version/.test(e.message),
    );
    await assert.rejects(
      () => pool.query('delete from schedule.stage_dependency'
        + ' where stage_id = (select id from schedule.stage'
        + ' where name = \'Framing\' and plan_version_id = $1)',
      [draft.planVersionId]),
      (e) => e.code === 'P0001' && /frozen\/terminal plan version/.test(e.message),
    );

    // The row survives — a baseline is changed, never deleted.
    assert.equal((await store.listStageDependenciesByPlanVersion(draft.planVersionId)).length, 1);
    // And the orphaned stages cannot be deleted either (the stage guard, 0005).
    await assert.rejects(
      () => store.deleteStagesByPlanVersion(pool, draft.planVersionId),
      (e) => e.code === 'P0001',
    );
  });

  test('a DRAFT\u2019s dependency rows still delete freely (the relaxed path is exactly 0005-style)', async () => {
    const { projectId, homeowner, gc, identity } = seedVersionProject();
    await ledger.appendEvent({
      projectId, type: 'project_created', actorPartyId: homeowner,
      occurredAt: '2026-09-05T09:00:00.000Z',
      payload: { name: 'Open draft build', baselineBudgetCents: 5_000_000, ownerPartyId: homeowner },
    });
    const svc = createPlanVersionService({ store, ledger, identity });
    const draft = await svc.authorPlan(projectId, gc, {
      stages: [
        { name: 'A', key: 'a' },
        { name: 'B', key: 'b', dependsOn: ['a'] },
      ],
    });
    assert.equal((await store.listStageDependenciesByPlanVersion(draft.planVersionId)).length, 1);

    // Status is still 'draft' → the dependency (and, in turn, the stages) go away.
    const v = await store.getPlanVersion(draft.planVersionId);
    assert.equal(v.status, 'draft');
    await store.deleteStageDependenciesByPlanVersion(pool, draft.planVersionId);
    await store.deleteStagesByPlanVersion(pool, draft.planVersionId);
    assert.equal((await store.listStageDependenciesByPlanVersion(draft.planVersionId)).length, 0);
    assert.equal((await store.listStagesByPlanVersion(draft.planVersionId)).length, 0);
  });
  });

  // ── Project phases + execution sign-off (LINA-278, ADR-0023) ────────────────
  // Prove the phase lifecycle holds in the DATABASE: idempotent seeding, the
  // one-pending partial index, in-place resolution, and the one-way signed_off
  // trigger that no service bug can walk back.
  describe('project phases + execution sign-off (LINA-278, ADR-0023)', () => {
    async function seedPhase({ hasSignedContractor }) {
      const { svc, projectId, gc, homeowner } = await seed();
      // A plan task so a sign-off request is valid (≥1 task rule).
      await svc.addStage(projectId, gc, { name: 'Foundation', position: 1 });
      const identity = identityFor(new Map([[homeowner, 'owner'], [gc, 'counterparty']]));
      const phases = createPhaseService({ store, identity });
      await phases.ensurePhases(projectId, { hasSignedContractor });
      return { phases, projectId, gc, homeowner };
    }

    test('ensurePhases seeds two phases in the DB and is idempotent', async () => {
      const { phases, projectId } = await seedPhase({ hasSignedContractor: false });
      await phases.ensurePhases(projectId, { hasSignedContractor: true }); // must not re-seed
      const rows = await store.listPhasesByProject(projectId);
      assert.deepEqual(rows.map((p) => [p.kind, p.sequence, p.status]), [
        ['procurement', 0, 'active'],
        ['execution', 1, 'pending'],
      ]);
    });

    test('sign-off request → approve flips execution to signed_off (one-way in the DB)', async () => {
      const { phases, projectId, gc, homeowner } = await seedPhase({ hasSignedContractor: true });
      const execution = (await store.listPhasesByProject(projectId)).find((p) => p.kind === 'execution');
      assert.equal(execution.status, 'active');

      const { signOffRequest } = await phases.requestSignOff(projectId, execution.id, gc);
      const out = await phases.approveSignOff(projectId, execution.id, signOffRequest.id, homeowner, { comment: 'ok' });
      assert.equal(out.phase.status, 'signed_off');
      assert.equal(out.signOffRequest.status, 'approved');
      assert.ok(out.signOffRequest.resolvedAt);

      // The DB trigger refuses to reopen a signed_off phase.
      await assert.rejects(
        () => store.updatePhaseStatus(pool, execution.id, 'active'),
        (e) => e.code === 'P0001');
    });

    test('only one pending sign-off request per phase (partial unique index → 409)', async () => {
      const { phases, projectId, gc } = await seedPhase({ hasSignedContractor: true });
      const execution = (await store.listPhasesByProject(projectId)).find((p) => p.kind === 'execution');
      await phases.requestSignOff(projectId, execution.id, gc);
      await assert.rejects(
        () => phases.requestSignOff(projectId, execution.id, gc),
        (e) => e.status === 409 && e.code === 'sign_off_already_pending');
    });

    // plan_change_log (LINA-297): the ::jsonb serialisation must round-trip a
    // number, a string, and a genuine NULL (not the string "null") in the DB, and
    // the ordering/phase filter must hold. Proves the pg adapter agrees with the
    // in-memory reference the service tests run against.
    test('plan_change_log round-trips jsonb old/new values and filters by phase', async () => {
      const { projectId, gc } = await seedPhase({ hasSignedContractor: true });
      const execution = (await store.listPhasesByProject(projectId)).find((p) => p.kind === 'execution');
      const stageId = randomUUID();

      await store.insertPlanChangeLog(pool, {
        id: randomUUID(), phase_id: execution.id, entity_type: 'stage', entity_id: stageId,
        field_name: 'planned_cost_cents', old_value: null, new_value: 1_000_000,
        actor_party_id: gc, occurred_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      });
      await store.insertPlanChangeLog(pool, {
        id: randomUUID(), phase_id: execution.id, entity_type: 'stage', entity_id: stageId,
        field_name: 'name', old_value: 'Foundation', new_value: 'Foundation & Footings',
        actor_party_id: null, occurred_at: new Date('2026-01-02T00:00:00Z').toISOString(),
      });

      const rows = await store.listPlanChangeLogByPhase(execution.id);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.field_name), ['planned_cost_cents', 'name']); // occurred_at order
      const [cost, name] = rows;
      assert.strictEqual(cost.old_value, null);
      assert.strictEqual(cost.new_value, 1_000_000); // jsonb number → JS number
      assert.equal(cost.actor_party_id, gc);
      assert.strictEqual(name.old_value, 'Foundation'); // jsonb string → JS string
      assert.strictEqual(name.new_value, 'Foundation & Footings');
      assert.strictEqual(name.actor_party_id, null); // system change
    });
  });
});
