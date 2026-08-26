# Tooling, Integrations & Cost — R0

- **Status:** Proposed (awaiting CEO approval) — companion to the Architect's ADRs
- **Owner:** Founding Engineer
- **Date:** 2026-08-25
- **Context issue:** LINA-26 (R0)
- **Companion to:** [ADR-0001 Stack](./adr/0001-stack-and-platform.md) · [ADR-0003 Boundaries](./adr/0003-service-boundaries.md) · R0 technical design (Architect, in progress)

This doc owns the part of the plan the CEO assigned to me: **which concrete tools
and integrations we pick, why, and what they cost** — optimizing hard for
free / open-source, on Vercel. The Architect owns the data model, API contracts,
ADRs and the trust-critical design; this is the build-cost + integrations layer
underneath those decisions. Nothing here is adopted until the CEO approves.

---

## 1. Guiding rules (from my mandate)

1. **Free / open-source first.** Every pick must have a $0 tier that carries R0
   (one homeowner + one GC, one build) and an open-source or portable escape
   hatch so we are never locked in.
2. **No paid or irreversible commitment without CEO approval.** The table below
   flags each line as **$0** or **needs-approval**.
3. **Portable, not captured.** Prefer managed *Postgres* (standard SQL, dumpable)
   over proprietary datastores; prefer standards (S3 API, SMTP) over lock-in.
4. **Fewer moving parts wins at R0.** Every integration is operational surface;
   we add one only when a functional requirement needs it.

---

## 2. Integration map

```
                         ┌──────────────────────────┐
     Browser  ─────────► │  Next.js on Vercel        │
   (homeowner / GC)      │  (SSR UI + Route Handlers) │
                         └────────────┬──────────────┘
                                      │
        ┌─────────────────┬──────────┼───────────────┬──────────────────┐
        ▼                 ▼          ▼                ▼                  ▼
  ┌───────────┐   ┌──────────────┐  ┌───────────┐  ┌──────────────┐  ┌──────────┐
  │ Postgres  │   │ Object store │  │ Email      │  │ PostHog       │  │ Sentry   │
  │ (Neon)    │   │ (plan/docs   │  │ (magic-    │  │ (product      │  │ (errors, │
  │ system of │   │  uploads —   │  │  link      │  │  analytics —  │  │  optional│
  │ record +  │   │  NEW scope)  │  │  invites)  │  │  LINA-28)     │  │  R0)     │
  │ ledger    │   └──────────────┘  └───────────┘  └──────────────┘  └──────────┘
  └───────────┘
```

Everything runs on Vercel's platform primitives where possible; each external
line has a $0 tier and a portable exit.

---

## 3. Decision table (pick · why · cost · exit)

| Concern | Pick (R0) | Why this, not the alternative | Cost @ R0 | Portable exit |
|---|---|---|---|---|
| **Hosting / compute** | **Vercel** (CEO direction) | Native to Next.js; preview deploys per PR; $0 Hobby tier covers R0 | **$0** (Hobby) | Standard Next.js → any Node host / container |
| **System of record** | **Neon Postgres** | Serverless Postgres, generous free tier, DB **branching** (a branch per preview deploy), scale-to-zero. Plain Postgres = dumpable, no lock-in | **$0** (free tier) | `pg_dump` → any Postgres (Supabase, RDS, self-host) |
| **DB — alt considered** | Vercel Postgres | Same Neon engine, billed through Vercel; tighter Vercel integ but less free headroom & branching control | — | same (it *is* Neon) |
| **DB — alt considered** | Supabase | Adds auth+storage+realtime in one; but we don't need its auth/realtime in R0 and it pulls more surface than a plain DB | — | Postgres dump |
| **Data access** | **`postgres.js`** + checked-in SQL migrations | ADR-0001: no heavyweight ORM; ledger rules are explicit auditable SQL. OSS, tiny | **$0** OSS | plain SQL, no framework lock-in |
| **Object storage** (plan/photos/docs — **new scope**) | **Vercel Blob** for R0, **S3-API** shape | GC uploads the construction plan + homeowner sees documents → we need file storage. Vercel Blob = zero-config on Vercel, free tier. Keep the access behind an S3-style interface so we can move to Cloudflare R2 (zero egress) or S3 later | **$0** (free tier) | S3-compatible API → R2 / MinIO / S3 |
| **Auth / sessions** | **Magic-link invite tokens** (ADR-0001), our own signed cookie sessions | R0 has 2 parties; a full IdP is overkill. Token-in-email + httpOnly cookie is minimal and OSS-only | **$0** | swap to Auth.js / Clerk behind the same session interface later |
| **Transactional email** (invites, magic links) | **Resend** free tier (3k/mo) | Cleanest DX, generous free tier; we send only invites/magic-links in R0 | **$0** (free tier) | any SMTP/provider behind one `sendEmail()` port |
| **Product analytics** | **PostHog Cloud** free tier (LINA-28) | Analytics Lead owns the event spec; PostHog is OSS + 1M events/mo free; self-hostable if we ever need to | **$0** (free tier) | PostHog is OSS → self-host |
| **Error monitoring** | **Sentry** free tier — *optional in R0* | Nice-to-have for a trust product; free tier is fine. Cut if we want zero extra surface at R0 | **$0** (free tier) | OSS, self-hostable |
| **CI / checks** | **Vercel preview builds + typecheck/test in the build step** | The repo already dropped GitHub Actions in favour of Vercel builds; we run `typecheck → test → build` as the Vercel build gate + a preview URL per PR | **$0** | add GitHub Actions later if we want checks off the deploy path |
| **Repo / VCS** | **GitHub** (existing) | Already in use (`joaotnlima/LinkNMS`) | **$0** | — |

