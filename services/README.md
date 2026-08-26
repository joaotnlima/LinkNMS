# Services

R0 is one deployable, decomposed into bounded services (ADR-0003, ADR-0005) that
are **modelled to exist separately from day one** so any one can later scale or be
extracted where the pressure actually is (ADR-0006):

| Service | Schema | Responsibility |
|---------|--------|----------------|
| `identity` | `identity` | Projects, parties, invites, **all permission checks** (ADR-0004) |
| `decision` | `decision` | Record & revise decisions (append-only) |
| `change_order` | `change_order` | Change-order lifecycle + two-sided approval |
| `ledger` | `ledger` | The hash-chained `audit_event` + budget + four-pillar status |
| `schedule` | `schedule` | Stages, append-only progress, plan documents (ADR-0005) |

## Isolation contract (ADR-0006 §1)

- One Postgres instance, **one schema per service**; ownership enforced by
  per-service DB roles + grants, not just convention.
- **No service reads another's schema** — cross-service access goes through the
  owning service's typed interface (in-process now, HTTP later).
- `audit_event` is write-guarded: everything appends through
  `ledger.append_event(...)`; hash-chain construction lives in exactly one place.

## What's built so far

- **`ledger/hash-chain.mjs`** — the trust anchor (ADR-0002): canonical JSON +
  per-project hash chain + `verifyChain`. Storage-agnostic pure functions, so the
  same maths runs on append and on verify. Postgres persistence wraps these; it
  never re-implements them.
- **`ledger/hash-chain.test.mjs`** — adversarial tests (tamper a payload, delete
  a middle event, forge an `entry_hash`, reorder, drop genesis, canonical-JSON
  stability). Run: `node --test services/ledger/hash-chain.test.mjs`.

Per the rollout plan (design §12), the ledger core lands first and green before
anything builds on it. Remaining slices are delegated child issues off LINA-26.
