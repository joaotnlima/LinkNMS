// Billing store over the REAL v2 migrations (throwaway DB, like
// modules/quality). Skipped without DATABASE_URL.
//   DATABASE_URL=postgres://you@localhost:5432/postgres node --test infra/pg-store.test.mjs
//
// Proves at the database level, per AGENT-INDEX §5 phase 8:
//   - the 0006 catalogue is queryable per org kind;
//   - one subscription per org: a live row refuses under lock, a canceled
//     slot is replaced in place (org_id UNIQUE);
//   - every subscription write publishes billing.subscription.changed on the
//     SAME transaction, and NOTHING is ledgered (doc 10: billing has no
//     ledger column);
//   - usage counters read the real cross-schema rows (participation,
//     memberships, open RFPs);
//   - sponsorship coverage resolves through contracting.contract to the
//     project (doc 04 §4);
//   - the entitlements port end to end: reads never gated — a CANCELED
//     subscription still answers allowed for a non-gated key and false for a
//     gated one (the phase-8 invariant);
//   - Idempotency-Key replay answers the stored response (platform 0002).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { createBillingStore } from './pg-store.mjs';
import { createEntitlements } from '../application/entitled.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the billing Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_billing_test';

const GC_ORG = randomUUID(); // subscribes, sponsors
const SUB_ORG = randomUUID(); // no subscription — sponsored on the contract
const LAPSED_ORG = randomUUID(); // canceled subscription
const PERSON = randomUUID();
const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();
const CONTRACT = randomUUID(); // GC → SUB on PROJECT, sponsored by GC
const ACTOR = { personId: PERSON, orgId: GC_ORG, orgRole: 'admin', channel: 'ui' };

