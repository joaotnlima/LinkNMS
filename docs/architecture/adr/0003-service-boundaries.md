# ADR-0003 — Service boundaries

- **Status:** Proposed (awaiting CEO approval)
- **Date:** 2026-08-25
- **Deciders:** Full-Stack Architect
- **Context issue:** LINA-26 (R0)

## Context

We want service-oriented seams that can split into independent services later,
without paying distributed-systems costs now (ADR-0001). This ADR fixes **where
the seams are** so each module owns its data and exposes a stable interface.

## Decision

Four bounded capability services (a fifth — **Schedule & Progress** — is added by
ADR-0005 for the CEO's plan/progress scope expansion, following this same
pattern). In R0 each is a module with a typed interface,
owning its own tables, deployed as its own group of Vercel serverless functions
under a versioned path. They share one Postgres instance but **never read each
other's tables directly** — only through the owning service's interface. That
one rule is what makes future extraction mechanical.

| Service | Owns (tables) | Responsibility | Must not |
|---------|---------------|----------------|----------|
| **Identity & Membership** | `project`, `party`, `membership`, `invitation` | Projects, parties, invites, **all permission checks** (ADR-0004) | Know about decisions/COs |
| **Decision Log** | (projections) `decision`, `decision_revision` | Record & revise decisions (append-only) | Do budget math |
| **Change Order** | (projection) `change_order` | CO lifecycle, two-sided approval gate | Compute the running budget total |
| **Ledger & Budget** | `audit_event` (**owner**), `budget_event` | Append/verify the hash chain (ADR-0002), compute budget, four-pillar status | Make authorization decisions |

### The ledger is shared infrastructure, owned by one service

`audit_event` is the crown jewels. **Ledger & Budget owns the append + verify
API.** Decision Log and Change Order do not write the ledger directly — they call
`ledger.append(event)` within the same DB transaction as their projection write.
This keeps hash-chain construction in exactly one place (invariant integrity)
while letting each service own its own read model.

### Interaction rules

- All cross-service calls go through interfaces, in-process in R0 (a function
  call), swappable for HTTP later without changing callers.
- **Identity & Membership is the sole authorizer.** Every mutating handler asks
  it "may this party do this here?" before acting.
- A trust-critical write = one DB transaction: `ledger.append(event)` +
  projection upsert. Either both commit or neither does.

## Consequences

- **Positive:** clear ownership; the ledger invariant lives in one service;
  later extraction is "move a module + its tables behind HTTP," not a rewrite.
- **Negative / debt:** discipline-enforced boundaries (shared DB) can be
  violated by a careless join across ownership lines. Mitigation: per-service
  schema namespaces + code review treats cross-ownership reads as a defect.
- **Revisit when:** any service needs independent deploy cadence or scaling, or
  we introduce a new party type / multi-house (Identity & Membership will feel
  it first).
