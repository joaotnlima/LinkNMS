# LinkNMS — Marketing Site + Waitlist

Fast, credible, multilingual (**pt-PT · EN · es-ES**) landing page whose single
conversion goal is a **verified email** on the waitlist. Built to the approved
plan (LINA-29 v2) and stack decision (LINA-34).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + TypeScript |
| i18n | next-intl — `/pt /en /es` path routing, auto-detect, cookie-persisted |
| Waitlist DB | Neon Postgres via Drizzle ORM |
| Email | Resend (localized double opt-in) |
| Analytics | PostHog (EU cloud) |
| Anti-spam | Cloudflare Turnstile + honeypot + disposable blocklist + unique index |
| Hosting | Vercel (prod = `main`, preview per PR) |

Everything is free-tier / OSS. The site **builds and runs with no env vars** —
each integration degrades gracefully (no DB → not persisted but funnel testable;
no Resend → confirmation link logged; no Turnstile → skipped; no PostHog → noop).

## Develop

```bash
npm install
cp .env.example .env.local   # fill in what you have; all optional in dev
npm run dev                  # http://localhost:3000 → redirects to /pt|/en|/es
npm run typecheck
npm run build
```

## Waitlist flow (double opt-in)

```
POST /api/waitlist  → honeypot + Turnstile + normalize/dedupe → insert 'unconfirmed'
                    → Resend localized email with tokenized link → "check your inbox"
GET  /api/confirm?token=…  → mark 'confirmed' → PostHog waitlist_verified → localized thank-you
```

`{verified}/150 = select count(*) from signups where status='confirmed'`; pace,
locale and source are group-bys. The app DB is the source of truth.

## Content

All page copy lives in `src/messages/{pt,en,es}.json`. Transactional email copy
lives in `src/lib/email.ts`. Brand tokens/marks mirror `cowork/design`
(BRAND.md / marketing-site/DESIGN.md): Paper canvas, Ink type, Owner Blue /
Builder Orange as the two sides. Only **tamper-evident** is used — never
"tamper-proof".

## Database

```bash
npm run db:generate   # regenerate migration from src/lib/db.ts (drizzle-kit)
npm run db:migrate    # apply to DATABASE_URL
```

A ready-to-run migration is committed at `drizzle/0000_init.sql`.

## Deploy (Vercel)

Set the project root to `marketing-site/`. Add env vars from `.env.example`
(`DATABASE_URL`, `RESEND_API_KEY`, `POSTHOG_KEY`, `TURNSTILE_*`,
`NEXT_PUBLIC_SITE_URL`). `main` → production; every PR gets a preview URL (used
for the es-ES native review).
