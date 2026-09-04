# LinkNMS — Product Roadmap

**As of 2026-09-04.** Living document; updated when significant milestones ship or plans change.

---

## Where we are

LinkNMS has a working shared-record core in production, a live marketing site with
a waitlist and pricing, and a founding-seat acquisition model underway. The next
milestone is converting waitlisted builders to paying accounts through the build
creation and payment flows.

---

## What is shipped

### Platform foundation (R0 Slices 0–1, complete)

Schema-per-service isolation, roles/grants, CI gate, ledger persistence,
budget management, audit-event chain, and the four-pillar status surface.
These are the trust anchors everything else builds on.

ADRs: 0001 (stack), 0002 (tamper-evident ledger), 0003 (service boundaries),
0006 (schema isolation, SLAs).

### Shared-record core (R0 Slices 4 + 7, complete)

**Decision log** — raise a decision, revise it, read the full attributed history.
**Change orders** — two-sided propose/approve/reject with cost impact, budget gate
enforced at the database level, and the one-screen "who decided, when, how much"
answer the product exists to give.
**Audit surface** — chain-verify across all events; tamper-evident, never
tamper-proof.

Functional requirements FR1–FR9 from LINA-26 are satisfied. The full HTTP
surface (Fastify gateway, Next.js API routes) is wired and serving real traffic.

### Plan & Progress (R0 Slice 6, complete — LINA-69 / LINA-105)

**Stage timeline** — GC adds ordered stages with dates and planned costs; homeowner
sees them in a read-only timeline on their portal.
**Append-only progress** — status enum (`not_started / in_progress / blocked / done`)
plus optional advisory percent and notes; every report is attributed and immutable
in the ledger. No transition is forbidden; the history tells the truth either way.
**Rollup** — derived on read from per-stage current statuses; `blocked` outranks
a finished plan and is never averaged away (see `docs/product/r0-plan-progress-functional-spec.md`).

The full service layer (ports, pg-store, HTTP endpoints) and the frontend plan
timeline surface are both in production.

### Auth (Clerk migration, complete — LINA-123/124/125/129)

Self-managed magic-link identity retired. Clerk is the identity provider; Neon
Postgres RBAC (ADR-0008) is the authorization layer. The Clerk→Neon bridge runs
via a webhook; JIT provisioning handles first-touch. Per-resource scoping for
subcontractor verbs is shipped dormant (ADR-0010) and activates when the
multi-party invite path is ready.

### Onboarding (complete — LINA-126–137)

Full onboarding spine is live:
- **D-4 Waitlist form** — users can join; email captured in `waitlist` schema.
- **D-2 Welcome email** — Resend fires on signup; `noreply@linknms.com` SPF/DKIM/DMARC configured.
- **D-1 Activation email** — Clerk org invitation sent to the first 50 founding builder seats.
- **D0a Sign-up + D0a-setup** — Clerk-backed sign-up screen and account setup, persisted to Neon RBAC.
- **D1-new Empty portal** — first-time portal state for a user who has signed in but has no build yet.

### Marketing site (complete — LINA-34 / LINA-167 / LINA-171 / LINA-172)

Three-language site (pt-PT / EN / es-ES) with waitlist capture, scroll reel,
pricing section, and a live founding-seat counter (currently 18 / 50 builder
seats taken). PostHog analytics wired.

**Pricing model (landed):**

| Plan | Who | Price | Limit |
|---|---|---|---|
| Owner | Homeowner | Free | 1 build |
| Builder Free | Builder / contractor | Free | 50 founding seats; capped at 1 build |
| Builder Paid | Builder / contractor | ~€29/mo | Unlimited builds |

---

## In progress now

### Payment workflow — LINA-173

Builder clicks "Upgrade" on the pricing section; the flow redirects to checkout
and provisions a paid seat on success. This is the revenue gate: once it lands,
founding-seat conversion is end-to-end.

**Owner:** Founding Engineer + Frontend Dev.

