# db/v2 — to-be database model (executable)

The to-be model from `cowork/documentation/to-be/15-data-model.md` as runnable PostgreSQL 16 DDL, a
seed of the "Casa Silva" scenario, and checks that prove the rules hold.

| File | What it is |
|---|---|
| `0001_schema.sql` | 13 schemas (one per module), 72 tables, no cross-schema FKs. Append-only guards, BoQ freeze after signature, hash-chained ledger writer `record.append_event()`. |
| `seed_casa_silva.sql` | The scenario of doc 15 (orgs, contracts, BoQ on tasks, WBS, links, baselines, variations, proposal lanes, ledger). Ids come from readable aliases: `seed.id('org.silva')`. |
| `checks.sql` | Prints the per-viewer projections (V2/V3/V5/V7, D-27, D-33, D-36), verifies the ledger chain, then attempts 8 forbidden writes that must all fail. |
| `checks.expected.txt` | The expected output. |
| `verify.sh` | Creates a throwaway DB, runs everything, diffs against the expected output. |

```bash
DATABASE_URL=postgres://postgres@localhost:5432/postgres ./db/v2/verify.sh
```

**Status:** live (LINA-308 pivot). `0001_schema.sql` is enumerated by the migration runner
(`db/migration-files.mjs`) as the v2 bootstrap — one verified, forward-only unit applied after the
v1 service migrations. It does not touch the as-is tables (the shared schema *names* `platform` and
`identity` are additive: `CREATE SCHEMA IF NOT EXISTS`, no table collisions — proven against a
production copy on the Neon `pivot` branch). Subsequent v2 DDL goes in per-module forward
migrations under `modules/<module>/migrations/NNNN_*.sql`, which the runner also enumerates.
`seed_casa_silva.sql` and `checks.sql` are test artefacts, never migrations.

**Rule:** a change to the model changes `15-data-model.md`, this DDL and the seed in the same commit,
and `verify.sh` must still pass.
