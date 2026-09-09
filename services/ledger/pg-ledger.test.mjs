// Adversarial + integration tests for the Postgres ledger (design §9).
//
// These run against a real Postgres (a throwaway Neon branch) — set DATABASE_URL
// to the migrator/owner connection string. Without it the suite skips, so CI on a
// machine with no DB stays green while the DB job runs the real thing.
//
// What they prove, beyond the pure-core tests:
//   * append + verify round-trip THROUGH Postgres (incl. the occurred_at
//     timestamptz round-trip that would otherwise cause verify false-positives);
//   * DB-level tampering that bypasses append-only — UPDATE/DELETE/forge/reorder
//     done as the table owner — is detected by verifyChain at the EXACT seq;
//   * budget math (baseline + Σ approved; double-approve is an idempotent no-op);
//   * four-pillar status derivation;
//   * audit ETag = head entry_hash and its 304 short-circuit;
//   * the write-guard: an app role holds no INSERT on audit_event and can only
//     append through the SECURITY DEFINER function (ADR-0002 §4).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPgLedger, LedgerBudgetConflict } from './pg-ledger.mjs';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const DB = process.env.DATABASE_URL;
// Neon (and any hosted PG) requires TLS; a local Postgres — the CI service
// container or a docker throwaway — speaks no SSL and drops the connection if we
// insist on it. Enable TLS unless the target is plainly local / opted out, so the
// same suite runs green both against a throwaway Neon branch and in CI.
const localDb = !DB || /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DB) || /[?&]sslmode=disable/.test(DB);
const ssl = localDb ? false : { rejectUnauthorized: false };

