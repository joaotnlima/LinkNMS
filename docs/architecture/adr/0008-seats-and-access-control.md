# ADR-0008 — Seats: who is allowed through the door

- **Status:** Proposed
- **Date:** 2026-08-30
- **Deciders:** Full-Stack Architect (raised by the CEO on LINA-75)
- **Context issue:** LINA-75 (child of LINA-26)
- **Builds on:** ADR-0007 (magic-link sign-in), ADR-0004 (permission model).
- **Does not touch:** ADR-0002 (the audit ledger).

## Context

ADR-0007 answered **"is this person who they say they are?"** — prove you control
an email address, get a session. It is implemented, merged, and live.

It does not answer **"is this person allowed here at all?"**, and those are
different questions. Today `consume` ends in `parties.findOrCreateByEmail`: the
address is created as a party if it does not exist. Combined with a working
mailer, that is **open registration** — anyone on the internet with any inbox can
sign in and hold a party on a product whose entire proposition is that a name
against a decision means something.

That has not bitten us only because `RESEND_API_KEY` is unset on production, so
`/sessions/request` fails closed with `503`. In other words the thing currently
protecting us from open registration is a *missing environment variable*. That is
not an access model; it is an accident. Setting one config value would silently
open the front door to everybody, which is precisely the kind of failure that
should be impossible by construction rather than avoided by remembering.

The CEO's rollout (LINA-75, 2026-08-29) makes the requirement explicit:

> the first 10 users I will give away free seats through a magic link. After that
> I want the users to pay (using stripe) for their seats.

So there are two questions, and they want different answers at different times:
**authentication** is settled forever by ADR-0007, while **entitlement** starts as
a hand-written list of ten and later becomes a billing system. Any design that
fuses them means rewriting the auth path when Stripe lands — on a trust product,
touching the sign-in path for a billing reason is exactly the change you do not
want to make.

## Decision

**A seat is the unit of access. Authentication proves who you are; a seat decides
whether you may come in; membership decides what you may do.** Three separate
questions, three separate mechanisms, and none of them is allowed to imply
another.

### 1. `identity.seat` — a table, not a flag

One row per address permitted through the front door
(`services/identity/migrations/0004_identity.sql`), keyed on the **email** rather
than on `identity.party.id` — the seat's whole job is to decide whether a party
may be created at all, so it must exist before the party does.

It carries `source` (`beta` | `invite` | `stripe`), a `status` of `active` or
`revoked`, and a free-text `note`.

### 2. The gate sits in `request`, not in `consume`

`POST /sessions/request` mints and mails a link **only** for an address holding
an active seat. An unseated address is a silent no-op that still answers `202 {}`.

Gating at `consume` instead would mail a real, working-looking link to an
unseated stranger and then reject it — wasting a send, producing a baffling
experience, and confirming to a prober that the address is real. Declining at
mint costs one indexed lookup and leaks nothing.

**The allowlist must never become a membership oracle.** ADR-0007 §4 established
that `/request` answers identically for known and unknown addresses. Seats keep
that property exactly: seated and unseated both resolve to the same `202`, and
there is a test whose only job is to assert those two responses are
indistinguishable. If we ever let "no seat" produce a distinct status or message,
`/request` becomes a free "does this person use LinkNMS" probe.

### 3. `identity_app` may read seats and may not write them

The application role holds `SELECT` on `identity.seat` and nothing else —
narrower than any other identity table, deliberately. The running app can ask who
is allowed in; it cannot seat anybody. Even a full compromise of the request path
cannot widen who may sign in. Seats are issued out of band by
`scripts/grant-seat.mjs` running as the migrator, and later by the billing
webhook under its own role.

### 4. Counterparties do not consume a beta seat

When a project owner invites their GC, that GC is seated with `source='invite'`.
They ride in on somebody else's project and are **not** counted against the ten.

