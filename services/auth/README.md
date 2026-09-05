# `services/auth` — retired (LINA-189)

**There is no auth service. This directory contains migration history and nothing else.**

It once held a Clerk-backed RBAC implementation (`can()`, the webhook sync, the
profile service, a Postgres store over the `authz` schema) built for `apps/api`
— a standalone Fastify API that was designed, built, tested, and **never
deployed to anything**. Its `authz` tables sat in production holding a seeded
permission catalog and zero users, while every real request was authorized by
`identity.membership` + `services/identity/authz.mjs` (ADR-0004).

`migrations/0004_authz_retire.sql` drops the schema. That file is worth reading
before re-litigating any of this — it explains why three parallel authorization
models was the risk, not the redundancy.

## Why the directory still exists

The migration runner (`db/migrate.mjs`) is **forward-only**: it records every
applied file by name and SHA-256, and `scripts/check-prod-schema.mjs` fails the
build if production reports a file the tree no longer has. `0001`–`0003` are
applied in production, so they are immutable history. Deleting them would not
delete the past; it would only break the detector that tells us the past is
still what we think it is.

So: **do not delete `migrations/`, and do not edit anything in it.** Removing
this history properly means squashing the whole chain and re-baselining every
environment, which is a deliberate project and not a cleanup.

## Where the live code went

| What you might be looking for | Where it is now |
|---|---|
| Account setup (`POST /me/profile`) | `services/identity/identity.mjs` → `completeProfile`, routed at `app/src/app/api/v1/me/profile/route.ts` |
| "May this party do this?" | `services/identity/authz.mjs` (`can`), over `identity.membership` |
| Who is acting | `app/src/server/session.ts` — Clerk → verified email → `identity.party` |

If organisations ever become a product concept and an org/role/permission
catalog is genuinely needed, that is a fresh design decision — not a matter of
reviving what is buried here.
