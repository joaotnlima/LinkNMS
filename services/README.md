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

## Composition root

The services are built **once per process, in one place**. That place is split
across two files on purpose:

- **`composition.mjs` — `createServices(ports)`**: the service graph itself, over
  ports. No env, no pools, no framework. This is what the composition tests run
  against in-memory adapters, so the wiring under test is literally the wiring
  that ships.
- **`gateway/container.mjs` — `createContainer()`/`getContainer()`**: the
  deployed-target ports. Reads the env, opens **one pool per service role**
  (`IDENTITY_DATABASE_URL`, `DECISION_DATABASE_URL`, `CHANGE_ORDER_DATABASE_URL`,
  `LEDGER_DATABASE_URL`, falling back to `DATABASE_URL` for local/CI), binds a pg
  ledger per pool over one shared cache, and calls `createServices`. The Next
  routes touch nothing else.

There is deliberately **no second env-reading composition root**. A single-pool
shortcut would quietly drop the per-service role separation the ledger write
guard depends on.

Two rules make instrumentation actually deliver:

- **`analytics` is injected by `createServices`, never constructed per request.**
  Each service takes `analytics` as an optional arg defaulting to a no-op — so a
  missing injection is silent, not a crash. `getAnalytics()` reads the env once
  (`POSTHOG_API_KEY`, `POSTHOG_HOST`, `RELEASE_SHA`); with no key it returns a
  working no-op and domain behaviour is unchanged.
- **Every response flushes.** The PostHog sink batches captures into one
  `/batch/` request; on a serverless runtime an unflushed buffer is a silently
  dropped batch. Every API route funnels through `handle()` in
  `app/src/server/gateway.ts`, which flushes in a `finally` — so the error path
  (the most valuable telemetry) flushes too, and a failing flush can never turn a
  committed write into a 500. `withAnalyticsFlush(handler)` in `composition.mjs`
  gives the same guarantee to any handler mounted outside that gateway.

`createServices` composes `decision` only when a decision store is supplied. That
conditional is deliberate: a memory fallback would look wired and lose every
decision on cold start.

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
