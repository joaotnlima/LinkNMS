# ADR-0004 — Multi-party permission model

- **Status:** Proposed (awaiting CEO approval)
- **Date:** 2026-08-25
- **Deciders:** Full-Stack Architect
- **Context issue:** LINA-26 (R0) — FR1, FR3, FR4.

## Context

R0 is one homeowner (owner) + one GC (counterparty) on one project. But the
product grows to many parties (subs, site manager, architect, inspectors). The
permission model must be **correct for R0** yet **shaped for that future** so we
don't repaint it later. The load-bearing rule: a change order can be
**approved/rejected only by someone other than the proposer** (or the owner).

## Decision

**Role-on-membership, checked server-side, authored to generalize.**

- Authorization is a property of **`membership`** (party × project × role), not
  of the user globally. This is already the multi-party shape — R0 just caps the
  roles to `owner` and `counterparty` and allows one of each per project.
- **Roles (R0):** `owner` (homeowner), `counterparty` (GC). The schema stores a
  role string; R0 constrains it to these two. Adding `sub`, `inspector`, etc.
  later is new role values + capability rules, not a model change.
- **Capabilities are derived from role**, evaluated by Identity & Membership
  (ADR-0003), never trusted from the client:

  | Action | Who |
  |--------|-----|
  | Create project, set baseline, invite counterparty | `owner` |
  | Record / revise a decision | any member |
  | Propose a change order | any member |
  | **Approve / reject a change order** | any member **who is not the proposer** (owner may always decide) |
  | View everything on the project | any member |

- **The two-sided approval rule is a server-side invariant**, enforced in the
  Change Order service *and* expressible as a DB check (`decided_by <>
  proposed_by`). It is never left to the UI. This is the FR4 trust rule and gets
  dedicated tests that attempt to violate it.
- **Every mutation records the acting party from the session**, and that party
  is written into the ledger event (ADR-0002). Authorship/approval stamps are
  therefore server-authoritative and tamper-evident.

## Alternatives considered

- **Global RBAC / policy engine.** Premature for two roles. The membership-role
  model already generalizes; a policy engine is a future swap behind the same
  `can(party, action, project)` interface.
- **Owner-only approval.** Simpler but violates FR4 (either party may decide, as
  long as it isn't the proposer). Rejected.

## Consequences

- **Positive:** correct for R0, already multi-party in shape, single authorizer
  (ADR-0003), the approval-conflict rule is enforced in two layers (service +
  DB).
- **Negative / debt:** the "owner may always decide" carve-out plus the
  not-the-proposer rule needs explicit test coverage for the edge case where the
  owner is the proposer (then the counterparty must decide). Covered in the test
  matrix.
- **Revisit when:** we add a third role or per-field visibility rules
  (e.g. inspectors see a subset).

## Follow-ups / carried forward

- The Clerk → Neon RBAC bridge (Auth Migration 0A, LINA-123) carries these
  invariants forward — `can()` is the single authorizer, deny-by-default, and the
  two-sided change-order rule is a runtime predicate + DB check. The four open
  items (permission matrix, session transport, one-role-per-org, schema
  namespace) were ratified in
  [Auth Bridge §8 Architect Review (LINA-142)](../auth-bridge-review-lina-142.md).
