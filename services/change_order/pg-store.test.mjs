// Integration tests for the Change Order Postgres store + REAL ledger wiring
// (LINA-51 / design §4.2, §6, §9; ADR-0006 §1; FR3–FR8).
//
// These run against a real Postgres (a throwaway Neon branch) — set DATABASE_URL
// to the migrator/owner connection string. Without it the suite skips, so CI on a
// machine with no DB stays green while the DB job runs the real thing (same
// convention as services/ledger/pg-ledger.test.mjs).
//
// What they prove, beyond the in-memory contract tests, is that the invariants
// hold in the DATABASE and across the change_order↔ledger schema seam:
//   * propose writes the projection AND the change_order_proposed audit event in
//     one commit; proposing never moves the budget;
//   * an approval by a non-proposer moves the budget exactly once and the
//     one-screen view reports before→after correctly (FR5, FR6);
//   * two concurrent identical decides (a serverless double-invoke with the same
//     idempotencyKey) settle to ONE budget move — exactly-once via the real
//     UNIQUE(change_order_id) and the atomic conditional UPDATE (FR5);
//   * a budget_event that already exists for the CO is absorbed as an idempotent
//     no-op through the REAL pg LedgerBudgetConflict, not a double-apply;
//   * the two-sided rule is enforced by the DB CHECK (decided_by <> proposed_by)
//     even if the service guard is bypassed (FR4);
//   * listByProject is chronological by (created_at, seq) (FR7).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { createPgLedger } from '../ledger/pg-ledger.mjs';
import { createPgStore } from './pg-store.mjs';
import { createChangeOrderService } from './change-order.mjs';
import { DomainError } from './ports.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const ledgerDir = join(here, '..', 'ledger');
const DB = process.env.DATABASE_URL;
const ssl = { rejectUnauthorized: false };

