// Integration test for the mounted HTTP surface (LINA-56) — the R0 acceptance
// walk, executed against a REAL Postgres through the same composition root the
// Next routes use.
//
// WHY THIS EXISTS AND WHY IT USES A REAL DATABASE
//
// Every other suite here runs on in-memory adapters, which is right for domain
// rules but cannot see the three things that actually break in production:
//
//   1. GRANTS. `decision_app` has no UPDATE/DELETE on decision_revision, and
//      `change_order_app` has UPDATE on exactly ONE column of
//      ledger.budget_event. Those are the properties the audit trail rests on,
//      and an in-memory store enforces none of them. LINA-37 and LINA-51 both
//      shipped code that passed unit tests and failed on a missing grant.
//   2. CROSS-SCHEMA ATOMICITY. The projection write and `ledger.append_event`
//      must COMMIT together on one connection. A fake ledger cannot prove that.
//   3. THE WIRING ITSELF. This is the whole point of the slice: that a request
//      arriving with only a session reaches the right service as the right
//      party. Every handler below is called exactly as app/src/server/gateway.ts
//      calls it — `{ session, params, body }` in — so what is asserted here is
//      the deployed path, not a rehearsal of it.
//
// Runs only when VERIFY_DATABASE_URL points at a throwaway branch, and it MUST
// be a throwaway: it migrates and writes. Never point it at production.
//
//   VERIFY_DATABASE_URL='postgres://migrator:…@…/neondb?sslmode=require' \
//     node --test services/gateway/container.pg.test.mjs
import { test, describe, before, after, skip } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createContainer } from './container.mjs';
import { createPool } from '../ledger/db.mjs';
import { migrate } from '../ledger/migrate.mjs';
import { createNoopAnalytics } from '../analytics/index.mjs';

const URL_ = process.env.VERIFY_DATABASE_URL;

// A session, exactly as gateway.ts builds it from the signed cookie. Note what
// is NOT here: any way for a request body to name the acting party (ADR-0004).
const as = (partyId) => ({ partyId });
const ANON = null;

// Route params exactly as app/src/server/gateway.ts hands them to a handler: the
// Next segment is `[id]`, and `normaliseParams` exposes it under BOTH names
// because Identity reads `id` while Decision/ChangeOrder/Ledger read `projectId`.
// Building them the same way here is the point — a test that passed only the
// name a handler happens to want would not notice the mount being wrong.
const forProject = (projectId) => ({ id: projectId, projectId });

let c;                 // the container under test
let admin;             // migrator pool, for the out-of-band grant assertions
const email = (who) => `${who}-${randomUUID().slice(0, 8)}@example.test`;