describe('Postgres ledger (trust anchor)', { skip: DB ? false : 'set DATABASE_URL to run' }, () => {
  let pool;
  let ledger;
  const APP_ROLE = 'ledger_app_test';
  const APP_PW = 'slice1-dev-only-pw';
  let appRoleReady = false;

  before(async () => {
    pool = new Pool({ connectionString: DB, ssl, max: 4 });

    // Apply the ledger schema migration (owner/migrator connection).
    const sql = await readFile(join(here, 'migrations', '0001_ledger.sql'), 'utf8');
    await pool.query(sql);

    // Self-contained least-privilege app role for the write-guard test: exactly
    // the sanctioned grants (ADR-0002 §4) and nothing that can write audit_event.
    try {
      await pool.query(`
        do $$
        begin
          if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
            create role ${APP_ROLE} login password '${APP_PW}';
          else
            alter role ${APP_ROLE} login password '${APP_PW}';
          end if;
        end $$;`);
      await pool.query(`grant usage on schema ledger to ${APP_ROLE}`);
      await pool.query(`grant select on ledger.audit_event to ${APP_ROLE}`);
      await pool.query(`grant select, insert, update on ledger.budget_event to ${APP_ROLE}`);
      await pool.query(
        `grant execute on function ledger.append_event(uuid,text,uuid,timestamptz,jsonb,text) to ${APP_ROLE}`,
      );
      await pool.query(
        `revoke insert, update, delete, truncate on ledger.audit_event from ${APP_ROLE}`,
      );
      appRoleReady = true;
    } catch (err) {
      // Some managed environments restrict CREATE ROLE; the guard test then skips.
      appRoleReady = false;
      console.error('write-guard role setup skipped:', err.message);
    }

    ledger = createPgLedger({ pool });
  });

  after(async () => {
    if (pool) await pool.end();
  });

  // Append a fresh project's chain: project_created + n decisions. Returns projectId.
  async function seedProject({ baselineBudgetCents = 1_000_000 } = {}) {
    const projectId = randomUUID();
    const owner = randomUUID();
    await ledger.appendEvent({
      projectId, type: 'project_created', actorPartyId: owner,
      occurredAt: '2026-08-26T09:00:00.000Z',
      payload: { name: 'Maple St build', baselineBudgetCents },
    });
    await ledger.appendEvent({
      projectId, type: 'decision_recorded', actorPartyId: owner,
      occurredAt: '2026-08-26T09:05:00.500Z',
      payload: { decisionId: randomUUID(), title: 'Slab spec', body: '30MPa' },
    });
    await ledger.appendEvent({
      projectId, type: 'decision_revised', actorPartyId: owner,
      occurredAt: '2026-08-26T09:10:00.999Z',
      payload: { decisionId: randomUUID(), rev: 2, title: 'Slab spec', body: '32MPa' },
    });
    return { projectId, owner };
  }

  test('append + verify round-trips through Postgres (timestamptz included)', async () => {
    const { projectId } = await seedProject();
    const chain = await ledger._chain(projectId);
    assert.equal(chain.length, 3);
    assert.deepEqual(chain.map((e) => e.seq), [1, 2, 3]);
    // The whole point: verify recomputes payload/entry hashes from the round-tripped
    // rows. If occurred_at or the entry-link hash drifted, this would be false.
    assert.deepEqual(await ledger.verify(projectId), { verified: true });
    // Genesis anchoring: seq 1 prev_hash is the fixed constant.
    assert.equal(chain[0].prevHash, ledger.GENESIS_HASH);
  });

  test('DB-level payload tamper is caught at the exact seq', async () => {
    const { projectId } = await seedProject();
    // Simulate an attacker who bypassed the app role and edited the row directly.
    await pool.query(
      `update ledger.audit_event set payload = '{"body":"forged"}'::jsonb
        where project_id = $1 and seq = 2`,
      [projectId],
    );
    const v = await ledger.verify(projectId);
    assert.equal(v.verified, false);
    assert.equal(v.firstBrokenSeq, 2);
  });

  test('deleting a middle event is caught (seq gap)', async () => {
    const { projectId } = await seedProject();
    await pool.query(`delete from ledger.audit_event where project_id = $1 and seq = 2`, [projectId]);
    const v = await ledger.verify(projectId);
    assert.equal(v.verified, false);
    assert.equal(v.firstBrokenSeq, 3); // seq 3 now sits where seq 2 was expected
  });

  test('a forged entry_hash is caught at that seq', async () => {
    const { projectId } = await seedProject();
    await pool.query(
      `update ledger.audit_event set entry_hash = repeat('a', 64) where project_id = $1 and seq = 2`,
      [projectId],
    );
    const v = await ledger.verify(projectId);
    assert.equal(v.verified, false);
    assert.equal(v.firstBrokenSeq, 2);
  });

  test('tampering the genesis event is caught at seq 1', async () => {
    const { projectId } = await seedProject();
    await pool.query(
      `update ledger.audit_event set actor_party_id = gen_random_uuid()
        where project_id = $1 and seq = 1`,
      [projectId],
    );
    const v = await ledger.verify(projectId);
    assert.equal(v.verified, false);
    assert.equal(v.firstBrokenSeq, 1);
  });

  test('reordering two events breaks the chain', async () => {
    const { projectId } = await seedProject();
    // Swap the seq of events 2 and 3 (content unchanged) — a reorder attack.
    await pool.query('begin');
    try {
      // Positive temp offset (the seq >= 1 CHECK forbids negatives) then swap.
      await pool.query(`update ledger.audit_event set seq = seq + 1000000 where project_id = $1 and seq in (2,3)`, [projectId]);
      await pool.query(`update ledger.audit_event set seq = 2 where project_id = $1 and seq = 1000003`, [projectId]);
      await pool.query(`update ledger.audit_event set seq = 3 where project_id = $1 and seq = 1000002`, [projectId]);
      await pool.query('commit');
    } catch (e) {
      await pool.query('rollback');
      throw e;
    }
    const v = await ledger.verify(projectId);
    assert.equal(v.verified, false);
  });

  test('budget math: baseline + Σ approved, double-approve is a no-op', async () => {
    const { projectId, owner } = await seedProject({ baselineBudgetCents: 1_000_000 });
    const gc = randomUUID();
    const coId = randomUUID();

    let b = await ledger.currentBudget(projectId);
    assert.deepEqual(b, { baselineCents: 1_000_000, approvedTotalCents: 0, currentCents: 1_000_000 });

    // Approve a +250_00 cents change order → one budget_event.
    await ledger.appendEvent({
      projectId, type: 'change_order_approved', actorPartyId: gc,
      occurredAt: '2026-08-26T10:00:00.000Z',
      payload: { changeOrderId: coId, costDeltaCents: 25_000, scheduleImpactDays: 3, qualityFlag: false },
    });
    await import('./db.mjs').then(({ withTransaction }) =>
      withTransaction((c) => ledger.recordBudgetEvent(c, {
        projectId, changeOrderId: coId, deltaCents: 25_000, actorPartyId: gc,
        occurredAt: '2026-08-26T10:00:00.000Z',
      }), pool));

    b = await ledger.currentBudget(projectId);
    assert.equal(b.currentCents, 1_025_000);
    assert.equal(b.approvedTotalCents, 25_000);

    // A replay for the same CO must NOT move the budget again (UNIQUE(change_order_id)).
    await assert.rejects(
      () => import('./db.mjs').then(({ withTransaction }) =>
        withTransaction((c) => ledger.recordBudgetEvent(c, {
          projectId, changeOrderId: coId, deltaCents: 25_000, actorPartyId: gc,
          occurredAt: '2026-08-26T10:05:00.000Z',
        }), pool)),
      (err) => err instanceof LedgerBudgetConflict,
    );
    b = await ledger.currentBudget(projectId);
    assert.equal(b.currentCents, 1_025_000); // unchanged
  });

  test('four-pillar status derivation', async () => {
    const { projectId } = await seedProject({ baselineBudgetCents: 1_000_000 });
    const gc = randomUUID();
    const coApproved = randomUUID();
    const coOpen = randomUUID();

    // An open (proposed) CO carrying a scope note → scope amber.
    await ledger.appendEvent({
      projectId, type: 'change_order_proposed', actorPartyId: gc,
      occurredAt: '2026-08-26T11:00:00.000Z',
      payload: { changeOrderId: coOpen, scopeImpactNote: 'adds a bay window' },
    });
    // An approved CO with +8 schedule days → schedule amber; over budget →
    // budget red.
    await ledger.appendEvent({
      projectId, type: 'change_order_approved', actorPartyId: gc,
      occurredAt: '2026-08-26T11:05:00.000Z',
      payload: { changeOrderId: coApproved, scheduleImpactDays: 8, qualityFlag: true },
    });
    await import('./db.mjs').then(({ withTransaction }) =>
      withTransaction((c) => ledger.recordBudgetEvent(c, {
        projectId, changeOrderId: coApproved, deltaCents: 300_000, actorPartyId: gc,
        occurredAt: '2026-08-26T11:05:00.000Z',
      }), pool));

    const s = await ledger.status(projectId);
    assert.equal(s.budget.status, 'red'); // 30% over 1,000,000 baseline
    assert.equal(s.budget.currentCents, 1_300_000);
    assert.equal(s.schedule.status, 'amber');
    assert.equal(s.schedule.approvedScheduleImpactDays, 8);
    assert.equal(s.scope.status, 'amber');
    assert.equal(s.scope.openScopeNoteCount, 1);
    // Safety is static "not tracked yet" — never green, never derived (ADR-0015 §2).
    assert.equal(s.safety.status, 'none');
    assert.equal(s.safety.tracked, false);
    // Every pillar carries a non-colour signal (FR9).
    for (const pillar of Object.values(s)) {
      assert.ok(pillar.label && pillar.icon, 'pillar must have label + icon, not colour alone');
    }
  });

  // REGRESSION (LINA-57). The test above hand-writes an approval payload carrying
  // scheduleImpactDays — a shape services/change_order never actually emits. Its
  // real approval event is { decidedBy, changeOrderId, costDeltaCents }; the
  // schedule field exists only on the PROPOSAL. Reading it off the approval
  // therefore summed nothing in production, and Schedule was permanently green
  // however much had been approved.
  //
  // This test uses the payloads the service really writes, so it fails against the
  // old fold and passes only when the approval is correlated back to its proposal.
  test('four-pillar status: approved schedule days come from the PROPOSAL payload', async () => {
    const { projectId } = await seedProject({ baselineBudgetCents: 1_000_000 });
    const gc = randomUUID();
    const co = randomUUID();

    // Exactly what change_order emits on propose — the impact fields live here.
    await ledger.appendEvent({
      projectId, type: 'change_order_proposed', actorPartyId: gc,
      occurredAt: '2026-08-26T12:00:00.000Z',
      payload: {
        changeOrderId: co, title: 'Engineered oak flooring', costDeltaCents: 300_000,
        scopeImpactNote: 'oak over laminate', scheduleImpactDays: 5,
        scheduleImpactNote: 'adds a week', qualityFlag: true, qualityNote: 'higher durability',
      },
    });
    // ...and exactly what it emits on approve: a pointer, not a restatement.
    await ledger.appendEvent({
      projectId, type: 'change_order_approved', actorPartyId: randomUUID(),
      occurredAt: '2026-08-26T12:05:00.000Z',
      payload: { decidedBy: randomUUID(), changeOrderId: co, costDeltaCents: 300_000 },
    });

    const s = await ledger.status(projectId);
    assert.equal(s.schedule.approvedScheduleImpactDays, 5, 'approved schedule days must come from the proposal');
    assert.equal(s.schedule.status, 'amber');
    assert.match(s.schedule.label, /~5 days/);
    // Approving closes the scope question — it is decided, no longer open.
    assert.equal(s.scope.openScopeNoteCount, 0);
  });

  test('audit read: ETag = head entry_hash, 304 on no change', async () => {
    const { projectId } = await seedProject();
    const first = await ledger.getAudit(projectId);
    assert.equal(first.status, 200);
    assert.equal(first.events.length, 3);
    assert.deepEqual(first.verify, { verified: true });
    // The ETag is the head entry_hash, quoted.
    assert.equal(first.etag, `"${first.events[2].entryHash}"`);

    // Same ETag back → cheap 304, no body.
    const notModified = await ledger.getAudit(projectId, { ifNoneMatch: first.etag });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.events, undefined);

    // A new append moves the head → ETag changes, cache invalidated.
    await ledger.appendEvent({
      projectId, type: 'decision_recorded', actorPartyId: randomUUID(),
      occurredAt: '2026-08-26T12:00:00.000Z', payload: { decisionId: randomUUID(), title: 'x', body: 'y' },
    });
    const afterAppend = await ledger.getAudit(projectId, { ifNoneMatch: first.etag });
    assert.equal(afterAppend.status, 200);
    assert.notEqual(afterAppend.etag, first.etag);
  });

  test('write-guard: app role cannot write audit_event directly, only via append_event', async () => {
    if (!appRoleReady) {
      console.error('skipped: app role not available in this environment');
      return;
    }
    const appUrl = new URL(DB);
    appUrl.username = APP_ROLE;
    appUrl.password = APP_PW;
    const appPool = new Pool({ connectionString: appUrl.toString(), ssl, max: 2 });
    try {
      const projectId = randomUUID();

      // Direct INSERT into the trust anchor is denied.
      await assert.rejects(
        () => appPool.query(
          `insert into ledger.audit_event
             (project_id, seq, type, occurred_at, payload_hash, prev_hash, entry_hash)
           values ($1, 1, 'forged', now(), repeat('0',64), repeat('0',64), repeat('0',64))`,
          [projectId],
        ),
        /permission denied/i,
      );

      // But the sanctioned path works: append_event runs as the definer.
      const appended = await appPool.query(
        `select seq from ledger.append_event($1, 'project_created', $2, now(), '{"baselineBudgetCents":500}'::jsonb, repeat('b',64))`,
        [projectId, randomUUID()],
      );
      assert.equal(Number(appended.rows[0].seq), 1);

      // UPDATE / DELETE on the anchor are denied too.
      await assert.rejects(
        () => appPool.query(`update ledger.audit_event set type = 'x' where project_id = $1`, [projectId]),
        /permission denied/i,
      );
      await assert.rejects(
        () => appPool.query(`delete from ledger.audit_event where project_id = $1`, [projectId]),
        /permission denied/i,
      );
    } finally {
      await appPool.end();
    }
  });
});
