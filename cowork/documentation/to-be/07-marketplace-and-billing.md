# 07 — Marketplace & billing

## Directory

**OrganizationProfile** (one per non-household org, public when `listed = true`):
`display_name`, `logo`, `description`, `kind`, `specialties[]` (catalogue ids + free tags),
`service_areas[]` (municipalities / districts), `team_size_band`, `founded_year`,
`declared_credentials { nif, impic_licence_number, impic_licence_class, insurance_policy }`,
`contact_policy` (contact only through RFP/invite, or public contact).

- Credentials are **self-declared** and shown as "declared" (D-17).
- **Completeness score** (0–100): logo, description, specialties, areas, NIF, IMPIC licence,
  insurance, ≥3 portfolio entries. Feeds ranking; the UI shows the score and what raises it.

**PortfolioEntry**
- `source = platform`: generated when a contract reaches `provisionally_received`. Carries the
  municipality, typology, specialty, dates, baseline-vs-actual variance and photos **only if the
  owner consents**. Labelled "built on LinkNMS".
- `source = declared`: added manually by the org. Labelled "declared".

**Search & ranking** — filters: specialty, municipality/district, kind, rating, availability flag.
Ranking score = relevance × (completeness, rating, platform track record, recency).
Promoted placements (paid, `directory.promoted`) are **always labelled** as promoted and never
reorder organic results beyond their reserved slots.

## Reputation (D-16)

**Who may review whom**

| Reviewer | Subject | Anchor | Eligible when |
|---|---|---|---|
| Owner | Prime / direct supplier | contract | contract `provisionally_received` or `terminated` |
| Owner | Subcontractor | the sub's **work on the owner's project** (its tasks) | the sub contract is `provisionally_received` or `terminated` |
| GC (contract client) | Subcontractor | sub contract | same |
| Subcontractor | GC (its client) | sub contract | same |

**Review**: ratings 1–5 on `quality`, `schedule`, `communication`, plus `payment_reliability` when
the subject is a client (sub → GC); free text; one per (reviewer org, subject org, anchor).

- **Double-blind publication (proposed):** a review is published when both sides of the pair have
  submitted, or after 14 days — prevents retaliation reviews.
- Subject may post one public reply.
- Reviews are never editable after publication; a correction is a new, linked review.

**Objective metrics** (computed by Reputation from events, per org, rolling 24 months):
on-time rate (verified finish ≤ baseline finish), first-time verification pass rate, change orders
per contract, median answer time to questions, contracts completed on platform.

## Billing

**Principle (D-05):** every organization pays; tiers follow the value obtained.

| Org kind | Pays for (value) | Illustrative tiers |
|---|---|---|
| Household (owner) | Pre-project brief, RFPs, owner control view (baseline/forecast/actual, cash-flow), reviews | per project (one-off or monthly during the build) |
| General contractor | Portfolio of active projects, seats, sub-level RFPs, schedule advanced, directory listing | Starter / Pro / Business by active projects + seats |
| Specialty contractor | Own schedule management, bidding on open RFPs, listing | Solo / Crew / Company by seats + open-RFP credits |
| Consultant | Participation across projects | by active projects |

**Model**
- `Plan(code, org_kind, price, interval, entitlements{key: limit})`
- `Subscription(org, plan, status ∈ {trialing, active, past_due, canceled})`
- `Sponsorship(contract, sponsor_org)` — covers the supplier's project-scoped entitlements.
- Add-ons: open-RFP credits, promoted placement.
- Subscription charging uses a billing provider (e.g. Stripe Billing). This is the platform
  charging its customers, not money moving between build parties, so D-10 still holds.
- Lapsed subscription: creating/managing is blocked; **reading signed contracts and their record
  is never blocked** ([04 §4](./04-visibility-and-access.md)).
