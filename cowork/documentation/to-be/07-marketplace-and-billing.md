# 07 — Marketplace & billing

## Build slices (D-40)

This is a multi-slice epic, not one drop. The order is driven by what unblocks
the open-marketplace tender flow (LINA-406) with the least new surface:

| Slice | Scope | State |
|---|---|---|
| **1 — Self-serve apply** | A bidder that discovers an `open`, published RFP through the marketplace claims its **own proposal lane** (`POST /rfps/{rfpId}:apply`), instead of waiting for the issuer to invite it by email. Idempotent (first apply `201`, re-apply `200`); a prior email-only invite for the org's address is adopted, not duplicated. From there the existing authed proposal endpoints (`putProposal`, `submitProposal`) carry the lane exactly as an invited bidder's. This is the hinge that makes "convite aberto ao marketplace" actually function — the `open` visibility flag and `GET /marketplace/rfps` browse already shipped, but nothing could *act* on them. | **Amended by D-47 (PRD-04):** apply is now *ask to bid* — a pending bid request the issuer approves (lane + link, adopting a prior e-mail invite) or declines; `open` is `rfp.listed`; `/marketplace` redirects to the company inbox (`/requests`). |
| **2 — Directory FE + profiles** | `OrganizationProfile` (listed), specialty catalogue, service areas, completeness score, marketplace browse/search UI, and the before/after portfolio. Lets an owner *discover* companies and a company present itself. | Built by PRD-03 (taxonomy, search near a build, public profiles with the on-the-record read model, claim, editor); portfolio photos and promoted placement not yet. |
| **3 — Reputation** | Reviews + objective metrics (D-16, below). | Designed; not built. |
| **4 — Billing** | Plans, subscriptions, entitlement enforcement incl. `proposal.submit_open` (D-05, below). Until this ships, apply is gated only by `org:tendering:bid`. | Designed; not built. |

## Directory

**OrganizationProfile** (one per non-household org, public when `listed = true`):
`display_name`, `logo`, `description`, `kind`, `specialties[]` (catalogue ids + free tags),
`service_areas[]` (municipalities / districts), `team_size_band`, `founded_year`,
`declared_credentials { nif, impic_licence_number, impic_licence_class, insurance_policy }`,
`contact_policy` (contact only through RFP/invite, or public contact).

- Credentials are **self-declared** and shown as "Stated" (D-17 as amended by D-46 — no "Checked" level).
- **Completeness score** (0–100, PRD-03 R-19): specialties, base location + radius, description, IMPIC licence,
  insurance, portfolio, availability. Shown to the company with what raises it; it **never changes the order of
  results** (D-46).

**PortfolioEntry**
- `source = platform`: generated when a contract reaches `provisionally_received`. Carries the
  municipality, typology, specialty, dates, baseline-vs-actual variance and photos **only if the
  owner consents**. Labelled "built on LinkNMS".
- `source = declared`: added manually by the org. Labelled "declared".

**Search & ranking (D-46, PRD-03)** — filters: specialty (taxonomy, two levels), near a build or a point within
25/50/100 km (the company's own service radius must reach the point), municipality/district, kind, can start by;
facets for work types, proof, size, claimed. Distances are haversine in SQL (`directory.distance_km`, no extension).
Ranking comes **only from clients verified by the platform** — clients that signed a contract with the company on
LinkNMS. Ranked companies (≥ 1 verified client; a terminated contract still counts — the award happened, and its late tasks weigh on the on-time rate) come first, ordered by verified
clients, then the on-time rate of their tasks under those contracts (smoothed (x+1)/(y+2)), then builds, then
distance, then specialty match. Companies with no verified client follow, labelled "No verified clients yet", by
distance then specialty match. Completeness, stated data and payment never change the order. Ratings (D-16) do not
exist yet; when they do, only ratings from clients with an award to the company may feed the rank. Promoted
placements (paid, `directory.promoted`), when built, are shown apart from the ordered list and never inside it.

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