This is a product judgement as much as a technical one, and it is the one line in
this ADR the CEO and PM should push back on if they disagree. The reasoning: a
homeowner cannot use LinkNMS alone — the product *is* the shared record between
two parties. If the GC needed their own seat, every giveaway would really be half
a giveaway, and the ten pilots would stall on the first invitation. It also gives
the later billing model its natural shape: **you pay for the projects you run,
not for being invited into someone else's.** That is both easier to sell and the
thing that makes the product spread.

### 5. A seat is not a role and confers no authority

Holding a seat lets you sign in. It grants no project access whatsoever.
Authorisation remains per-project membership (ADR-0004) — the acting role is a
property of the membership, never a global attribute of the person. A test
asserts that consuming a link from a seated address still produces a plain
default party with no elevated role.

### 6. Revocation is a status flip, never a delete

Revoking shuts the door on future sign-ins. It does **not** retroactively touch
anything the person did: their authorship and approval stamps in the ledger are
immutable and stay exactly as they are. "This person's access was withdrawn"
and "this person never approved that change order" are entirely different
claims, and the second one must never become expressible by an administrative
action. Access control is a live question; the audit trail is history, and
history does not change when a seat is withdrawn.

### 7. Stripe, when it comes

Nothing in the auth path changes. The billing webhook inserts `source='stripe'`
seat rows on subscription start and flips `status='revoked'` on cancellation.
The sign-in code continues to ask one question — *is there an active seat for
this address* — and never learns what a subscription is. Pricing, trials and
proration are the PM's and CEO's call and are explicitly **not** decided here.

This is the payoff for making seats a table: the migration from "ten hand-written
rows" to "a paid product" is a new writer against an existing table, not a change
to authentication.

## Consequences

**Good.** Setting `RESEND_API_KEY` on production stops being dangerous, which
unblocks GA. The ten-seat giveaway is a first-class, auditable list rather than a
spreadsheet. The Stripe seam is drawn before any billing code exists, so it will
not be drawn under deadline later. The blast radius of a request-path compromise
does not include "grant yourself access".

**Costs and things we are accepting.**

- *An unseated request accrues no rate-limit row.* The gate is checked before the
  rate-limit counters (it is cheaper), so requests for unseated addresses are not
  counted. Acceptable: such a request writes nothing and sends nothing, so the
  only exhaustible resource is our own request budget, not a user's inbox. If
  that ever matters, the fix is edge rate-limiting, not reordering the checks.
- *Seat administration is a CLI, not a screen.* For ten users a UI would be more
  code than the thing it administers. This will need revisiting before seats are
  self-service.
- *Invite-by-email does not exist yet.* `identity.invitation` is a bearer token
  with no address on it, so nothing can currently seat a GC automatically —
  today the GC must be granted a seat by hand like anyone else. Closing this is
  the one piece of §4 that is designed but unbuilt, and it is delegated as a
  follow-up.
- *The demo environment bypasses all of this*, as it should:
  `LINKNMS_OPEN_SIGNIN=1` is a separate door that exists only on the demo branch
  and mints sessions without proof or seat. It must never be set on production —
  a constraint that predates this ADR and survives it unchanged.

## Alternatives rejected

**A boolean on `identity.party`.** Cannot work: the gate has to decide whether to
create the party in the first place, so the flag would not exist yet at the
moment it is needed. It would also fuse entitlement into identity and force the
Stripe integration to write to the party table.

**Domain allowlisting.** The ten pilots are individuals at unrelated companies
using consumer email; a domain list is both too coarse and, for `gmail.com`,
equivalent to no gate at all.

**An invite-code the user types.** Another bearer secret to mint, mail, store and
expire — for a list of ten. The magic link is already the bearer secret; adding a
second one doubles the attack surface to solve a problem a `SELECT` solves.

**Gate at `consume`.** Rejected in §2: it mails live links to strangers and turns
the callback into an oracle.

**Ship open registration now and add billing later.** The failure mode is
irreversible in the way that matters — parties created by strangers on a trust
product, in the ledger, in the demo the CEO shows people.
