# ADR-0013 — Plan entitlements: how many builds a seat may run

- **Status:** Accepted
- **Date:** 2026-09-08
- **Deciders:** Full-Stack Architect (raised by the CEO on LINA-189)
- **Context issue:** LINA-189 ("I can also choose one of the owner plans (up to 1 project)")
- **Builds on:** ADR-0008 (seats), ADR-0004 (permission model), ADR-0011/0012 (build creation).
- **Does not touch:** ADR-0002 (the audit ledger). An entitlement is commercial
  access, not project history — the same rule ADR-0008 set for seats.

## Context

Since LINA-173 the landing page has sold an explicit allowance on every plan
card:

| Plan | Card says | Persona |
|---|---|---|
| `free_founding` | the founding 50 | either |
| `personal` | 1 active project | owner |
| `build_plus` | 10 active projects | owner |
| `real_estate_investor` | Unlimited projects | owner |
| `independent_builder` | Up to 3 active projects | builder |
| `growing_builder` | Up to 10 active projects | builder |
| `construction_business` | Unlimited projects | builder |

Nothing had ever read it. The plan a visitor chose was written to
`landing.signups.plan` — a column in the **marketing site's** schema, which the
portal does not read — and stopped there. `createProject` asked the ADR-0004
authorizer whether the caller may create a build and never asked what they had
bought, so every tier was, in fact, unlimited. The pricing page described a
product that did not exist.

That is the same class of defect as the hardcoded `18 / 50` seat counter this
issue started with: a number typeset on a page with nothing behind it.

## Decision

**The plan rides on `identity.seat`, and what the plan buys lives in code.**

This adds the third leg to ADR-0008's split, which now reads in full:

| Question | Answered by |
|---|---|
| authentication — who are you | Clerk |
| **entitlement — what did you buy** | **`identity.seat` (`plan`)** |
| authorization — what may you do *here* | `identity.membership` + `authz.mjs` |

### Why the seat, and not the party or a new table

- The seat is **already** the entitlement record. "May you come in at all" and
  "what did you buy" are one commercial fact; two rows that can disagree about
  it is exactly the drift this product exists to prevent.
- The seat is keyed on **email**, so the plan can be written at *claim* time.
  The party does not exist yet — it is minted on the first authenticated request,
  minutes or days later. A plan on the party would have nowhere to live in
  between and would have to be re-derived from a schema the portal cannot read.
- It inherits the fifty-seat cap trigger and the narrow grants unchanged. No new
  table, no new role, no new surface.

### Why the numbers are not in the database

`identity.seat.plan` records **what was bought** — an immutable commercial fact.
`services/identity/plans.mjs` records **what that buys** — a pricing decision the
founder changes without anybody's data changing. Storing the allowance on the row
would freeze every existing customer at the number current the day they signed up
and turn re-pricing into a data migration.

### What counts against the allowance

Builds the party **owns**, drafts included.

- *Owns*, because the pricing page says so verbatim: "A project counts towards
  your plan when your organisation is the Managing Organisation. Collaborators
  are always free." A sub, an inspector or an architect invited onto someone
  else's record consumes nothing. This is load-bearing for the product — a shared
  record that charges you per person you invite stops being shared.
- *Drafts included*, because a draft holds a name and a baseline and sits on the
  owner's portfolio. Excluding them would make the allowance avoidable by
  abandoning at step 1, forever, for free.

### Failing closed

An absent or unrecognised plan — the hand-granted `beta` seats, every `invite`
seat, and any future key this deployment does not know — gets the **entry**
allowance of one build, never unlimited. On a metered resource the failure mode
of guessing high is giving the product away, and it is silent. Invited
counterparties are unaffected either way, because invitations do not count.

The plan enum exists in three places (the column's CHECK, `plans.mjs`, and the
marketing site's `PLAN_KEYS`). The CHECK constraint is the backstop that makes
drift **loud**: a landing site that starts writing an unknown key is refused at
the boundary rather than seating somebody on an allowance nobody can compute.

### The privilege boundary is unchanged in kind

- `landing_app` / `landing_app_v2`: `INSERT (email, source, note, plan)` — one
  more column on the same statement, by the same writer, recording the same act.
  **Still no UPDATE and no DELETE**, so a public marketing page can never raise
  an entitlement, including its own visitor's. An upgrade is an out-of-band act
  under the migrator or the billing webhook's own role.
- `identity_app`: `SELECT` only, as 0004 and 0010 both insist. The portal reads
  what someone bought and can no more change it than it could seat them.

### The refusal is a 409, not a 403

A 403 says "you may never do this". The honest statement is "you already run as
many builds as your plan allows", which is a collision with reality the caller
resolves by upgrading or by closing a build. The error carries
`code: plan_limit_reached` plus `plan`, `limit` and `owned`, so the portal can
offer an upgrade path instead of re-deriving a second, drifting copy of the
pricing table client-side.

## Consequences

**Good.** The pricing page becomes true. Entitlement is one column read on one
row on one path (build creation), with no effect on the sign-in hot path. The
allowance ladder is re-priced by editing one frozen object.

**Costs and accepted risks.**

- Everyone currently seated without a plan — the founder and the hand-granted
  beta seats — is now capped at one build. That is the intended product rule
  ("up to 1 project"), but it is a behaviour change for existing accounts, and
  raising one is a deliberate SQL act rather than a self-serve click.
- The enum is duplicated three ways. Mitigated by the CHECK, not eliminated.
- The portal shows the service's sentence rather than a designed upgrade screen.
  A real "you are at 1 of 1 — see plans" surface is follow-up work; the error
  body already carries everything it needs.
- Paid plans are still collected through the waitlist rather than Stripe while
  founding seats remain (the founder's charge-mode decision, LINA-173), so today
  a paid plan key is recorded on a seat that was granted free. That is correct
  for the pre-launch window and is the reason the plan, not the seat `source`,
  is what the allowance reads.

## Implementation

- `services/identity/migrations/0013_identity.sql` — the column, its CHECK, the
  widened INSERT grant.
- `services/identity/plans.mjs` — the allowance ladder, failing closed.
- `services/identity/seats.mjs` — `activeSeat(email)`, read-only, separate from
  the sign-in existence probe.
- `services/identity/identity.mjs` — `requireProjectAllowance`, checked after
  authorization and validation and before any write.
- `services/composition.mjs`, `services/gateway/container.mjs` — the `seats`
  port. Omitting it disables the check, which is correct only for a composition
  that has no seats at all; the deployed container always passes it.
- `marketing-site/src/app/api/confirm/route.ts` — the plan rides onto the seat at
  the moment of the claim.
