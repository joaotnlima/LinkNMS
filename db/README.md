# Database platform & migrations (R0 Slice 0)

Schema-per-service isolation, role-enforced ownership, and a forward-only
migration runner. Design: ADR-0006 §1 (schema-per-service + roles/grants),
ADR-0002 §4 (the write-guarded audit trail).

## Layout

```
db/
  roles.sql          # migrator (DDL owner) + one <service>_app role per service — idempotent
  0001_platform.sql  # platform.schema_migrations + the five service schemas + USAGE grants
  migrate.mjs        # forward-only runner (zero npm deps; drives psql)
services/<svc>/migrations/NNNN_*.sql   # per-service DDL + least-privilege table grants
```

Five service schemas — `identity`, `decision`, `change_order`, `ledger`,
`schedule` — one per service. No cross-schema SELECT: each `<service>_app` role
gets `USAGE` on its own schema only.

## Role & ownership model (enforced by Postgres, not convention)

- **`migrator`** owns every schema, table, and SECURITY DEFINER function and is
  the only role that runs DDL. Migrations connect as this role (prod: the
  provisioned owner; Neon pre-authorizes `pgcrypto`).
- **`<service>_app`** (e.g. `ledger_app`) is the runtime role a serverless
  function connects with. Least privilege on its own schema; nothing on a
  sibling. Created NOLOGIN + passwordless here — credentials are attached
  out-of-band from the secret manager. **No passwords in the repo.**

### The audit trail is write-guarded (ADR-0002 §4)

`ledger.audit_event` is append-only and hash-chained. **No role holds raw
INSERT/UPDATE/DELETE** on it — not even `ledger_app`. The only writer is
`ledger.append_event(...)`, a SECURITY DEFINER function owned by the migrator;
app roles get `EXECUTE` on it and `SELECT` on the trail. Each event's
`entry_hash = sha256(prev_hash || payload_hash)` links it to its predecessor, so
any silent edit/delete/reorder breaks every downstream link. `payload_hash` is
the canonical-JSON sha256 computed by the shared JS core
(`services/ledger/hash-chain.mjs`) and passed in — never re-implemented in SQL.

## Running migrations

```bash
# migrator connection string from the secret manager (never committed)
export MIGRATOR_DATABASE_URL='postgres://…?sslmode=require'
node db/migrate.mjs            # apply all pending, forward-only
node db/migrate.mjs --dry-run  # list pending without applying
```

Each file applies inside one transaction; its filename + sha256 are recorded in
`platform.schema_migrations` so it never re-runs. Applied files are immutable —
editing one is a checksum error, not a silent re-apply. **Add a new migration;
never edit an applied one.**

## CI

CI must run, against an ephemeral Postgres, and fail the build on any error:

```bash
node db/migrate.mjs      # migrations apply cleanly forward
node db/migrate.mjs      # second run is a no-op (idempotent)
```

Verified on Postgres 14 for this slice: all five schemas migrate; `migrator` +
five `*_app` roles created; `append_event` is SECURITY DEFINER and callable only
via EXECUTE; `ledger_app` cannot write `audit_event` directly; `change_order_app`
cannot resolve the `ledger` schema at all; the hash chain verifies against an
independent recompute.