describe('Postgres Change Order store + ledger wiring', { skip: DB ? false : 'set DATABASE_URL to run' }, () => {
  let pool;
  let ledger;
  let store;

  // A permissive Identity port for the store/ledger integration: it authorizes a
  // fixed member set so these tests focus on the DB-level invariants. The full
  // two-sided/authorization logic is covered by change-order.test.mjs and
  // http.test.mjs; here we only need "is this party a member".
  function identityFor(members) {
    return {
      requireMember(partyId, projectId) {
        if (!partyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
        if (!members.has(partyId)) throw new DomainError(403, 'not_a_member', 'not a member of this project');
        return { partyId, projectId, role: members.get(partyId) };
      },
    };
  }

  before(async () => {
    pool = new Pool({ connectionString: DB, ssl, max: 4 });
    // The `ledger` and `change_order` schemas are expected to already be migrated
    // on the target branch (run db/migrate.mjs first, or point at a branch forked
    // from an already-migrated parent). If the base tables are absent, apply the
    // two base migrations; if they already exist, that raises a duplicate-object
    // error we can safely ignore. Every test isolates itself with fresh random
    // UUIDs, so pre-existing data never interferes.
    const haveTable = await pool.query(
      "select to_regclass('change_order.change_order') as t, to_regclass('ledger.audit_event') as l",
    );
    if (!haveTable.rows[0].t || !haveTable.rows[0].l) {
      for (const f of [join(ledgerDir, 'migrations', '0001_ledger.sql'),
        join(here, 'migrations', '0001_change_order.sql')]) {
        try { await pool.query(await readFile(f, 'utf8')); }
        catch (err) { if (err.code !== '42P07' && err.code !== '42P06') throw err; }
      }
    }
    ledger = createPgLedger({ pool });
    store = createPgStore({ pool });
  });

  after(async () => {
    if (pool) await pool.end();
  });

  // Seed a fresh project (unique UUIDs so reruns against one branch never collide)
  // with a project_created genesis carrying the baseline the ledger derives budget
  // from. Returns the wired service + ids.
  async function seed({ baselineBudgetCents = 5_000_000 } = {}) {
    const projectId = randomUUID();
    const homeowner = randomUUID();
    const gc = randomUUID();
    await ledger.appendEvent({
      projectId, type: 'project_created', actorPartyId: homeowner,
      occurredAt: '2026-08-26T09:00:00.000Z',
      payload: { name: 'Maple St build', baselineBudgetCents, ownerPartyId: homeowner },
    });
    const identity = identityFor(new Map([[homeowner, 'owner'], [gc, 'counterparty']]));
    const svc = createChangeOrderService({ store, ledger, identity });
    return { svc, projectId, homeowner, gc, baselineBudgetCents };
  }

  const proposeInput = (overrides = {}) => ({
    title: 'Upgrade to oak flooring',
    costDeltaCents: 120_000,
    scopeImpactNote: 'Replace laminate with white oak',
    scheduleImpactDays: 5,
    scheduleImpactNote: 'Adds a week',
    qualityFlag: true,
    qualityNote: 'Higher durability',
    ...overrides,
  });

  test('propose persists the projection + a change_order_proposed event, no budget move', async () => {
    const { svc, projectId, gc, baselineBudgetCents } = await seed();
    const co = await svc.propose(projectId, gc, proposeInput());

    assert.equal(co.status, 'proposed');
    assert.equal(co.proposedBy, gc);
    assert.equal(co.scheduleImpactDays, 5);
    assert.equal(co.budget.currentCents, baselineBudgetCents);
    assert.equal(co.budget.movedCents, 0);
    assert.equal(co.budget.projectedIfApprovedCents, baselineBudgetCents + 120_000);

    // The row is really in change_order, and the event in the ledger chain.
    const { rows } = await pool.query(
      'select status, cost_delta_cents from change_order.change_order where id = $1', [co.id],
    );
    assert.equal(rows[0].status, 'proposed');
    const chain = await ledger._chain(projectId);
    assert.deepEqual(chain.map((e) => e.type), ['project_created', 'change_order_proposed']);
    // No budget_event yet.
    const be = await pool.query('select count(*)::int n from ledger.budget_event where change_order_id = $1', [co.id]);
    assert.equal(be.rows[0].n, 0);
  });

  test('approval by a non-proposer moves the budget exactly once; one-screen before→after correct', async () => {
    const { svc, projectId, homeowner, gc, baselineBudgetCents } = await seed();
    const co = await svc.propose(projectId, gc, proposeInput({ costDeltaCents: 120_000 }));
    const decided = await svc.decide(co.id, homeowner, { decision: 'approve' });

    assert.equal(decided.status, 'approved');
    assert.equal(decided.decidedBy, homeowner);
    assert.equal(decided.budget.beforeCents, baselineBudgetCents);
    assert.equal(decided.budget.afterCents, baselineBudgetCents + 120_000);
    assert.equal(decided.budget.movedCents, 120_000);
    assert.equal(decided.budget.projectedIfApprovedCents, null);

    const be = await pool.query('select count(*)::int n from ledger.budget_event where change_order_id = $1', [co.id]);
    assert.equal(be.rows[0].n, 1);
    // The audit event + budget_moved event are both on the chain (append + move
    // committed together).
    const chain = await ledger._chain(projectId);
    assert.ok(chain.some((e) => e.type === 'change_order_approved'));
    assert.ok(chain.some((e) => e.type === 'budget_moved'));
  });

  test('two concurrent identical decides (serverless retry) move the budget exactly once', async () => {
    const { svc, projectId, homeowner, gc, baselineBudgetCents } = await seed();
    const co = await svc.propose(projectId, gc, proposeInput({ costDeltaCents: 200_000 }));

    // Fire the SAME decision twice at once with one idempotencyKey — the real
    // double-invoke. One wins the atomic conditional UPDATE; the other re-reads and
    // replays. UNIQUE(change_order_id) guarantees a single budget move either way.
    const key = 'retry-' + randomUUID();
    const [a, b] = await Promise.allSettled([
      svc.decide(co.id, homeowner, { decision: 'approve', idempotencyKey: key }),
      svc.decide(co.id, homeowner, { decision: 'approve', idempotencyKey: key }),
    ]);
    // Both should ultimately resolve to the approved view (loser replays), but even
    // if one raced to a 409 the invariant below is what matters.
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    assert.ok(ok.length >= 1, 'at least one decide resolves');
    for (const r of ok) assert.equal(r.value.status, 'approved');

    const be = await pool.query('select count(*)::int n from ledger.budget_event where change_order_id = $1', [co.id]);
    assert.equal(be.rows[0].n, 1, 'exactly one budget_event after the retry');
    const budget = await ledger.currentBudget(projectId);
    assert.equal(budget.currentCents, baselineBudgetCents + 200_000, 'budget moved once, not twice');
  });

  test('a pre-existing budget_event is absorbed as an idempotent no-op via the real LedgerBudgetConflict', async () => {
    const { svc, projectId, homeowner, gc, baselineBudgetCents } = await seed();
    const co = await svc.propose(projectId, gc, proposeInput({ costDeltaCents: 90_000 }));

    // Simulate "the transaction was replayed after the budget move already
    // committed": the budget_event for this CO already exists.
    await ledger.recordBudgetEvent(pool, {
      projectId, changeOrderId: co.id, deltaCents: 90_000,
      actorPartyId: homeowner, occurredAt: '2026-08-26T10:00:00.000Z',
    });

    const decided = await svc.decide(co.id, homeowner, { decision: 'approve' });
    assert.equal(decided.status, 'approved');
    // Still exactly one budget_event — the duplicate move was absorbed, not applied.
    const be = await pool.query('select count(*)::int n from ledger.budget_event where change_order_id = $1', [co.id]);
    assert.equal(be.rows[0].n, 1);
    const budget = await ledger.currentBudget(projectId);
    assert.equal(budget.currentCents, baselineBudgetCents + 90_000);
  });

  test('the two-sided rule is enforced by the DB CHECK even if the service is bypassed (FR4)', async () => {
    const { svc, projectId, gc } = await seed();
    const co = await svc.propose(projectId, gc, proposeInput());
    // Forge a decision where the proposer decides their own CO, straight at the DB.
    await assert.rejects(
      pool.query(
        `update change_order.change_order
            set status = 'approved', decided_by_party_id = proposed_by_party_id, decided_at = now()
          where id = $1`,
        [co.id],
      ),
      (err) => err.code === '23514' && String(err.constraint).includes('decided_by_is_not_proposer'),
    );
  });

  test('reusing an idempotency key on a DIFFERENT change order hits the DB UNIQUE (409)', async () => {
    const { svc, projectId, homeowner, gc } = await seed();
    const a = await svc.propose(projectId, gc, proposeInput({ title: 'A' }));
    const b = await svc.propose(projectId, gc, proposeInput({ title: 'B' }));
    const key = 'shared-' + randomUUID();
    await svc.decide(a.id, homeowner, { decision: 'approve', idempotencyKey: key });
    await assert.rejects(
      () => svc.decide(b.id, homeowner, { decision: 'approve', idempotencyKey: key }),
      (e) => e instanceof DomainError && e.status === 409 && e.code === 'idempotency_key_reused',
    );
  });

  test('listByProject is chronological by (created_at, seq) (FR7)', async () => {
    const { svc, projectId, gc } = await seed();
    const first = await svc.propose(projectId, gc, proposeInput({ title: 'First' }));
    const second = await svc.propose(projectId, gc, proposeInput({ title: 'Second' }));
    const third = await svc.propose(projectId, gc, proposeInput({ title: 'Third' }));
    const list = await svc.list(projectId, gc);
    assert.deepEqual(list.map((c) => c.title), ['First', 'Second', 'Third']);
    assert.deepEqual(list.map((c) => c.id), [first.id, second.id, third.id]);
  });

  // ── Grant-matrix regression guard (Architect, LINA-51 review) ───────────────
  // 0004 opens a budget seam for change_order_app. These assert the seam stays a
  // seam. They read the privilege catalog rather than attempting the writes,
  // because app roles are NOLOGIN/passwordless by design (db/roles.sql) — so this
  // guard runs anywhere DATABASE_URL points, with no role bootstrapping.
  //
  // The property: change_order_app may write a budget_event ONCE and link it to
  // its audit event, and may never afterwards change what that row says. If a
  // future migration widens this to a table-wide UPDATE, the budget becomes
  // mutable with no audit event behind it — the one thing this ledger exists to
  // prevent — and this test fails.
  test('change_order_app UPDATE on ledger.budget_event is column-scoped to the back-link', async () => {
    const { rows } = await pool.query(
      `select column_name from information_schema.column_privileges
        where grantee = 'change_order_app' and table_schema = 'ledger'
          and table_name = 'budget_event' and privilege_type = 'UPDATE'
        order by column_name`,
    );
    assert.deepEqual(rows.map((r) => r.column_name), ['audit_event_id'],
      'change_order_app must be able to update ONLY audit_event_id — never delta_cents/project_id/change_order_id');
  });

  test('change_order_app holds no DELETE on budget_event and no write at all on audit_event', async () => {
    const { rows } = await pool.query(
      `select table_name, privilege_type from information_schema.table_privileges
        where grantee = 'change_order_app' and table_schema = 'ledger'
          and table_name in ('budget_event', 'audit_event')
        order by table_name, privilege_type`,
    );
    const granted = (t) => rows.filter((r) => r.table_name === t).map((r) => r.privilege_type);
    // budget_event: insert + read only. UPDATE is column-level, so it correctly
    // does NOT appear in table_privileges.
    assert.deepEqual(granted('budget_event').sort(), ['INSERT', 'SELECT']);
    // audit_event stays write-locked: the only writer is ledger.append_event.
    assert.deepEqual(
      granted('audit_event').filter((p) => p !== 'SELECT'), [],
      'audit_event must remain append-only via ledger.append_event (ADR-0002 §4)',
    );
  });

  // The grant matrix is only meaningful if the role cannot inherit its way past
  // it (see the neon_superuser finding on LINA-35).
  test('change_order_app inherits no superuser role', async () => {
    const { rows } = await pool.query(
      `select r.rolname from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
        where m.member = 'change_order_app'::regrole
          and r.rolname in ('neon_superuser', 'postgres', 'cloud_admin')`,
    );
    assert.deepEqual(rows.map((r) => r.rolname), [],
      'a superuser-inheriting app role bypasses every GRANT above');
  });
});
