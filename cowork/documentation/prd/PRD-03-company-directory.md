# PRD-03 — Company directory: find who does the work, by specialty

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 4b · D1 Search, D2 Profile, D4 Listing; 4 · tendering/Gaps (directory, profile edit) |
| Related decisions | D-05, D-16, **D-17 (conflict)**, D-40, D-19 |
| Related docs | to-be/07 marketplace & billing, to-be/20 §3 URL map |
| Depends on | — |
| Extended by | PRD-04 (connection to RFPs) |

## 1. Problem

The owner or GC needs to answer one question: **who should do this work, near this build?** Today `/marketplace` answers the reverse question, "which open RFPs can I bid on?", for companies. That is useful to companies, but it is not the product's intent. Companies, in turn, have nowhere to be found and nowhere to show their track record.

Model: an *idealista.pt* for construction specialties. Search by specialty and place. Profiles show facts from the shared record, not reviews. Companies get work and advertise.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| `directory.specialty` (code, name_pt, name_en, parent_code) | Table exists, **empty and unused** | `db/v2/0001_schema.sql:82-123` |
| `directory.organization_profile` (specialties, service_areas, team_size_band, `listed`, completeness, declared IMPIC no./class) | Table exists, **no read or write path** | `0001_schema.sql:82-123`, `:100-101` |
| `directory.portfolio_entry` (source platform/declared, owner_consent) | Table exists, unused | same |
| API registration | Placeholder comment only | `registry.ts:156` |
| `/companies`, `/companies/{slug}`, `/settings/organization/profile` | No routes | `app/src/app` |
| Location for "near" | Only `municipality_code`; no coordinates. `project.location` is the location tree inside a build | `0001_schema.sql:143` |
| `planning.task.specialty` | Free text, not the taxonomy | `0001_schema.sql:499` |

## 3. Goals

1. An owner or GC finds relevant companies for a task's specialty within a radius of the build in under a minute.
2. Profiles show **facts from the record**: builds, on-time tasks, change orders. They are labelled separately from what the company states.
3. Companies get a listing they keep up to date and a place where requests for them arrive.

### Non-goals

- Adding a company to an RFP, ask to bid, open requests (PRD-04).
- Ratings and reviews (D-16 reputation is a later slice).
- Billing and entitlements for wider areas (`/settings/billing`, PRD-12). The board leaves this as `[plan entitlements to define]`.

## 4. Requirements

### 4.1 Taxonomy and location (foundation)

| ID | Requirement | Priority |
|---|---|---|
| R-1 | Seed `directory.specialty` with a two-level PT/EN taxonomy, e.g. Roofing → Tiled roofs, Flat roofs & waterproofing, Skylights, Gutters. Map it to the IMPIC alvará categories and sub-categories so it lines up with licences (verify the current official classification). | Must |
| R-2 | Today the plan uses `planning.user_specialty` (per-org labels over a built-in list, `db/v2/0008_planning_specialties.sql`, deliberately separate from `directory.specialty`). `task.specialty` gains an optional `specialty_code` pointing at the taxonomy. Free text is kept for display and back-compat. The task panel offers the taxonomy with free-text fallback. | Must |
| R-3 | Build location: a point (lat/lng) or at minimum a municipality, entered at build creation. Company base location plus service radius in km. | Must |

### 4.2 Search: `/companies?specialty=&near=&radius=` (D1)

| ID | Requirement | Priority |
|---|---|---|
| R-4 | Inputs: specialty (taxonomy), where (build or municipality), radius 25/50/100 km, "can start by" date. Prefilled when opened from a task. | Must |
| R-5 | Facets with counts: work types (sub-specialties), proof (builds on LinkNMS, licence number given, portfolio photos), company size, profile claimed. | Should |
| R-6 | Result card: name, base and distance, service radius, size, specialty chips, three **labelled proof lines** (see 4.4), "can start from", `View profile`, and `＋ Add to RFP` when opened from a task. | Must |
| R-7 | Order: distance, then specialty match. **Paid placement is shown apart** ("Promoted") and never changes the order of results. | Must — **decision, see §7** |
| R-8 | List / map toggle. | Could |
| R-9 | Public and indexable (SEO). Specialty landing pages `/specialties/{slug}` (to-be/20). | Should |

### 4.3 Profile: `/companies/{slug}` (D2)

