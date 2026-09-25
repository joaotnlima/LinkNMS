# LinkNMS — To-Be Architecture

**Status:** target design, agreed in the architecture session of 2026-09-23.
**Scope:** domains, data model, visibility, state machines, events and APIs.
**Not in scope:** UI. The interface is built *on top of* these contracts, never the other way round.

This folder describes where the platform is going. The current system (`app/`, `services/`,
`cowork/documentation/architecture/`) is the **as-is**. What to do with it is decided in
[13 — Gap analysis](./13-gap-analysis.md), after this design, not before.

## What changed in the product

LinkNMS was defined as a neutral shared record for *one* build between owner and builder.
The to-be is a **construction marketplace with a management core**:

1. **Management core (the Gantt).** Plan, run and prove a build across every organization on it,
   with transparency *levels*: everyone sees the plan, only contract parties see the money.
2. **Marketplace.** Owners find builders and specialties; builders find subcontractors; everyone
   gets a track record built from real, on-platform work.
3. **Monetization.** Every organization pays, in tiers matched to the value it gets.

The ordering is deliberate: the marketplace's trust signal (verified track record) is a
**by-product** of the management core. Reputation cannot exist before builds finish on the
platform, so execution is the wedge and the marketplace feeds on it.

**Implementing this?** Start at [AGENT-INDEX](./AGENT-INDEX.md).

## Documents

| # | Document | Owns |
|---|---|---|
| 01 | [Decisions](./01-decisions.md) | Every decision taken, with its rationale and dissent. Read first. |
| 02 | [Domain map](./02-domain-map.md) | The bounded contexts, what each owns, how they talk |
| 03 | [Core model](./03-core-model.md) | Organization, Person, Project, Location, Contract, BoQ — aggregates and invariants |
| 04 | [Visibility & access](./04-visibility-and-access.md) | Who sees what, who may do what, entitlements, scoped ledger |
| 05 | [Planning & execution](./05-planning-and-execution.md) | The Gantt: plan levels, dates, dependencies, progress, verification |
| 06 | [Tendering & contracting](./06-tendering-and-contracting.md) | RFP → proposal → award → contract → change orders → measurements |
| 07 | [Marketplace & billing](./07-marketplace-and-billing.md) | Directory, reputation, ranking, subscriptions and entitlements |
| 08 | [Supporting domains](./08-supporting-domains.md) | Quality, documents, collaboration, record (ledger) |
| 09 | [State machines](./09-state-machines.md) | Every lifecycle, in one place |
| 10 | [Domain events](./10-domain-events.md) | Event catalogue, outbox, ledger mapping |
| 11 | [API conventions](./11-api-conventions.md) | Transport, errors, concurrency, idempotency, projections, real-time |
| 12 | [API catalogue by use case](./12-api-catalogue.md) | Every use case → endpoint(s), per domain |
| 13 | [Gap analysis](./13-gap-analysis.md) | As-is vs to-be: keep, change, drop |
| 14 | [Open questions](./14-open-questions.md) | What is still undecided |
| 15 | [Data model](./15-data-model.md) | Tables, columns, constraints — and a full mocked build ("Casa Silva") recorded end to end |
| 16 | [Access model (Clerk)](./16-access-model-clerk.md) | What Clerk holds (orgs, roles, permissions) and what LinkNMS holds (relationships) |
| 17 | [Personas, roles & interactions](./17-personas-roles-interactions.md) | Every persona variant mapped to org kind, role, relationship and scope; how the parties interact |
| 18 | [DB model fit](./18-db-model-fit.md) | Does the as-is DB answer? (no) — requirement by requirement, and the executable to-be model in `db/v2/` |
| 19 | [MCP](./19-mcp.md) | Where agents help (compose the project, tenders, changes, field reporting) and the rules they follow |

## Executable artefacts

- **API contract:** [`api/v2/openapi.yaml`](../../../api/v2/README.md) — open `api/v2/index.html` (Swagger UI). Source of truth for UI, implementation and MCP.
- **Database model:** [`db/v2/`](../../../db/v2/README.md) — DDL, "Casa Silva" seed, checks (`verify.sh`).

## Ownership rule

Same as the product docs: each subject lives in exactly one document; every other mention is a
link. The product definition in `../` (the product docs) still owns *why*; this folder owns *how*.

## Reading order

- **Deciding what to build next:** 01 → 02 → 13.
- **Designing the UI:** 03 → 04 → 05 → 15 → 12. The UI may not invent a field or a rule that is not here.
- **Implementing a domain:** its document → 09 → 10 → 11 → 12.
