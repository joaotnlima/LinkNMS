# ADR-0022 — Two-pipeline delivery: a `dev` staging environment

- **Status:** Accepted
- **Date:** 2026-09-12
- **Issue:** LINA-267
- **Owner:** Full-Stack Architect

## Context

Until now LinkNMS had a single pipeline: merge to `main` → Vercel deploys
`portal.linknms.com` from the `app/` root → `prod-schema.yml` applies pending
migrations to the Neon `production` branch. Every change was validated only in
CI (in-memory + a throwaway Postgres container) and then went straight to
production. There was no shared, always-on place to change and break things
against a real Postgres and a real deployed URL without risking prod.

The founder asked for a second pipeline: a `dev` branch that deploys to
`dev.portal.linknms.com`, backed by a separate Neon database branch, so the team
develops and validates in `dev` **before** promoting to production.

## Decision

Run **two pipelines** off the same `linknms-portal` Vercel project and the same
Neon project (`nameless-sound-23700343`), distinguished by git branch:

| | **prod** | **dev (staging)** |
|---|---|---|
| Git branch | `main` | `dev` |
| Vercel target | Production | Preview (branch-pinned) |
| URL | `portal.linknms.com` | `dev.portal.linknms.com` |
| Neon branch | `production` (`br-tiny-darkness-zaqxacz3`) | `dev` (`br-purple-thunder-zal04jio`) |
| Neon endpoint host | `ep-mute-sky-zaq70b4s…` | `ep-soft-hall-zacvct6x…` |
| Schema gate | `.github/workflows/prod-schema.yml` (push → `main`) | `.github/workflows/dev-schema.yml` (push → `dev`) |
| Migrator secret | `MIGRATOR_DATABASE_URL` @ GitHub env `production` | `MIGRATOR_DATABASE_URL` @ GitHub env `development` |

This mirrors the pre-existing (half-wired) `demo` branch pattern — Vercel
branch-pinned preview env vars plus a parented Neon branch — and completes it for
`dev`. The `dev` Neon branch is created **from** `production`, so it starts as a
byte-faithful copy of prod's schema (45 migrations) and roles
(`migrator`, `ledger_app`, `change_order_app`, `decision_app`, `identity_app`).

### Vercel env (branch-pinned to `dev`, target = Preview)

- `DATABASE_URL` → Neon `dev` branch, role `migrator`, db `neondb`.
- `CHANGE_ORDER_DATABASE_ROLE=change_order_app`, `DECISION_DATABASE_ROLE=decision_app`,
  `IDENTITY_DATABASE_ROLE=identity_app`, `LEDGER_DATABASE_ROLE=ledger_app` — the
  app connects as `migrator` then `SET ROLE`s into these per service (unchanged
  from prod).
- `SESSION_SECRET` — a **fresh** secret for `dev`, not prod's.
- `APP_BASE_URL=https://dev.portal.linknms.com`.
- Clerk (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) and PostHog are
  set at the **Preview** scope (no branch pin), so `dev` inherits them
  automatically — it shares the **production Clerk instance and user pool**. This
  is the v1 trade-off (see Consequences); the removed `LINKNMS_OPEN_SIGNIN`
  no-proof demo door is **not** carried over.

### DNS

`linknms.com` runs on Cloudflare nameservers; `portal.linknms.com` is a CNAME to
Vercel. `dev.portal.linknms.com` needs the same: a Cloudflare DNS record
**CNAME `dev.portal` → `cname.vercel-dns.com`, DNS-only (grey cloud, not
proxied)**. The R2-scoped Cloudflare token available to the engineering agents
cannot edit DNS zones, so this one record is a founder action (tracked on
LINA-267). Until it exists, the `dev` deploy is still reachable at its
`*.vercel.app` preview URL.

> Note: the older `demo.linknms.com` Vercel domain has the **same** missing
> Cloudflare record and has never resolved — worth cleaning up or completing
> alongside this.

## Consequences

- **Promotion flow (new team norm):** feature branch → PR → merge to `dev` →
  validate on `dev.portal.linknms.com` → PR `dev` → `main` → prod. CI
  (`ci.yml`, `quality-gate.yml`) runs on **all** PRs, so both hops are gated.
- **Migrations** reach the dev Neon branch via `dev-schema.yml` on push to `dev`,
  exactly as `prod-schema.yml` does for prod — the forward-only runner is a no-op
  when nothing is pending.
- **Shared Clerk pool** means dev logins are real prod identities. Acceptable for
  staging now; a dedicated Clerk *development* instance is a clean follow-up.
- **Drift risk:** `dev` can diverge from `production`. Re-create the `dev` Neon
  branch from `production` (a one-call reset) whenever a clean baseline is wanted.
- **Cost:** one extra Neon branch on the free plan (3 total) and preview build
  minutes — negligible at this stage.
