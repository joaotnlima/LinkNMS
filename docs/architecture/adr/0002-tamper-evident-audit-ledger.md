# ADR-0002 — Tamper-evident audit ledger

- **Status:** Proposed (awaiting CEO approval)
- **Date:** 2026-08-25
- **Deciders:** Full-Stack Architect
- **Context issue:** LINA-26 (R0) — FR2, FR4, FR7 and the acceptance anchor
  ("immutability of authorship and approval stamps provably holding").

## Context

The product's whole reason to exist is being able to answer, without argument,
*who decided what, when, and how much it moved the budget.* That answer is only
worth anything if the record is **tamper-evident**: a decision can be corrected,
but earlier versions and authorship/approval stamps can never be **silently**
altered or dropped. This is the load-bearing trust anchor, not a feature.

"Append-only tables" alone are not enough — a privileged actor or a bug could
still `UPDATE`/`DELETE` a row. We need edits to be **detectable**.

## Decision

**Event-sourced, hash-chained ledger as the system of record for all
trust-critical facts.**

1. **One append-only `audit_event` ledger per project.** Every trust-critical
   fact is an immutable event: `project_created`, `party_invited`,
   `decision_recorded`, `decision_revised`, `change_order_proposed`,
   `change_order_approved`, `change_order_rejected`. Events carry the actor
   (`actor_party_id`), a server-authoritative timestamp, and a JSON payload.

2. **Hash chain per project (tamper-evidence).** Each event stores:
   - `seq` — monotonic per project (1, 2, 3, …),
   - `payload_hash = sha256(canonical_json(type, actor, occurred_at, payload))`,
   - `prev_hash` — the `entry_hash` of `seq-1` (genesis uses a fixed constant),
   - `entry_hash = sha256(prev_hash || payload_hash)`.

   Any silent edit or deletion of a past event changes its `entry_hash`, which
   breaks every subsequent link. A **chain-verify** routine recomputes the chain
   and flags the first broken link. It runs in tests, on a scheduled check, and
   on demand from the audit view.

3. **Read models are derived and rebuildable.** `decision`, `decision_revision`,
   `change_order`, and `budget_event` are **projections** built by folding the
   ledger. They exist for query speed and can be dropped and rebuilt from the
   ledger at any time. The ledger — never a projection — is the truth.

4. **Defense in depth at the database.** The application's DB role is granted
   `INSERT` + `SELECT` on `audit_event` — **no `UPDATE`/`DELETE`**. Corrections
   happen only by appending a new event (e.g. `decision_revised`). This makes
   "append-only" a database-enforced fact, not a code convention.

5. **Server-authoritative stamps.** `actor_party_id` comes from the
   authenticated session, never the request body. `occurred_at` is set
   server-side. Clients cannot forge who or when.

## Alternatives considered

- **Plain append-only tables (the spike's approach).** Simpler, but not
  tamper-*evident* — a rogue `UPDATE` leaves no trace. Rejected as the core;
  kept as the shape of the projections.
- **External notarization / blockchain.** Massive overkill for R0, external
  dependency, cost. The hash chain gives internal tamper-evidence now; external
  anchoring (periodically publishing the head `entry_hash`) is a clean future
  add and is noted as a seam, not built.

## Consequences

- **Positive:** provable integrity (the acceptance anchor), a natural full
  history in order (FR7), trivial audit view, rebuildable projections.
- **Negative / debt:** every trust-critical write is an append + a projection
  update inside one transaction — more moving parts than a plain `UPDATE`. We
  accept this; it is the product's core value. Canonical JSON must be stable
  (sorted keys, fixed number formatting) or verification yields false positives
  — this is specified in the design doc and covered by tests.
- **Revisit when:** we add external notarization, or cross-project/global
  ledgers for multi-house.
