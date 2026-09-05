# `services/waitlist` — retired (LINA-189)

**There is no waitlist service. This directory contains migration history and nothing else.**

There were two waitlists:

| | |
|---|---|
| **`landing.signups`** | The marketing site's funnel at **linknms.com**. Double opt-in, confirmation email, plan + persona, and the founding-seat claim that actually admits someone. **This is the waitlist.** |
| `waitlist.signup` | This one, behind `portal.linknms.com/waitlist`. Captured an email and an ordinal and did nothing further with either: no confirmation, no seat, no path into the product. **Zero rows, ever.** |

Two places to look for "who asked for access" is one too many when the answer
has to be trustworthy — and the duplicate was the one that looked like a funnel
and dead-ended. `migrations/0003_waitlist_retire.sql` drops the schema.

The portal's `/waitlist` page is **redirected**, not deleted (see
`app/next.config.mjs`): an existing link or bookmark now lands on the funnel
that works instead of on a 404.

## Why the directory still exists

`db/migrate.mjs` is forward-only and records each applied file by name and
SHA-256; `scripts/check-prod-schema.mjs` fails if production reports a file the
tree no longer has. `0001` and `0002` are applied in production and are
therefore immutable history. **Do not delete `migrations/`, and do not edit
anything in it.**

## Changing the waitlist

Everything lives in the marketing site:

- form — `marketing-site/src/components/WaitlistForm.tsx`
- capture — `marketing-site/src/app/api/waitlist/route.ts`
- confirm + seat claim — `marketing-site/src/app/api/confirm/route.ts`
- seats — `marketing-site/src/lib/seats.ts`
