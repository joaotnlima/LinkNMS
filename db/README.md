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

## How production gets migrated (LINA-62)

The app deploys from `main` automatically via Vercel. Until LINA-62 the schema
did **not**: every production migration was a human remembering to run one, and
code and schema drifted apart silently and asymmetrically — deploys always won,
migrations always lagged, and there was no signal until a request hit the
missing object. That failed on its first real test (PR #12 merged
`0004_ledger_change_order_budget_grant.sql`; production never got it).

`.github/workflows/prod-schema.yml` closes it. On every push to `main`:

1. **migrate** — `node db/migrate.mjs` against the production Neon branch as
   `migrator`. Safe on every push: forward-only, transactional per file,
   checksum-tracked, so with nothing pending it is a no-op by construction.
2. **verify** — `node scripts/check-prod-schema.mjs`, read-only. Fails the run,
   naming the exact file or grant, if production does not match the tree.

It also runs **daily on a schedule** (verify only, never migrate), which catches
a change made directly against the database between merges — a hand-applied
grant widening, say.

**Why GitHub Actions and not a Vercel build step:** a build step is the wrong
home for a privileged DB write — builds are cached (a cache hit skips the step
entirely), can run concurrently for the same commit, and give no ordering
guarantee against the deployment they produce. An Actions job on push-to-`main`
runs once per merge commit, is serialised by `concurrency`, and holds its
credential where a fork PR can never reach it. The workflow is triggered by
`push` only — never `pull_request`.

### Provisioning

| Secret | Scope | Required | What |
| --- | --- | --- | --- |
| `MIGRATOR_DATABASE_URL` | `production` environment | yes | Neon `production` branch, role `migrator`, `?sslmode=require` |
| `READONLY_DATABASE_URL` | `production` environment | no | A read-only role for step 2. Falls back to the migrator if unset. |

Until `MIGRATOR_DATABASE_URL` exists the workflow **fails loudly** on every push
to `main`. That is deliberate: an unprovisioned gate is the state this exists to
make impossible to ignore.

## Checking a live database

```bash
export READONLY_DATABASE_URL='postgres://…?sslmode=require'
node scripts/check-prod-schema.mjs
```

Read-only — every statement is a `SELECT` against a catalog. It asserts:

- every migration file in the checkout is recorded in
  `platform.schema_migrations`, with a matching checksum, and nothing extra;
- `change_order_app`'s `UPDATE` on `ledger.budget_event` is still column-scoped
  to `audit_event_id` (a table-wide `UPDATE` would let the budget move with no
  audit event behind it — never widen this grant to fix a privilege error; fix
  the query);
- no `*_app` role holds any write on `ledger.audit_event`;
- no `*_app` role inherits `neon_superuser` (members bypass `append_event`).

## CI

CI must run, against an ephemeral Postgres, and fail the build on any error:

```bash
node db/migrate.mjs                    # migrations apply cleanly forward
node db/migrate.mjs                    # second run is a no-op (idempotent)
node scripts/check-prod-schema.mjs     # the prod guard, self-tested on every PR
```

The third step is the production guard running against the container CI just
migrated: zero drift and a correct grant matrix must hold there too. It costs
nothing, needs no credential, and means a change that breaks the guard fails
before it reaches `main`.

Verified on Postgres 14 for this slice: all five schemas migrate; `migrator` +
five `*_app` roles created; `append_event` is SECURITY DEFINER and callable only
via EXECUTE; `ledger_app` cannot write `audit_event` directly; `change_order_app`
cannot resolve the `ledger` schema at all; the hash chain verifies against an
independent recompute.
