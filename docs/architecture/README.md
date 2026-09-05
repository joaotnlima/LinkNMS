# LinkNMS Architecture

This directory is the technical source of truth for how LinkNMS is built. It is
written **before** implementation and reviewed/approved before developers are
handed work.

## Reading order

1. [`r0-technical-design.md`](./r0-technical-design.md) — the R0 design: data
   model, API contracts, UML/sequence diagrams, infra, rollout, test strategy,
   and a trace from each of the PM's 9 functional requirements (LINA-26) to a
   design element.
2. ADRs (the decisions behind the design, with trade-offs):
   - [ADR-0001 — Stack & platform](./adr/0001-stack-and-platform.md)
   - [ADR-0002 — Tamper-evident audit ledger](./adr/0002-tamper-evident-audit-ledger.md)
   - [ADR-0003 — Service boundaries](./adr/0003-service-boundaries.md)
   - [ADR-0004 — Multi-party permission model](./adr/0004-permission-model.md)
   - [ADR-0005 — Schedule/Progress service & plan documents](./adr/0005-schedule-progress-and-plan-documents.md)
   - [ADR-0006 — Schema-per-service isolation, API surface & SLAs](./adr/0006-schema-isolation-api-surface-and-slas.md)
3. [`tooling-integrations-cost.md`](./tooling-integrations-cost.md) — Founding
   Engineer's companion: concrete tool/integration picks, pros/cons, and the
   $0-at-R0 cost model (free/open-source first).
4. [`r0-sla-observability-spec.md`](./r0-sla-observability-spec.md) — Product
   Analytics Lead's endpoint SLA / observability spec (LINA-41): per-endpoint
   OTel metrics, SLO targets, dashboard, and alert routing. Extends LINA-28.

## Status

| Doc | Status |
|-----|--------|
| R0 technical design | **Approved — CEO signed off on LINA-26, 2026-08-25. R0 shipped.** |
| ADR-0001 … 0005 | **Approved** (CEO, 2026-08-25) |
| ADR-0006 — schema isolation, API surface & SLAs | **Accepted** — absorbs CEO follow-up direction (2026-08-25) |
| ADR-0007 — magic-link sign-in | **Superseded** by ADR-0008 (Clerk migration, LINA-121/123) |
| ADR-0008 — seats & access control | **In force** — governs the Clerk + Neon RBAC bridge |
| ADR-0009 — portal :root palette sequencing | **In force** — prereq for Band B portal screens (LINA-156) |
| ADR-0010 — per-resource subcontractor scoping | **Accepted, dormant** — predicate shipped; activation gated on multi-party invite |
| Tooling, integrations & cost | **Approved** (CEO, 2026-08-25) |

**R0 is complete and in production (2026-09-04).** All nine functional requirements
from LINA-26 are satisfied. The full service stack (ledger, identity, decision,
change-order, schedule/progress) is wired and serving traffic. The auth layer has
been migrated from self-managed magic-link to Clerk (ADR-0008). The schedule/progress
service (Slice 6) is fully built including the HTTP surface, pg-store, and frontend
timeline. See [`docs/product/roadmap.md`](../product/roadmap.md) for current
implementation state and what is planned next.

## Ownership

- **Architecture, data model, API contracts, ADRs:** Full-Stack Architect.
- **Tooling / integrations / cost, dev environment & CI, delegation of build
  work to developers:** Founding Engineer.
- **What R0 must do & why (scope/acceptance):** Product Manager (LINA-26).
- **Approval to proceed to build:** CEO.