### Build creation flow design — LINA-164 (in review)

Technical design for the "Band B" wizard: create a build, set operating model
(turnkey / direct-to-specialty / hybrid), invite the counterparty, and commit the
record. Design doc is in the workspace awaiting PM sign-off on three open questions
(invite re-send, existing-user invite, Hybrid multi-invite). Implementation is
gated on this approval plus LINA-156 (palette migration, see below).

---

## Next planned

### Build creation wizard (Band B)

The core UX that onboarded users hit after the empty portal. Sequenced as:

1. **Migration 0009** — add `operating_model` and `status` columns to `identity.project`
   (backward-compatible; existing rows default to `'active'`).
2. **API extensions** — `PATCH /api/v1/projects/:id/operating-model` (new) and
   draft/commit logic on existing `POST /projects` and `POST /projects/:id/invitations`.
3. **Mobile screens M1–M6** — wizard screens built mobile-first per the pen file's
   "Band B · Create the build and invite" frames, after LINA-156 lands the pen palette.
4. **Desktop screens D1–D6** — responsive widescreen layout once mobile is green.

**Blocked on:** LINA-164 PM approval (OQ-1..3 answers needed) + LINA-156 portal
palette migration.

### Portal :root palette migration — LINA-156 (blocked)

The portal's `globals.css` still carries the pre-ADR-0009 token names alongside
the pen palette tokens. ADR-0009 sequences this as a prerequisite to merging any
new Band B portal screen. The migration itself is straightforward (rename
variables in `globals.css` to the generated `tokens.css` output); it is blocked on
a clean merge window.

---

## Backlog (prioritised, not yet scheduled)

| LINA | What |
|---|---|
| LINA-160 | Subcontractor per-resource scoping activation (multi-party invite path) |
| LINA-166 | Provision `CLERK_WEBHOOK_SIGNING_SECRET` for live RBAC sync in prod |
| LINA-168 | Architect review + deploy pricing section (outstanding from LINA-167) |

---

## The product horizon (not yet planned for a release)

These are in scope for LinkNMS eventually but have no sequencing decisions made.
They are captured in `cowork/documentation/05-functional-scope.md` (the full
shape document) and are not commitments.

**R1 (likely next release after Band B)**

- Homeowner acknowledgement of progress as a first-class ledgered event (deferred
  from R0 §7 of the plan/progress spec).
- Per-build invite management screen (add/remove parties after initial setup).
- Multiple-invite Hybrid path in the Band B wizard (OQ-3 V2 from LINA-164 §9).

**Later**

- True scheduling: dependencies, critical path, Gantt (explicitly cut from R0).
- Cross-trade coordination: overlap detection, shared site calendar, unclaimed-scope
  routing (requires multi-contract architecture).
- Payment milestones tied to verified completion (the money-side of dependency-gated
  scheduling).
- Multi-build portfolio view for builders running several projects.
- BIM upload, preview, and attachment as evidence on the record (R0 accepts the
  concept; BIM mandatory in Portugal in 2030 per RCM 89/2026, pilot 2027).
- Municipal-permitting phase milestones (links and status tracking; no API integration
  until systems expose one).

---

## Implementation model

This product is built against approved specs and ADRs — implementation does not start
until the design is signed off. The sequence is always:

1. PM writes or confirms functional requirements and acceptance criteria.
2. Architect designs the data model, API contracts, and service seam.
3. CEO approves (or delegates approval) to proceed.
4. Founding Engineer delegates build tasks to specialist agents/developers.

The trust core (the ledger) is never touched outside this gate.

---

## Ownership by area

| Area | PM | Architect | Founding Engineer |
|---|---|---|---|
| Roadmap, priorities, acceptance | Product Manager | — | — |
| Data model, API contracts, ADRs | — | Full-Stack Architect | — |
| Tooling, CI, build delegation | — | — | Founding Engineer |
| Visual design, pen file | — | — | Product Designer |
| Analytics event contract | — | — | Product Analytics Lead |
