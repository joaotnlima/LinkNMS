# ADR-0006 — Schema-per-service isolation, API surface visibility, and per-endpoint SLAs

- **Status:** Accepted (CEO approved the R0 plan, 2026-08-25; this ADR absorbs the
  CEO's follow-up direction on the same thread).
- **Date:** 2026-08-25
- **Deciders:** Founding Engineer + Full-Stack Architect
- **Context issue:** LINA-26 (R0). Extends ADR-0001 (stack), ADR-0003 (service
  boundaries), and depends on LINA-28 (metrics/PostHog spec).

## Context

The CEO approved the R0 plan and added four operating constraints on the same
thread:

1. **One DB instance, but each service modelled to exist separately** — in its
   own schema — so a service can later scale (or be extracted) exactly where the
   pressure is, and so degradation is attributable to a specific service.
2. **A way to *see* each service's exposed and internal APIs** — ideally a free,
   viewable tool (Swagger-style).
3. **Connectivity & scalability** — expected request volume, and caching to stop
   one hot path from degrading the whole system.
4. **Every endpoint has metrics + SLAs, fully tracked by the Product Analytics
   Lead** — so a degradation is detected and followed up directly with the
   owner and the CEO.

ADR-0003 already fixes *where* the service seams are. This ADR fixes *how* they
are isolated in one database, *how* their surface is made visible, and *how*
they are measured.

## Decision

### 1. Schema-per-service on a single Postgres instance

One instance, one database, **one Postgres schema per bounded service**:

| Service | Schema | Owns (tables) |
|---------|--------|---------------|
| Identity & Membership | `identity` | `project`, `party`, `membership`, `invitation` |
| Decision Log | `decision` | `decision`, `decision_revision` |
| Change Order | `change_order` | `change_order` |
| Ledger & Budget | `ledger` | `audit_event` (owner), `budget_event` |
| Schedule & Progress | `schedule` | `stage`, `stage_progress`, `plan_document` |

**Modelling patterns that make the boundary real (not just a convention):**

- **Grants, not discipline, enforce ownership.** Each service connects with its
  own DB role that has `USAGE` on **its own schema only** plus `EXECUTE` on the
  ledger's append function (below). No role holds cross-schema `SELECT`. A
  careless join across ownership lines fails at the database, not in review.
- **The `audit_event` table is write-guarded.** No service role — not even the
  ledger's own app role — gets raw `INSERT/UPDATE/DELETE` on `ledger.audit_event`
  (ADR-0002 §4 keeps it `INSERT+SELECT` at most). Appends go through
  `ledger.append_event(...)`, a `SECURITY DEFINER` function owned by the migrator
  role that constructs `seq`/`prev_hash`/`entry_hash` in one place. Calling
  services get `EXECUTE` on it and `SELECT` on a per-project audit **view**, and
  nothing more. Hash-chain construction lives in exactly one code path.
- **Cross-service reads go through the owning service's interface** (a typed
  in-process function in R0, swappable for HTTP later — ADR-0003). No service
  reaches into another's schema.
- **Trust-critical write = one transaction across two schemas.** Because R0 is a
  single instance, a projection write in schema X and `ledger.append_event(...)`
  commit together on one connection (`BEGIN … COMMIT`). This transactional
  guarantee is the reason R0 stays a single instance (ADR-0001). The seam for
  when services split their DBs is a **transactional outbox** in each schema
  (event row written in the same tx, relayed async) — noted here, not built.
- **Schema-qualified names everywhere.** No reliance on `search_path`; every
  table reference is `schema.table` so an accidental cross-schema join can't
  silently resolve.
- **Migrations are per-schema and forward-only**, applied by a single `migrator`
  role that owns all DDL; app roles never run DDL. Each service owns the
  migration files under its schema.
- **Idempotency keys on mutating endpoints** (change-order decision above all),
  so serverless retries can't double-apply. Ledger uniqueness
  (`UNIQUE(project_id, seq)`, `budget_event UNIQUE(change_order_id)`) is the
  backstop.

**Extraction seam:** moving a service to its own instance = move its schema +
swap the in-process interface for HTTP + replace the shared-tx ledger append with
the outbox relay. Because no cross-schema joins exist, this is mechanical.

### 2. API surface is visible via OpenAPI + Swagger UI (free)

- **Every service publishes an OpenAPI 3.1 document** it owns, in-repo at
  `services/<name>/openapi.yaml`, describing its **externally exposed** HTTP
  endpoints. A small build step merges them into one gateway spec.
- **Internal (service-to-service) interfaces** are documented as typed
  interfaces next to each service (`services/<name>/interface.ts`) and listed in
  an `INTERNAL-APIS.md` index, so the internal surface is as visible as the
  external one.
- **Rendered with Swagger UI** (open-source, free) served at `/api/docs` on
  **preview / non-production only**. Redoc and Scalar are viable free
  alternatives; Swagger UI is chosen for "try it out" against preview deploys.
- **Contract tests** validate each handler's responses against its OpenAPI spec
  in CI, so the visible surface can't drift from the real one.

### 3. Connectivity, scalability, caching

- **Load reality:** R0 is one homeowner + one GC on one build — single-digit
  concurrent requests, read-heavy (dashboards, audit, plan timeline). We size for
  correctness and burst headroom, not throughput.
- **Serverless connection management is the real risk.** Vercel functions ×
  Postgres = connection-storm risk. **Mandatory pooler** (Neon / PgBouncer,
  transaction-mode pooling); services never open raw long-lived connections.
- **Caching (derived reads only):** budget summary, four-pillar status, and
  audit chain-verify are the expensive derivations. Cache them with a short TTL
  **plus explicit invalidation on every ledger append** (an append to a project
  busts that project's cached reads). Serve GET `project` / `plan` / `audit` with
  `stale-while-revalidate`. **`ETag` on the audit read = the head `entry_hash`**,
  so an unchanged ledger returns a cheap `304`. **Mutations are never cached.**
- **Rate limit per party** to keep a runaway client from degrading a shared path.

### 4. Per-endpoint metrics + SLAs, tracked by the Product Analytics Lead

- **Every endpoint emits operational metrics:** latency (p50/p95/p99), error
  rate, throughput, status-code mix — tagged by `service` and `route` so
  degradation is attributable to one service (constraint 1's payoff).
- **Product events** stay on the LINA-28 PostHog spine; **operational metrics**
  are emitted via OpenTelemetry from each service so latency/error SLOs are
  first-class, not inferred from product events.
- **SLO targets (R0):** reads p95 < 200 ms, mutations p95 < 500 ms, chain-verify
  p95 < 1 s at R0 ledger sizes, error rate < 1%.
- **Ownership:** the **Product Analytics Lead owns the endpoint-SLA dashboard +
  alerting spec** (delegated child issue, extending LINA-28). On a sustained SLO
  breach, the alert notifies the **owning service** and the **CEO** directly.

## Consequences

- **Positive:** ownership enforced by grants; the ledger stays the single
  write-guarded source of truth even under per-schema isolation; per-service
  attribution of load and failures; a visible, testable API surface; a named
  owner for SLAs.
- **Negative / debt:** more DB roles and per-schema migration wiring than a
  single flat schema; `SECURITY DEFINER` append function must be reviewed as
  trust-critical code; OpenAPI specs are extra artifacts to keep honest
  (mitigated by contract tests). All accepted for the isolation + observability
  it buys.
- **Revisit when:** any service needs an independent deploy cadence or its own
  DB instance (then the outbox seam ships), or party types multiply
  (Identity feels it first — ADR-0003).