describe('billing store over Postgres (v2 migrations)', { skip }, () => {
  let pg, admin, pool, store, entitlements;

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
         ($1, 'org_gc', 'contractor', 'Construções Douro'),
         ($2, 'org_sub', 'contractor', 'Canalizações Norte'),
         ($3, 'org_lapsed', 'contractor', 'Obras Paradas')`,
      [GC_ORG, SUB_ORG, LAPSED_ORG],
    );
    await pool.query(
      `INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_carlos', 'carlos@douro.pt', 'Carlos')`,
      [PERSON],
    );
    await pool.query(
      `INSERT INTO identity.org_membership (org_id, person_id, org_role) VALUES ($1, $2, 'admin')`,
      [GC_ORG, PERSON],
    );
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code, status) VALUES
         ($1, $3, $3, 'Casa Um', '1306', 'in_execution'),
         ($2, $3, $3, 'Casa Dois', '1306', 'closed')`,
      [PROJECT, OTHER_PROJECT, GC_ORG],
    );
    // GC participates in one live and one closed project — usage counts 1.
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id) VALUES
         ($1, $3, 'owner', 'project', NULL),
         ($2, $3, 'owner', 'project', NULL),
         ($1, $4, 'subcontractor', 'contract', $5)`,
      [PROJECT, OTHER_PROJECT, GC_ORG, SUB_ORG, CONTRACT],
    );
    await pool.query(
      `INSERT INTO contracting.contract (id, project_id, kind, parent_contract_id, client_org_id, supplier_org_id, reference, origin, status, sponsored_by_org_id)
       VALUES ($1, $2, 'service', NULL, $3, $4, 'SUB-1', 'direct_entry', 'signed', $3)`,
      [CONTRACT, PROJECT, GC_ORG, SUB_ORG],
    );
    // One open-visibility published RFP this month; a draft one never counts.
    await pool.query(
      `INSERT INTO tendering.rfp (id, project_id, issuer_org_id, level, title, visibility, submission_deadline, status) VALUES
         ($1, $3, $4, 'owner', 'Coberturas', 'open', now() + interval '14 days', 'published'),
         ($2, $3, $4, 'owner', 'Rascunho',   'open', now() + interval '14 days', 'draft')`,
      [randomUUID(), randomUUID(), PROJECT, GC_ORG],
    );
    store = createBillingStore(pool);
    entitlements = createEntitlements(store);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  async function outboxCount() {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM platform.outbox WHERE type = 'billing.subscription.changed'`,
    );
    return rows[0].n;
  }

  test('the 0006 catalogue answers per org kind, keyset-paged on code', async () => {
    const page1 = await store.listPlans({ orgKind: 'contractor', limit: 4 });
    assert.deepEqual(page1.items.map((p) => p.code), ['gc-business', 'gc-pro', 'gc-starter', 'specialty-company']);
    assert.equal(page1.nextCursor, 'specialty-company');
    const page2 = await store.listPlans({ orgKind: 'contractor', cursor: page1.nextCursor, limit: 4 });
    assert.deepEqual(page2.items.map((p) => p.code), ['specialty-crew', 'specialty-solo']);
    assert.equal(page2.nextCursor, null);
    const household = await store.listPlans({ orgKind: 'household', limit: 10 });
    assert.deepEqual(household.items.map((p) => p.code), ['owner-project']);
  });

  test('subscribe: active row + period end + event in ONE transaction, nothing ledgered', async () => {
    const before = await outboxCount();
    const row = await store.subscribe({ id: randomUUID(), orgId: GC_ORG, planCode: 'gc-pro', interval: 'month', actor: ACTOR });
    assert.equal(row.status, 'active');
    assert.equal(row.plan_code, 'gc-pro');
    assert.equal(row.provider_ref, null); // manual mode — open question 17
    assert.ok(new Date(row.current_period_end) > new Date());

    assert.equal(await outboxCount(), before + 1);
    const { rows: [evt] } = await pool.query(
      `SELECT * FROM platform.outbox WHERE type = 'billing.subscription.changed' ORDER BY occurred_at DESC LIMIT 1`,
    );
    assert.deepEqual(evt.scope, { type: 'org_private', id: GC_ORG });
    assert.equal(evt.data.plan_code, 'gc-pro');
    // Billing is platform housekeeping: doc 10 lists NO ledger for it.
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM record.audit_event');
    assert.equal(n, 0);
  });

  test('one subscription per org: a live row refuses under lock', async () => {
    await assert.rejects(
      store.subscribe({ id: randomUUID(), orgId: GC_ORG, planCode: 'gc-starter', interval: 'month', actor: ACTOR }),
      (err) => err.problem?.code === 'invalid_transition',
    );
  });

  test('changePlan keeps status and period end, publishes the event', async () => {
    const current = await store.getSubscriptionByOrg(GC_ORG);
    const before = await outboxCount();
    const row = await store.changePlan({ subscriptionId: current.id, planCode: 'gc-business', actor: ACTOR });
    assert.equal(row.plan_code, 'gc-business');
    assert.equal(row.status, 'active');
    assert.equal(String(row.current_period_end), String(current.current_period_end));
    assert.equal(await outboxCount(), before + 1);
  });

  test('cancel, then a canceled slot is replaced in place (org_id UNIQUE)', async () => {
    const current = await store.getSubscriptionByOrg(GC_ORG);
    const canceled = await store.cancel({ subscriptionId: current.id, actor: ACTOR });
    assert.equal(canceled.status, 'canceled');

    const replaced = await store.subscribe({ id: randomUUID(), orgId: GC_ORG, planCode: 'gc-pro', interval: 'month', actor: ACTOR });
    assert.equal(replaced.id, current.id); // the slot, not a second row
    assert.equal(replaced.status, 'active');
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM billing.subscription WHERE org_id = $1', [GC_ORG]);
    assert.equal(n, 1);
  });

  test('add-ons: quantity sums within the current period only', async () => {
    await store.addAddOn({ id: randomUUID(), orgId: GC_ORG, kind: 'open_rfp_credits', quantity: 3 });
    await store.addAddOn({ id: randomUUID(), orgId: GC_ORG, kind: 'open_rfp_credits', quantity: 2 });
    await pool.query(
      `INSERT INTO billing.add_on (id, org_id, kind, quantity, period) VALUES ($1, $2, 'open_rfp_credits', 99, '2020-01')`,
      [randomUUID(), GC_ORG],
    );
    assert.equal(await store.addOnQuantity(GC_ORG, 'open_rfp_credits'), 5);
    assert.equal(await store.addOnQuantity(GC_ORG, 'promotion'), 0);
  });

  test('usage counts the real cross-schema rows', async () => {
    assert.deepEqual(await store.usage(GC_ORG), {
      'projects:active': 1, // Casa Dois is closed
      seats: 1,
      'rfp:open-credits': 1, // the draft open RFP never counts
    });
  });

  test('sponsorship covers the sponsored org on the contract project only', async () => {
    await pool.query(
      `INSERT INTO billing.sponsorship (contract_id, sponsor_org_id, sponsored_org_id, starts_at, ends_at)
       VALUES ($1, $2, $3, now() - interval '1 day', NULL)`,
      [CONTRACT, GC_ORG, SUB_ORG],
    );
    assert.equal(await store.sponsorshipCovers(SUB_ORG, PROJECT), true);
    assert.equal(await store.sponsorshipCovers(SUB_ORG, OTHER_PROJECT), false);
    assert.equal(await store.sponsorshipCovers(GC_ORG, PROJECT), false); // the sponsor is not sponsored
  });

  describe('the entitlements port end to end (phase-8 invariant)', () => {
    before(async () => {
      // LAPSED_ORG: a canceled subscription.
      const row = await store.subscribe({ id: randomUUID(), orgId: LAPSED_ORG, planCode: 'gc-starter', interval: 'month', actor: ACTOR });
      await store.cancel({ subscriptionId: row.id, actor: ACTOR });
    });

    test('a live subscription answers used < limit, add-ons included', async () => {
      const res = await entitlements.entitled(GC_ORG, 'projects:active');
      assert.deepEqual(res, { allowed: true, limit: 10, used: 1 }); // gc-pro
      const credits = await entitlements.entitled(GC_ORG, 'rfp:open-credits');
      assert.deepEqual(credits, { allowed: true, limit: 15, used: 1 }); // 10 + 5 add-on
    });

    test('CANCELED: a gated key answers false…', async () => {
      const res = await entitlements.entitled(LAPSED_ORG, 'projects:active');
      assert.equal(res.allowed, false);
    });

    test('…but a non-gated key (reads, the record) is STILL allowed', async () => {
      // Doc 04 §4 / doc 07: reading signed contracts and their record is
      // never blocked — READ is not an entitlement key.
      const res = await entitlements.entitled(LAPSED_ORG, 'contract:read');
      assert.deepEqual(res, { allowed: true, limit: null, used: 0 });
    });

    test('no subscription at all: gated denies, sponsorship on the project covers', async () => {
      const bare = await entitlements.entitled(SUB_ORG, 'projects:active');
      assert.equal(bare.allowed, false);
      const covered = await entitlements.entitled(SUB_ORG, 'projects:active', { projectId: PROJECT });
      assert.equal(covered.allowed, true);
      const elsewhere = await entitlements.entitled(SUB_ORG, 'projects:active', { projectId: OTHER_PROJECT });
      assert.equal(elsewhere.allowed, false);
    });
  });

  test('Idempotency-Key: a replay answers the stored response (platform 0002)', async () => {
    const meta = { key: randomUUID(), caller: 'user_carlos', operationId: 'buyAddOn', body: { code: 'promotion' } };
    const first = await store.idempotent(meta, async () => {
      await store.addAddOn({ id: randomUUID(), orgId: GC_ORG, kind: 'promotion', quantity: 1 });
      return { status: 201, body: { ok: true } };
    });
    assert.equal(first.replayed, false);
    const replay = await store.idempotent(meta, async () => {
      throw new Error('must not run again');
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.status, 201);
    assert.equal(await store.addOnQuantity(GC_ORG, 'promotion'), 1);
  });
});