| ID | Requirement | Priority |
|---|---|---|
| R-10 | Header: name, claimed/unclaimed state, base, service area, size, on LinkNMS since. | Must |
| R-11 | **On the record** block: number of builds with a signed Trade Contract, tasks finished on the planned date (x of y), change orders raised/approved. Computed from records both sides can see. Labelled "facts from the shared record — not reviews". | Must |
| R-12 | Build list with state (closed / in progress) and dates. **Build names only with owner consent; amounts never** (D-07 spirit). | Must |
| R-13 | Portfolio gallery from `portfolio_entry`. A photo from a LinkNMS build needs `owner_consent`. | Should |
| R-14 | About (stated), licences and insurance (stated or checked, see 4.4), service-area map, "usually replies within", "can start from". | Should |
| R-15 | `Ask for a proposal` (behaviour in PRD-04). | Must |
| R-16 | Unclaimed profiles show only what the record knows, plus a `Claim this profile` path for the company. | Must |

### 4.4 Proof levels

| Label | Meaning | Source |
|---|---|---|
| **On the record** (board label "Verified") | Counted from LinkNMS builds | Award, task and change-order events |
| **Checked** | Checked against a public register | IMPIC alvará lookup with check date |
| **Stated** | Written or uploaded by the company | Profile fields and documents |

Every claim on a card or profile carries exactly one label.

### 4.5 Company side: listing and inbox (D4)

| ID | Requirement | Priority |
|---|---|---|
| R-17 | "Your listing": shown in searches, profile views, requests received, proposals sent and awarded (last 30 days). | Should |
| R-18 | Inbox tabs: **Requests for you** (with where each came from) and **Open requests near you** (replaces `/marketplace`, see PRD-04). | Must |
| R-19 | Completeness checklist (specialties, licence, portfolio, insurance, availability) using the existing `completeness` column. | Should |
| R-20 | Edit profile at `/settings/organization/profile` (to-be/20): description, specialties, base and radius, portfolio, licence, insurance, availability. | Must |

## 5. Data and API

- New read endpoints: `GET /companies` (search) and `GET /companies/{slug}`. New write endpoints: `PUT /organizations/{id}/profile` and `POST /organizations/{id}/portfolio`. Add them to `openapi.yaml` and register the directory module.
- "On the record" counts: a read model fed by award, task-completion and change-order events. Never by self-declared data.
- Slug policy is an open point in to-be/20 §5.2. Decide it before R-10.
- Geo: store lat/lng and compute distance in Postgres (earthdistance or PostGIS). The extension choice is open; verify what the hosting supports.

## 6. Acceptance criteria

1. Searching Roofing within 25 km of a build returns only companies whose service radius reaches the build, ordered by distance then specialty match. A promoted company never appears inside the ordered list.
2. A profile's "On the record" numbers equal a direct count over the record tables for that organisation.
3. An unclaimed profile created from an email invite shows no stated data and offers Claim.
4. No amount appears anywhere in the directory.

## 7. Decisions needed

> **Decided — D-46:** ranking within a specialty comes only from platform-verified clients (clients with an awarded contract on LinkNMS). Completeness and payment never change the order. Licences stay self-declared ("Stated"); no "Checked" level for now. R-7 and §4.4 follow this.

1. **D-17 conflict.** D-17 says licences and insurance are *self-declared*, shown "as declared, never as verified", and that completeness **boosts ranking**. The boards add a **Checked** level (IMPIC lookup) and state that completeness and payment **never** change the order. Either amend D-17 or drop "Checked" and the ordering rule. Recommendation: amend. Record-derived facts and a dated public-register check are not "company verification", and honest ordering is the trust promise. But the decision is yours.
2. **D-40 sequencing.** D-40 shipped marketplace Slice 1 (self-serve apply) first and put directory profiles later. This PRD makes the directory the main door. PRD-04 covers what happens to `/marketplace`.
3. **IMPIC check.** Is there a usable public lookup? **Not verified.** Check before promising "Checked"; the fallback is "Stated".
4. Entitlements for wider service areas or more specialties (D-05). Not defined.

## 8. Risks

- **Cold start.** With few builds, "On the record" is empty for most companies, and unclaimed profiles look thin. Seeding from email invitees (PRD-04) is the main supply.
- Showing build history, even without amounts, needs the owner consent rule implemented first, or this ships a privacy leak.
