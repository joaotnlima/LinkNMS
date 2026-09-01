// LinkNMS QA — live golden-record exporter (LINA-64).
//
// Graduates the trust-invariant gate from a static fixture to the REAL system.
// It seeds the golden homeowner+GC build through the SAME composition-root
// handlers the Next routes call (LINA-56), against a real Postgres, then emits a
// JSON document in the checker's canonical shape so
// `qa/checks/audit_budget_invariants.py` can assert the three invariants on data
// the live system actually produced — not on a hand-authored seed.
//
// WHY AN EXPORTER, NOT A RENAMED FIXTURE
// The static fixture predates the schema and uses different field names
// (`proposer_party_id`, `delta_cents`); the tamper mutators in
// `qa/checks/run_gate.py` key off those names, so the fixture MUST NOT be
// renamed. Instead THIS exporter is the normaliser: it maps the live API's
// field names to the checker's canonical (fixture) names, so both the static
// fixture and this live export feed the one unchanged checker identically.
//
//   live API field        ->  checker/fixture field
//   costDeltaCents            delta_cents
//   proposedBy                proposer_party_id      (col proposed_by_party_id)
//   decidedBy                 decided_by_party_id
//   decidedAt                 decided_at
//   baselineBudgetCents       budget_baseline_cents
//   revisions[].authorPartyId revisions[].by
//
// The `expected` budget block is taken from the LIVE ledger's authoritative
// status (`getStatus().cost`), NOT recomputed here. That is the load-bearing
// assertion: the checker independently sums the approved deltas from the
// exported change orders and must arrive at the same total the ledger serves.
// If the CO projection and the ledger ever disagree, this gate goes red — which
// is budget math proven end-to-end on the real system, the invariant this gate
// uniquely earns its keep on (segregation of duties is already a DB CHECK).
//
// Usage:
//   DATABASE_URL=postgres://…  node gateway/export-live-record.mjs [out.json]
// Writes the export to `out.json` (default: stdout). Requires a throwaway,
// already-migrated database (CI's gateway-integration job provides one).
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createContainer } from './container.mjs';
import { createNoopAnalytics } from '../analytics/index.mjs';

const outPath = process.argv[2] || null;
const email = (who) => `${who}-${randomUUID().slice(0, 8)}@example.test`;

// A session exactly as gateway.ts builds it from the signed cookie: the acting
// party comes from the session, never from a request body (ADR-0004).
const as = (partyId) => ({ partyId });
const forProject = (projectId) => ({ id: projectId, projectId });