**Net R0 run cost: $0/month.** Every line sits on a free tier that comfortably
covers one build with two parties. Nothing here needs a card.

---

## 4. What needs CEO approval before we adopt it

Per my mandate (no paid/irreversible commitment without approval), flagging the
lines that *could* later cost money or add lock-in, even though R0 is $0:

| Item | Why flag it | R0 status |
|---|---|---|
| Neon vs Vercel Postgres | Both are Neon; the billing relationship differs. Recommend **Neon direct** for branching + free headroom | recommend, needs OK |
| Vercel Blob for uploads | New scope (construction plan). Free tier now; storage/egress can cost at scale → keep the S3 interface | recommend, needs OK |
| Resend for email | Free tier now; volume could cost later | recommend, needs OK |
| Sentry | Extra vendor; optional at R0 | **propose to defer** unless CEO wants it |

Everything else is either CEO-directed (Vercel) or pure OSS with a self-host exit.

---

## 5. New-scope impact (construction plan → timeline / progress)

The CEO's 2026-08-25 direction expands R0 beyond the decision/change-order core:
the **GC uploads/enters the construction plan**, and the **homeowner sees a
timeline of stages, dates, scope, cost and progress**. From a tooling/integration
standpoint that adds exactly two things to the picture above:

1. **Object storage** (Vercel Blob / S3-shape) — to hold the uploaded plan file
   and any stage documents/photos. Added to the table above.
2. **A Schedule / Progress capability** — stages, planned dates, and
   percent/stage-status progress. This is a **new bounded service** in the
   Architect's ADR-0003 sense (owns `stage`, `stage_progress` tables); it reads
   membership for authz and reads the ledger/budget for the cost pillar, but owns
   its own schedule data. **This is the Architect's data-model call** — I'm
   flagging it as the integration/infra consequence so the plan is sized right.

No new *vendor* is required for the timeline itself — it's Postgres data rendered
by the Next.js UI. The only genuinely new infra is file storage.

---

## 6. Ways of working (so we don't repeat the miss)

1. **Plan → approve → delegate → build.** No implementation code until the CEO
   approves the combined plan (Architect's ADRs + R0 design + this cost doc) on
   LINA-26. The earlier `app/` prototype is a throwaway spike, kept only as
   domain reference.
2. **On approval, I decompose the design into delegated child issues** for the
   developers (one per bounded service + UI surfaces + the tracking/PostHog
   wiring), each with clear acceptance and the ADR it implements. I own the
   delegation and the dev environment / CI; the Architect owns the design the
   issues implement.
3. **Cost stays visible.** Any move off a $0 tier comes back to the CEO before we
   incur it.

---

## 7. Open question for the CEO

The Architect's ADR-0001 leaves one thing for you to rule on: **how literally to
take "micro-service-oriented" in R0** — bounded services behind interfaces on
**one shared Postgres** (recommended: real seams, no distributed-systems tax
now), vs. **separately deployed services each with its own DB** (true
micro-services, but eventual-consistency + distributed-transaction cost across
the exact budget math that must be exact, at zero volume benefit). My engineering
recommendation matches the Architect's: **bounded services on one Postgres now,
extract later.** We'll record whichever you choose.
