# LinkNMS QA — first quality gate

Owner: **QA Developer** (LINA-21). Partner: **Full-Stack Architect** (CI/stack).

This folder is the seed of LinkNMS quality. It exists *before* the app stack so
that the trust-critical invariants are guarded from commit #1 — per the role's
sequencing note (*build quality gates alongside the first features, not after*).

## What's here

| Path | What it is |
|---|---|
| `fixtures/r0_shared_record.json` | Golden fixture: one realistic homeowner+GC build (parties, decision log, change orders, budget ledger). The canonical seed for all R0 tests. |
| `checks/audit_budget_invariants.py` | Stack-agnostic checker for the three trust invariants (audit immutability, budget math, permission/segregation-of-duties). Exit 1 on any violation. |
| `checks/run_gate.py` | **CI entrypoint.** Runs the checker on the golden fixture (must pass) and on seeded tampering (each must be caught). |

The gate runs in CI as its own workflow, `.github/workflows/quality-gate.yml`
(job **`trust-invariants`**) — deliberately separate from `ci.yml` so it stays
runnable when the app or service toolchain is mid-change.

## Run locally

```bash
python3 qa/checks/run_gate.py          # full gate (golden + tamper detection)
python3 qa/checks/audit_budget_invariants.py qa/fixtures/r0_shared_record.json
```

Expected: `GATE PASSED: golden clean, all tampering caught.` (exit 0).

## The three invariants (why they're the gate)

If any of these can silently break, LinkNMS has no reason to exist:

1. **Audit immutability** — decision/change/cost history is append-only. Edits
   create revisions; revisions are attributed, timestamped, and never deleted.
2. **Budget math** — `current_total == baseline + sum(delta of APPROVED change
   orders)`. Proposed and rejected COs move nothing.
3. **Permission / segregation of duties** — a change order cannot be approved by
   its proposer, and an owner-proposed CO cannot be self-approved by the owner.
   Every approval is attributed and timestamped.

## Live-data gate (graduated — LINA-64)

The checker reads a JSON document. It now runs against **two** of them on every
PR:

- the **static fixture** — proves the checker catches tampering
  (`quality-gate.yml`, via `run_gate.py`);
- a **live export** — proves the *real system* upholds the invariants. The
  `gateway-integration` job in `ci.yml` seeds the golden homeowner+GC build
  through the mounted HTTP surface (LINA-56) over Postgres and reads it back,
  then points the checker at the export **and** the fixture.

The exporter is `services/gateway/export-live-record.mjs`. It drives the same
composition-root handlers the Next routes call, so what the gate checks is the
deployed path, not a rehearsal of it. Run it locally against a throwaway,
already-migrated database:

```bash
cd services
DATABASE_URL=postgres://…  node gateway/export-live-record.mjs /tmp/live.json
python3 ../qa/checks/audit_budget_invariants.py /tmp/live.json
```

**Budget math is the load-bearing assertion.** The export's `expected` block is
sourced from the live **ledger status endpoint**, and the checker independently
re-sums the approved deltas from the exported change orders — so any drift
between the change-order projection and the authoritative ledger total fails the
build. Segregation of duties is, on live data, defence-in-depth (the DB already
enforces it via the `decided_by_is_not_proposer` CHECK); append-only history and
budget math are where this gate uniquely earns its keep.

**R0 shape note.** The shared record is bilateral — one owner and exactly one
counterparty (`inviteCounterparty` 409s a second). The live export therefore
seeds every change order as proposed by the GC and decided by the homeowner;
this still exercises the full delta set (approved / proposed / rejected) and
keeps proposer ≠ decider. The static fixture keeps its four illustrative parties.

**Field-name normalisation.** The fixture predates the real schema, so a live
export cannot be fed to the checker unchanged. The exporter is the normaliser:
it maps the live API's field names to the checker's canonical (fixture) names.
**Do not** rename the fixture — `run_gate.py`'s tamper mutators key off its field
names. Verified against `services/change_order/migrations/*.sql` on `main`:

| Fixture field | Real column (`change_order.change_order`) |
|---|---|
| `proposer_party_id` | `proposed_by_party_id` |
| `delta_cents` | `cost_delta_cents` |
| `decided_by_party_id` | `decided_by_party_id` *(matches)* |
| `status` | `status` *(matches — `proposed`/`approved`/`rejected`)* |

The exporter also normalises the live API's camelCase (`costDeltaCents`,
`proposedBy`, `decidedBy`, `baselineBudgetCents`, revision `authorPartyId`) onto
these same canonical names.

### Still to layer on (follow-up)

The fuller suite from the LINA-21 test strategy — e2e critical flows across the
UI, the multi-party permission matrix, and immutability snapshot tests — sits on
top of this gate and is tracked separately. The live invariant export closes the
budget-math + append-only-history graduation; the broader flow coverage is the
next increment.

See the **LinkNMS Test Strategy** document on LINA-21 for the full plan.
