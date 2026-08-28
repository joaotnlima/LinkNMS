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

## Graduating the gate to live data (blocked on LINA-56)

The checker reads a JSON document. Today that's a static fixture; next it's a
live export from the real API. The remaining work is tracked as a follow-up and
is gated on **LINA-56** (mount the domain HTTP surface) — there is no endpoint
to export from until it merges.

**Known field-name delta.** The fixture predates the real schema, so an export
cannot be fed to the checker unchanged. Verified against
`services/change_order/migrations/*.sql` on `main`:

| Fixture field | Real column (`change_order.change_order`) |
|---|---|
| `proposer_party_id` | `proposed_by_party_id` |
| `delta_cents` | `cost_delta_cents` |
| `decided_by_party_id` | `decided_by_party_id` *(matches)* |
| `status` | `status` *(matches — `proposed`/`approved`/`rejected`)* |

Note the DB already enforces segregation of duties itself via the
`decided_by_is_not_proposer` CHECK constraint — so on live data that invariant
becomes a *defence-in-depth* assertion rather than the only guard. The budget
and append-only-history invariants remain the checker's unique contribution.

To graduate:

1. Add an API/CLI step that seeds the golden build and exports the shape above,
   normalising the field names in the table (either in the exporter or behind a
   small adapter in the checker — **do not** silently rename the fixture, the
   tamper mutators in `run_gate.py` key off its field names).
2. Point the checker at the export **in addition to** the static fixture — now
   the gate proves the *real system* upholds the invariants, not just the seed.
3. Layer the fuller suite from the test strategy (e2e critical flows,
   permission matrix, immutability snapshot tests) on top.

See the **LinkNMS Test Strategy** document on LINA-21 for the full plan.