describe('mounted HTTP surface over real Postgres', { skip: URL_ ? false : 'set VERIFY_DATABASE_URL to run' }, () => {
  let homeowner, gc, stranger, projectId;

  before(async () => {
    admin = createPool(URL_);

    // Try to bring the ledger schema up to date in-process. In CI the migrator
    // owns the database and this is what applies the slice's new grants; against
    // a Neon branch it is a no-op at best, because a branch cut from production
    // carries schemas owned by `neondb_owner` and our `migrator` role holds no
    // DDL privilege on them. That is not a failure of this suite — the caller is
    // expected to have run `node db/migrate.mjs` (which CI does, and which is the
    // only supported path on Neon) — so a permission error is tolerated and the
    // preflight below is what actually decides whether the schema is fit to test.
    try {
      await migrate(admin);
    } catch (err) {
      if (err.code !== '42501' && err.cause?.code !== '42501') throw err;
    }

    // Fail LOUD, and on the real reason, if the grants under test were never
    // applied. Without this the suite would report a wall of authorization
    // failures that look like product bugs and are in fact an unmigrated
    // database — the single most expensive way to read a red build.
    const missing = await admin.query(
      `select r.rolname from unnest($1::text[]) as r(rolname)
       where not exists (select 1 from pg_roles p where p.rolname = r.rolname)`,
      [['identity_app', 'decision_app', 'change_order_app', 'ledger_app']],
    );
    assert.equal(
      missing.rowCount,
      0,
      `run \`node db/migrate.mjs\` first — missing service roles: ${missing.rows.map((r) => r.rolname).join(', ')}`,
    );

    // The deployed shape: one URL, but every service dropped into its OWN role
    // via SET ROLE, so the grants below are the ones production enforces.
    c = createContainer({
      urls: { identity: URL_, decision: URL_, changeOrder: URL_, ledger: URL_ },
      roles: {
        identity: 'identity_app',
        decision: 'decision_app',
        changeOrder: 'change_order_app',
        ledger: 'ledger_app',
      },
      // The real no-op port, not a hand-rolled stub: this suite asserts
      // persistence and authorization, and a live sink would make a database
      // test depend on the network. It must be the REAL port shape — the
      // services call named methods (`analytics.projectCreated(…)`) directly,
      // so a stub missing one turns a committed write into a 500.
      analytics: createNoopAnalytics(),
    });

    homeowner = await c.parties.findOrCreateByEmail({ email: email('homeowner'), role: 'owner' });
    gc = await c.parties.findOrCreateByEmail({ email: email('gc'), role: 'contractor' });
    stranger = await c.parties.findOrCreateByEmail({ email: email('stranger'), role: 'contractor' });

    // Seats, because the deployed container enforces the plan allowance
    // (ADR-0013) and this suite IS the deployed shape. In production none of
    // these parties could exist unseated — an unseated Clerk account gets
    // /no-access and no party row — so seating them here makes the fixture
    // faithful rather than lenient. The homeowner is put on a multi-build plan:
    // this suite creates several records for one owner to assert authorization,
    // and its subject is who may act, not how many builds they bought. The cap
    // itself is asserted on its own below, and in identity/plans.test.mjs.
    for (const p of [homeowner, gc, stranger]) {
      await admin.query(
        `INSERT INTO identity.seat (email, source, note, plan) VALUES ($1, 'beta', 'container.pg.test', 'build_plus')
         ON CONFLICT (email) DO UPDATE SET plan = excluded.plan, status = 'active', revoked_at = NULL`,
        [p.email],
      );
    }
  });

  after(async () => {
    // Seats outlive the parties that used them (a seat is keyed on email, not on
    // a party id), so a run that left them behind would silently entitle the next
    // suite in the same database.
    await admin?.query("DELETE FROM identity.seat WHERE note = 'container.pg.test'");
    await c?.close();
    await admin?.end();
  });

  // ── FR1 — a shared record with a baseline budget, and one invited GC ────────
  describe('FR1 create a project and invite the GC', () => {
    test('the homeowner creates a project with a baseline budget', async () => {
      const res = await c.http.identity.createProject({
        session: as(homeowner.id),
        body: { name: 'Casa do Vale', baselineBudgetCents: 25_000_000 },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.baselineBudgetCents, 25_000_000);
      projectId = res.body.id;
    });

    test('an anonymous request cannot create a project', async () => {
      const res = await c.http.identity.createProject({
        session: ANON,
        body: { name: 'Ghost', baselineBudgetCents: 1 },
      });
      assert.equal(res.status, 401);
    });

    // The load-bearing one: a body that names someone else as owner must not
    // change who owns the project. This is the exact silent break the composition
    // root is positioned to cause, so it is asserted at the HTTP boundary.
    test('a body claiming another owner is inert — the session decides', async () => {
      const res = await c.http.identity.createProject({
        session: as(homeowner.id),
        body: {
          name: 'Body-owner attempt',
          baselineBudgetCents: 1000,
          ownerPartyId: stranger.id,
          actorPartyId: stranger.id,
        },
      });
      assert.equal(res.status, 201);
      const { rows } = await admin.query(
        'select party_id, role from identity.membership where project_id = $1', [res.body.id],
      );
      assert.deepEqual(rows, [{ party_id: homeowner.id, role: 'owner' }]);
    });

    test('the GC is invited and accepts, and only then is a member', async () => {
      const before_ = await c.http.identity.getProject({ session: as(gc.id), params: forProject(projectId) });
      assert.equal(before_.status, 403, 'an uninvited party must not read the project');

      const invite = await c.http.identity.inviteCounterparty({
        session: as(homeowner.id), params: forProject(projectId), body: { role: 'counterparty' },
      });
      assert.equal(invite.status, 201, JSON.stringify(invite.body));
      assert.equal(invite.headers['cache-control'], 'no-store', 'the raw token must not be cached');
      const token = invite.body.token;
      assert.ok(token, 'the raw invitation token is returned exactly once');

      // Only its hash is stored — a database read must not yield a usable token.
      const stored = await admin.query('select token_hash from identity.invitation where project_id = $1', [projectId]);
      assert.ok(stored.rows.every((r) => r.token_hash !== token));

      const accepted = await c.http.identity.acceptInvitation({ session: as(gc.id), params: { token } });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

      const after_ = await c.http.identity.getProject({ session: as(gc.id), params: forProject(projectId) });
      assert.equal(after_.status, 200, 'the GC can now read the shared record');
    });

    test('a stranger still cannot read the project', async () => {
      const res = await c.http.identity.getProject({ session: as(stranger.id), params: forProject(projectId) });
      assert.equal(res.status, 403);
    });
  });

  // ── The plan allowance at the HTTP boundary (ADR-0013) ─────────────────────
  // The unit tests pin the rule; this pins that the DEPLOYED composition reads
  // it — that the seat store is wired into the identity service through the
  // container and not merely available beside it. That wiring is exactly the
  // kind of thing that exists in a test fixture and is missing in production.
  describe('the plan allowance is enforced by the mounted surface', () => {
    test('a one-build plan takes the first build and refuses the second, over real Postgres', async () => {
      const solo = await c.parties.findOrCreateByEmail({ email: email('solo'), role: 'owner' });
      await admin.query(
        `INSERT INTO identity.seat (email, source, note, plan) VALUES ($1, 'beta', 'container.pg.test', 'personal')
         ON CONFLICT (email) DO UPDATE SET plan = excluded.plan, status = 'active', revoked_at = NULL`,
        [solo.email],
      );

      const first = await c.http.identity.createProject({
        session: as(solo.id), body: { name: 'Only Build', baselineBudgetCents: 100_00 },
      });
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await c.http.identity.createProject({
        session: as(solo.id), body: { name: 'Second Build', baselineBudgetCents: 100_00 },
      });
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.equal(second.body.error.code, 'plan_limit_reached');
      // The numbers the upgrade surface needs, carried on the wire rather than
      // re-derived from a client-side copy of the pricing table.
      assert.equal(second.body.error.plan, 'personal');
      assert.equal(second.body.error.limit, 1);
      assert.equal(second.body.error.owned, 1);

      // The refusal wrote nothing — one project row, not two.
      const { rows } = await admin.query(
        'select count(*)::int as cnt from identity.project where owner_party_id = $1', [solo.id],
      );
      assert.equal(rows[0].cnt, 1);
    });
  });

  // ── FR2 / FR7 — decisions, and corrections that keep history ───────────────
  describe('FR2 decision log keeps every revision', () => {
    let decisionId;

    test('the GC records a decision', async () => {
      const res = await c.http.decision.recordDecision({
        session: as(gc.id),
        params: forProject(projectId),
        body: { title: 'Kitchen window moved 40cm east', body: 'Agreed on site with the homeowner.' },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      decisionId = res.body.id;
    });

    test('a non-member cannot record or read decisions', async () => {
      const write = await c.http.decision.recordDecision({
        session: as(stranger.id), params: forProject(projectId), body: { title: 'Not mine' },
      });
      assert.ok([401, 403].includes(write.status), `expected denial, got ${write.status}`);
      const read = await c.http.decision.listDecisions({ session: as(stranger.id), params: forProject(projectId) });
      assert.ok([401, 403].includes(read.status), `expected denial, got ${read.status}`);
    });

    // FR2's whole promise: a correction must never erase what it corrected.
    test('a revision APPENDS — rev 1 survives verbatim', async () => {
      const res = await c.http.decision.reviseDecision({
        session: as(homeowner.id),
        params: { decisionId },
        body: { title: 'Kitchen window moved 60cm east', body: 'Corrected after the survey.' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const { rows } = await admin.query(
        'select rev, title, revised_by_party_id, audit_event_id from decision.decision_revision where decision_id = $1 order by rev',
        [decisionId],
      );
      assert.equal(rows.length, 2, 'both revisions are present');
      assert.match(rows[0].title, /40cm/, 'the ORIGINAL text is untouched');
      assert.match(rows[1].title, /60cm/);
      assert.equal(rows[0].revised_by_party_id, gc.id, 'rev 1 keeps its own author');
      assert.equal(rows[1].revised_by_party_id, homeowner.id);
      assert.ok(rows.every((r) => r.audit_event_id), 'every revision is chained into the ledger');
    });

    // The grant, not the service, is what makes history immutable. Assert the
    // privilege directly: no amount of service-layer regression can loosen it.
    test('decision_app is not permitted to rewrite history', async () => {
      const { rows } = await admin.query(
        `select privilege_type from information_schema.table_privileges
          where grantee = 'decision_app' and table_schema = 'decision'
            and table_name = 'decision_revision'`,
      );
      const granted = rows.map((r) => r.privilege_type).sort();
      assert.deepEqual(granted, ['INSERT', 'SELECT'], 'no UPDATE and no DELETE on the revision history');
    });

    test('FR7 lists decisions in a deterministic chronological order', async () => {
      await c.http.decision.recordDecision({
        session: as(gc.id), params: forProject(projectId), body: { title: 'Second decision' },
      });
      const res = await c.http.decision.listDecisions({ session: as(homeowner.id), params: forProject(projectId) });
      assert.equal(res.status, 200);
      const ids = res.body.decisions.map((d) => d.id);
      assert.equal(ids[0], decisionId, 'the earliest decision comes first');
      assert.equal(new Set(ids).size, ids.length);
    });
  });

  // ── FR3–FR8 — change orders and the budget they move ───────────────────────
  describe('FR3–FR8 change orders move the budget, once, with an audit event', () => {
    let coId;
    let baselineTotal;

    test('the GC proposes a change order', async () => {
      const status = await c.http.ledger.getStatus({ session: as(homeowner.id), params: forProject(projectId) });
      assert.equal(status.status, 200, JSON.stringify(status.body));
      // The four-pillar panel (pen M14; ADR-0015 §1): BUDGET carries the
      // authoritative baseline/current/delta, all derived ledger-side.
      baselineTotal = status.body.budget.currentCents;

      const res = await c.http.changeOrder.proposeChangeOrder({
        session: as(gc.id),
        params: forProject(projectId),
        body: { title: 'Upgrade to triple glazing', costDeltaCents: 450_000 },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      coId = res.body.id;
    });

    test('a proposed change order has NOT moved the budget', async () => {
      const status = await c.http.ledger.getStatus({ session: as(homeowner.id), params: forProject(projectId) });
      assert.equal(status.body.budget.currentCents, baselineTotal, 'only an approval moves money');
      assert.equal(status.body.budget.deltaCents, 0, 'and nothing has moved yet');
    });

    // FR5 — the two-sided approval rule. The proposer cannot also approve.
    test('the proposer cannot approve their own change order', async () => {
      const res = await c.http.changeOrder.decideChangeOrder({
        session: as(gc.id), params: { changeOrderId: coId }, body: { decision: 'approve' },
      });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'self_decision');
    });

    test('a non-member cannot decide it either', async () => {
      const res = await c.http.changeOrder.decideChangeOrder({
        session: as(stranger.id), params: { changeOrderId: coId }, body: { decision: 'approve' },
      });
      assert.ok([401, 403].includes(res.status), `expected denial, got ${res.status}`);
    });

    test('the homeowner approves, and the budget moves by exactly the delta', async () => {
      const res = await c.http.changeOrder.decideChangeOrder({
        session: as(homeowner.id), params: { changeOrderId: coId }, body: { decision: 'approve' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.decision ?? res.body.status, 'approved');

      const status = await c.http.ledger.getStatus({ session: as(homeowner.id), params: forProject(projectId) });
      assert.equal(status.body.budget.currentCents, baselineTotal + 450_000,
        'the authoritative total moved by the delta, server-side');
      assert.equal(status.body.budget.deltaCents, 450_000);
    });

    // FR8 — every cent that moved is answerable. No budget event without an
    // audit event behind it is the single property the whole ledger exists for.
    test('the budget movement carries an audit event', async () => {
      const { rows } = await admin.query(
        `select delta_cents, audit_event_id from ledger.budget_event
          where change_order_id = $1`, [coId],
      );
      assert.equal(rows.length, 1, 'approval records exactly one budget event');
      assert.equal(Number(rows[0].delta_cents), 450_000);
      assert.ok(rows[0].audit_event_id, 'the movement is chained to an audit event');
    });

    // The LINA-51 review finding, asserted as a standing regression guard: a
    // table-wide UPDATE here would let the service move delta_cents with no
    // audit event behind it.
    test('change_order_app may update ONLY the audit back-link on budget_event', async () => {
      const table = await admin.query(
        `select privilege_type from information_schema.table_privileges
          where grantee = 'change_order_app' and table_schema = 'ledger'
            and table_name = 'budget_event' and privilege_type = 'UPDATE'`,
      );
      assert.equal(table.rowCount, 0, 'there must be NO table-wide UPDATE on ledger.budget_event');

      const cols = await admin.query(
        `select column_name from information_schema.column_privileges
          where grantee = 'change_order_app' and table_schema = 'ledger'
            and table_name = 'budget_event' and privilege_type = 'UPDATE'`,
      );
      assert.deepEqual(cols.rows.map((r) => r.column_name), ['audit_event_id']);
    });

    test('an approved change order is not decided twice', async () => {
      const res = await c.http.changeOrder.decideChangeOrder({
        session: as(homeowner.id), params: { changeOrderId: coId }, body: { decision: 'reject' },
      });
      assert.ok(res.status >= 400, 'a settled change order cannot be re-decided');

      const { rows } = await admin.query(
        'select count(*)::int as n from ledger.budget_event where change_order_id = $1', [coId],
      );
      assert.equal(rows[0].n, 1, 'and the budget did not move a second time');
    });

    test('FR6 one screen answers who decided, when, and what it cost', async () => {
      const res = await c.http.changeOrder.getChangeOrder({
        session: as(homeowner.id), params: { changeOrderId: coId },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.costDeltaCents ?? res.body.costDelta?.cents, 450_000);

      const denied = await c.http.changeOrder.getChangeOrder({
        session: as(stranger.id), params: { changeOrderId: coId },
      });
      assert.ok([401, 403].includes(denied.status), `expected denial, got ${denied.status}`);
    });
  });

  // ── The audit trail the whole product is sold on ───────────────────────────
  describe('FR9 the audit trail is complete and verifiable', () => {
    test('the project audit read path returns the chain to a member only', async () => {
      const res = await c.http.ledger.getAudit({ session: as(homeowner.id), params: forProject(projectId), headers: {} });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const events = res.body.events ?? res.body;
      assert.ok(Array.isArray(events) && events.length > 0, 'the trail is not empty');

      const denied = await c.http.ledger.getAudit({ session: as(stranger.id), params: forProject(projectId), headers: {} });
      assert.ok([401, 403].includes(denied.status), `expected denial, got ${denied.status}`);
    });

    // No `*_app` role may write ledger.audit_event directly — they may only
    // EXECUTE append_event, which is what enforces the hash chain. A direct
    // INSERT grant would make the chain forgeable from inside a service.
    test('no service role can INSERT into ledger.audit_event directly', async () => {
      const { rows } = await admin.query(
        `select grantee, privilege_type from information_schema.table_privileges
          where table_schema = 'ledger' and table_name = 'audit_event'
            and grantee like '%\\_app' and privilege_type in ('INSERT','UPDATE','DELETE')`,
      );
      assert.deepEqual(rows, [], 'the chain is only ever appended through ledger.append_event');
    });
  });

  // ── The returning-user portfolio (ADR-0012 §A1) ────────────────────────────
  // The landing screen for anyone with ≥1 build. Its counts come from folds the
  // container wires in `http.identity` from the decision and change-order STORES
  // — a path only reachable when a party actually has a project, so no in-memory
  // suite and none of the tests above ever executed it. That gap shipped a
  // ReferenceError (the counts callbacks closed over identifiers that were only
  // inline args to createServices, never bound): an EMPTY portfolio returned
  // before the fold and worked, so the crash surfaced the instant an owner made
  // their first build — the returning-user landing, dead. This asserts the
  // populated path the deployed composition runs.
  describe('listProjects folds the batched counts through the container wiring', () => {
    test('a party with builds gets a 200 portfolio carrying decision/change-order counts', async () => {
      const res = await c.http.identity.listProjects({ session: as(homeowner.id) });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const card = res.body.projects.find((p) => p.id === projectId);
      assert.ok(card, 'the owner sees their own build on the portfolio');
      // The fold is the thing that used to throw: assert it produced real numbers
      // for this project (two decisions and one approved change order were
      // recorded above), not the empty-Map fallback.
      assert.equal(card.counts.decisions, 2, 'the decision count fold ran over the real store');
      assert.equal(card.counts.changeOrders, 1, 'the change-order count fold ran over the real store');
    });

    test('an empty portfolio is a clean 200, not a crash', async () => {
      const fresh = await c.parties.findOrCreateByEmail({ email: email('empty'), role: 'owner' });
      const res = await c.http.identity.listProjects({ session: as(fresh.id) });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.projects, []);
    });
  });
});

if (!URL_) skip('VERIFY_DATABASE_URL not set — integration suite skipped');
