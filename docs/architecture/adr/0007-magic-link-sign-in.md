# ADR-0007 — Magic-link sign-in (the proof half of the session)

- **Status:** Proposed
- **Date:** 2026-08-29
- **Deciders:** Full-Stack Architect (implementation: Founding Engineer)
- **Context issue:** LINA-75 (child of LINA-26)
- **Supersedes:** nothing. **Completes:** the "Auth (R0)" line of ADR-0001.

## Context

`services/identity/session.mjs` gives us a trustworthy `partyId` that a client
cannot forge: an HMAC-SHA256 token in an httpOnly cookie, with `exp` inside the
signed payload. That is the **verification** half of authentication and it is
production-grade.

The **proof** half — establishing that the person asking for a cookie actually
controls the email address they typed — does not exist. `POST /api/v1/sessions`
currently trades an email for a session with no proof at all, which is why it is
refused with `404` unless `LINKNMS_OPEN_SIGNIN=1`. Failing closed was correct.
The consequence is that production has no door: every R0 functional requirement
is built, merged and test-proven, and no human can reach any of it (LINA-75).

The constraint that shapes this decision: LinkNMS is a *trust* product. The
audit trail's value is that "Dana approved this" means Dana, and only Dana,
approved it. An authentication shortcut is not a UX trade-off here — it is a
direct attack on the thing we sell.

## Decision

Implement magic-link sign-in. No passwords, no IdP, no third-party auth
library in R0.

### 1. The token

A **single-use, short-lived, hashed-at-rest** sign-in token.

- 32 bytes from `crypto.randomBytes`, base64url — the raw token is generated
  once, embedded in the emailed URL, and **never stored**.
- The database stores `sha256(raw)` only. A dump of `identity.sign_in_token`
  must not let the reader sign in as anybody. (Same discipline as
  `identity.invitation`, which already stores a hash and returns the raw token
  exactly once — reuse that pattern, do not invent a second one.)
- TTL **15 minutes**. Long enough to switch to an email client, short enough
  that a link sitting in a mailbox is not a standing credential.
- **Single use.** Consumption is an atomic conditional `UPDATE ... WHERE
  consumed_at IS NULL RETURNING ...`. If it returns no row, the token was
  already used — reject. Never `SELECT` then `UPDATE`: that is a race that hands
  two sessions to one link.

### 2. New surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/sessions/request` | Body `{ email, displayName? }`. Mints a token, sends the email. **Always** `202 {}` — see (4). |
| `POST` | `/api/v1/sessions/consume` | Body `{ token }`. Verifies + consumes, finds-or-creates the party, mints the session cookie. `201` with the same body shape `POST /sessions` returns today. |

`GET /sign-in` posts to the first. A new page `GET /auth/callback?token=…`
posts to the second and redirects to `next`. The token travels in a **query
param on a page we control**, and that page must send
`Referrer-Policy: no-referrer` so the token never leaks in a referer header to
a third party.

`POST /api/v1/sessions` (the no-proof route) **stays exactly as it is** —
flag-gated, `404` by default. It is what makes preview/demo environments
possible without weakening production, and LINA-75's acceptance walkthrough
depends on it. Do not delete it and do not widen it.

### 3. Invitations compose, they do not duplicate

The GC arrives via an invite token (`identity.invitation`), which already
proves *the invitation*, not *the person*. The GC must still prove their email.
Order of operations:

1. GC opens the invite link → `/invitations/accept?token=…`.
2. Not signed in → redirect to `/sign-in?next=/invitations/accept?token=…`.
3. Magic link proves the email, mints the session.
4. `POST /api/v1/invitations/:token/accept` runs with a real acting party.

So invite acceptance keeps requiring a session, exactly as
`services/identity/http.mjs` already demands. **No new "invite implies
identity" path** — that would let anyone who forwards an invite email join as
themselves *and* look authorised on the record.

### 4. Enumeration and abuse

- `POST /sessions/request` returns `202` with an empty body **whether or not
  the email is known**. A distinguishable response turns sign-in into a
  "is this person on this build?" oracle.
- Rate limit per email and per IP (suggested: 5 requests / 15 min / email).
  Because a serverless deploy has no shared memory, the counter lives in
  Postgres alongside the tokens — a `COUNT(*)` over recent rows for that email
  is sufficient and needs no new infrastructure.
- The per-IP key must come from a hop the **client cannot forge** (amended,
  LINA-79). A proxy *appends* the address it observed, so the LEFT-most
  `x-forwarded-for` entry is the caller's own claim about itself: keying on it
  lets an attacker mint a fresh counter per request, which is worse than no
  per-IP limit at all because it reads as protection it does not provide. Derive
  it instead from `x-vercel-forwarded-for`, then `x-real-ip`, then the
  RIGHT-most `x-forwarded-for` entry — all written by our own proxy — and reject
  anything that is not a well-formed address, so junk cannot buy its own bucket
  (`services/gateway/client-ip.mjs`). With no proxy in front no header is
  trustworthy and the value is `null`; the per-IP counter is then simply skipped.
  Nothing security-critical may key off this value — the **per-email** limit is
  what protects a given person's inbox.
- Consumption failures (`expired`, `already used`, `unknown`) all return the
  same `400 invalid_token`. The user-facing copy says "this link is no longer
  valid — request a new one".

### 5. Delivery

Reuse **Resend**, already integrated at `marketing-site/src/lib/email.ts` for
the waitlist. Lift the client into a small shared sender rather than adding a
second provider. `RESEND_API_KEY` is a new required production env var.

**Fail closed, loudly.** If `RESEND_API_KEY` is absent, `/sessions/request`
returns `503`, and it must **never** fall back to logging the link or returning
it in the response — a "dev convenience" that reaches production is an open
sign-in with extra steps. (`marketing-site` currently degrades gracefully when
Resend is unconfigured; that is right for a waitlist signup and wrong here.
Do not copy that branch.)

### 6. What does not change

The authorship and approval stamps are untouched. Sessions still carry only a
`partyId`; every handler still reads the actor from the session and never from
the body (ADR-0004); `ledger.append_event` remains the only write path. This
ADR adds a door — it does not touch the record behind it.

## Consequences

- **Good:** production gets a real front door; the demo flag stays a demo flag;
  no new vendor; the token discipline already proven by `identity.invitation` is
  reused rather than re-derived.
- **Cost:** one new table, two endpoints, one page, one env var. Email delivery
  becomes a production dependency of sign-in — if Resend is down, nobody new can
  sign in (existing 30-day cookies keep working).
- **Debt accepted:** no "remember this device", no session revocation list, no
  account recovery beyond "request another link". All are additive later; none
  block R0.

## Out of scope

Full IdP / SSO, org-level accounts, MFA, and password fallback. R0 is one
homeowner and one GC.