function must(res, expected, what) {
  if (res.status !== expected) {
    throw new Error(`${what}: expected ${expected}, got ${res.status} — ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function main() {
  // Single-role fallback (CI/local): one migrator URL, no SET ROLE. The role
  // separation the deployed target enforces is exercised by the gateway
  // integration suite; here we only need to seed and read a throwaway DB.
  const c = createContainer({ analytics: createNoopAnalytics() });
  try {
    // ── Parties ────────────────────────────────────────────────────────────
    // R0's shared record is bilateral: exactly one owner and one counterparty
    // (`inviteCounterparty` 409s a second — the domain models a homeowner+GC
    // pair, not an N-party project). So the golden build is reproduced with the
    // GC as the single counterparty: every change order is proposed by the GC
    // and decided by the homeowner, which still exercises the deltas, the
    // proposed/rejected no-op cases, and proposer != decider.
    const homeowner = await c.parties.findOrCreateByEmail({ email: email('homeowner'), role: 'owner' });
    const gc = await c.parties.findOrCreateByEmail({ email: email('gc'), role: 'contractor' });

    // ── Project (FR1) ────────────────────────────────────────────────────────
    const project = must(await c.http.identity.createProject({
      session: as(homeowner.id),
      body: { name: 'Maple Street new build', baselineBudgetCents: 42_000_000 },
    }), 201, 'create project');
    const projectId = project.id;

    // ── Invite + accept the single counterparty (the GC) ─────────────────────
    const invite = must(await c.http.identity.inviteCounterparty({
      session: as(homeowner.id), params: forProject(projectId), body: { role: 'counterparty' },
    }), 201, 'invite counterparty');
    must(await c.http.identity.acceptInvitation({
      session: as(gc.id), params: { token: invite.token },
    }), 200, 'accept invitation');

    // ── Decisions (FR2) — dec_002 gets a second, appended revision ───────────
    must(await c.http.decision.recordDecision({
      session: as(homeowner.id), params: forProject(projectId),
      body: { title: 'Approved foundation plan rev C', body: 'Foundation plan rev C accepted.' },
    }), 201, 'record dec_001');

    const dec2 = must(await c.http.decision.recordDecision({
      session: as(gc.id), params: forProject(projectId),
      body: { title: 'Use engineered lumber for second-floor joists', body: 'Switch to engineered lumber, pending owner cost approval.' },
    }), 201, 'record dec_002');
    must(await c.http.decision.reviseDecision({
      session: as(gc.id), params: { decisionId: dec2.id },
      body: { title: 'Use engineered lumber for second-floor joists', body: 'Amended: added span table reference. Prior revision preserved.' },
    }), 200, 'revise dec_002');

    // ── Change orders (FR3–FR8) ──────────────────────────────────────────────
    // co_001: GC proposes 380000, homeowner approves.
    const co1 = must(await c.http.changeOrder.proposeChangeOrder({
      session: as(gc.id), params: forProject(projectId),
      body: { title: 'Engineered lumber upgrade (2nd-floor joists)', costDeltaCents: 380_000 },
    }), 201, 'propose co_001');
    must(await c.http.changeOrder.decideChangeOrder({
      session: as(homeowner.id), params: { changeOrderId: co1.id }, body: { decision: 'approve' },
    }), 200, 'approve co_001');

    // co_002: GC proposes 65000, homeowner approves.
    const co2 = must(await c.http.changeOrder.proposeChangeOrder({
      session: as(gc.id), params: forProject(projectId),
      body: { title: 'Add whole-house surge protection', costDeltaCents: 65_000 },
    }), 201, 'propose co_002');
    must(await c.http.changeOrder.decideChangeOrder({
      session: as(homeowner.id), params: { changeOrderId: co2.id }, body: { decision: 'approve' },
    }), 200, 'approve co_002');

    // co_003: GC proposes 220000, left PROPOSED (must not move the budget).
    must(await c.http.changeOrder.proposeChangeOrder({
      session: as(gc.id), params: forProject(projectId),
      body: { title: 'Upgrade kitchen window package', costDeltaCents: 220_000 },
    }), 201, 'propose co_003');

    // co_004: GC proposes 140000, homeowner REJECTS (must not move the budget).
    const co4 = must(await c.http.changeOrder.proposeChangeOrder({
      session: as(gc.id), params: forProject(projectId),
      body: { title: 'Relocate laundry hookups (owner request, later withdrawn)', costDeltaCents: 140_000 },
    }), 201, 'propose co_004');
    must(await c.http.changeOrder.decideChangeOrder({
      session: as(homeowner.id), params: { changeOrderId: co4.id }, body: { decision: 'reject' },
    }), 200, 'reject co_004');

    // ── Read the live system back through the same handlers ──────────────────
    const decisions = must(await c.http.decision.listDecisions({
      session: as(homeowner.id), params: forProject(projectId),
    }), 200, 'list decisions').decisions;

    const changeOrders = must(await c.http.changeOrder.listChangeOrders({
      session: as(homeowner.id), params: forProject(projectId),
    }), 200, 'list change orders').changeOrders;

    const status = must(await c.http.ledger.getStatus({
      session: as(homeowner.id), params: forProject(projectId),
    }), 200, 'ledger status');

    // ── Normalise live field names -> the checker's canonical (fixture) shape ─
    const record = {
      _meta: {
        name: 'R0 live export — seeded through the mounted API (LINA-64)',
        purpose: 'Golden homeowner+GC build seeded and read back through the real composition-root handlers over Postgres, normalised to the checker schema. Proves the LIVE system upholds the trust invariants, not just the static seed.',
        schema_version: '0.1',
        source: 'services/gateway/export-live-record.mjs',
      },
      project: {
        id: projectId,
        name: project.name ?? 'Maple Street new build',
        currency: 'USD',
        budget_baseline_cents: project.baselineBudgetCents,
        owner_party_id: homeowner.id,
      },
      parties: [
        { id: homeowner.id, role: 'homeowner', is_owner: true },
        { id: gc.id, role: 'gc', is_owner: false },
      ],
      decisions: decisions.map((d) => ({
        id: d.id,
        title: d.title,
        created_at: d.createdAt,
        // authorPartyId (rev author) -> `by`; the checker asserts every revision
        // is attributed and timestamped, with a gap-free rev sequence.
        revisions: (d.revisions ?? []).map((r) => ({
          rev: r.rev,
          at: r.at,
          by: r.authorPartyId,
          summary: r.body ?? r.title,
        })),
      })),
      change_orders: changeOrders.map((co) => ({
        id: co.id,
        title: co.title,
        // costDeltaCents -> delta_cents, proposedBy -> proposer_party_id,
        // decidedBy -> decided_by_party_id (see the mapping table above).
        delta_cents: co.costDeltaCents,
        status: co.status,
        proposer_party_id: co.proposedBy,
        decided_by_party_id: co.decidedBy ?? null,
        created_at: co.createdAt,
        decided_at: co.decidedAt ?? null,
      })),
      // Authoritative totals from the LIVE ledger, not recomputed here — the
      // checker re-derives the same numbers from change_orders and must match.
      expected: {
        approved_delta_total_cents: status.cost.deltaCents,
        current_budget_total_cents: status.cost.currentCents,
        note: 'Sourced from the live ledger status endpoint. The checker independently sums approved deltas from change_orders and must arrive at these numbers.',
      },
    };

    const json = JSON.stringify(record, null, 2);
    if (outPath) {
      writeFileSync(outPath, json + '\n');
      process.stderr.write(`live golden record exported -> ${outPath}\n`);
    } else {
      process.stdout.write(json + '\n');
    }
  } finally {
    await c.close();
  }
}

main().catch((err) => {
  process.stderr.write(`export failed: ${err.stack || err}\n`);
  process.exit(1);
});
