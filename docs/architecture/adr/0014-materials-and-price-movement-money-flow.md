# ADR-0014 — Materials, price movement, and the live-record money flow (Slice B3)

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deciders:** Full-Stack Architect (Technical Lead)
- **Context issue:** LINA-201 — Slice B3 · Live record + materials + budget
  movement (D14–D16). **Parent:** LINA-196. **Anchors:** ADR-0012 §B (Slice B3),
  ADR-0002 (hash-chain audit ledger), ADR-0003/0006 §1 (service isolation +
  append seam), ADR-0004 (permissions), ADR-0005 (schedule service), the B2
  frozen contract (`slice-b2-plan-baseline-contract.md`).

## Context

ADR-0012 §B sequenced the plan/baseline epic into three slices and deferred the
**materials model** to be finalised "when B2 lands." B2 has landed (LINA-200/211/212,
merged @ b3dce66 / 3076e65): a plan version freezes as **baseline v1** via
`schedule.project_baseline`, and every later change is to be *measured against*
that frozen zero point.

B3 is the live record and the money behind it (pen D14–D16):

- **D14** — the record, live: Plan / Schedule / Money / History tabs; three line
  states (accepted / deviation / closed-and-verified); Compare reopens
  planned-vs-executed so a settled line stays auditable.
- **D15** — line detail: the materials behind the price (each material, quantity,
  unit price, labour). A swap that moves contract value opens a **change order** —
  it is not a silent edit.
- **D16** — budget: materials broken out vs baseline unit price; every movement
  **dated, sourced, attributable** — *an index rise ≠ a scope change; the screen
  must not blur them.*

This introduces a genuinely new domain (materials) and a load-bearing money-flow
question that the rest of the product must not violate. That is what this ADR
fixes; the buildable schema, API, and FE contract are frozen in
`slice-b3-live-record-materials-contract.md`.

## Decision

### 1. Materials are plan-version state — frozen with the baseline

A **line material** (material or labour) hangs off a plan line
(`schedule.stage`) and belongs to a `plan_version`. Like the stages themselves
(B2), materials are editable **only while the version is `proposed`** (authored
by the proposer) and become **immutable when the version freezes** — the B2
`stage_freeze_guard` discipline is extended to the materials table. A baseline's
material breakdown is therefore as tamper-evident as the baseline plan itself.

Consequence: plan versions frozen *before* B3 (there are none in prod beyond
test/demo data) carry no material rows; their line value is the stage's
`planned_cost_cents`, and all subsequent material detail arrives as **movements**
(below). No frozen version is ever unfrozen to backfill materials.

### 2. The budget total moves through change orders — and nothing else

This is the invariant B0/Slice-1 established (ADR-0002; `ledger.budget_event`
`UNIQUE(change_order_id)`), and B3 **preserves it unchanged**:

> Current contract budget = genesis baseline + Σ approved change-order deltas.
> The only writer of `ledger.budget_event` is an approved change order.

B3 adds **no** new path into the budget total. A material change that moves
contract value is realised as a **change order** (reusing the `change_order`
service verbatim — propose → two-sided decide → one budget move). This keeps the
authoritative money in exactly one audited, two-party-approved channel.

### 3. Two movement kinds, and the screen must not blur them (D16)

Every post-baseline material change is recorded as an attributable, hash-chained
**material movement** (`material_movement_recorded` ledger event: dated by the
server clock, sourced, attributed to the acting party — ADR-0002 §5). A movement
is exactly one of two kinds, separated by a **DB CHECK**, never by convention:

| kind | meaning | moves the contract budget? | how |
|------|---------|----------------------------|-----|
| `scope_change` | quantity or specification changed | **yes** | via a linked **change order** (`change_order_id NOT NULL`); the budget moves through that CO's `budget_event`, exactly once, as today |
| `price_movement` | the *same* scope at a different unit price (market/index, supplier re-quote, correction) | **no** — recorded against the baseline unit price, not folded into the contract total | `change_order_id IS NULL`; a required `price_cause` classifies it |

The CHECK is the guarantee that the D16 screen *cannot* blur an index rise into a
scope change: a `price_movement` may not carry a change order, and a
`scope_change` must. The Money/budget view is a **read projection** that
decomposes baseline → current into (a) scope changes (each its approved CO) and
(b) price movements (informational, shown against baseline unit price) — two
visually and structurally distinct columns.

**Rationale for keeping price movements out of the contract total in v1.** Under
a fixed-price agreement an index rise on a party's materials is that party's cost
exposure, not a change to the agreed contract value — surfacing it silently in
the budget total would misstate what was agreed. If parties *agree* a price
movement should pass through to contract value (an escalation clause), that
agreement is itself a scope-affecting decision and is raised as a change order —
i.e. it becomes a `scope_change`. So "pass-through" is not a missing feature; it
is deliberately the change-order path. This is noted, not dropped.

### 4. Live-record line states are derived, not a mutable status column

Consistent with ADR-0005 (a stage's status is derived from append-only
`stage_progress`, never a mutable column), the three D14 states are **derived**:

- `accepted` — a baseline line with no movement against it.
- `deviation` — ≥1 `material_movement` (or scope-change CO) touches the line.
- `closed_and_verified` — the line's latest `stage_progress` is `done` **and** a
  verification stamp exists (see the contract's open item on the verify stamp).

**Compare** (planned-vs-executed) is always available, including on a closed
line — a settled line stays auditable forever (it reads baseline vs current from
immutable rows; nothing is destroyed on closure).

## Consequences

- The core product promise — *who moved the money, when, by how much, and was it
  scope or price* — is answerable by construction: scope changes are two-party
  change orders in the ledger; price movements are attributable, sourced ledger
  events; the DB CHECK keeps them un-blurrable.
- The existing change-order / budget / analytics stack is untouched and reused;
  B3 adds a domain (materials + movements) beside it, not a second money path.
- **Tech debt / open items** (finalised in the slice contract, not here): the
  `closed_and_verified` verification stamp; whether Σ baseline material extended
  values must reconcile to a line's `planned_cost_cents` (v1: advisory, not
  hard-enforced); re-baseline after v1 (out of scope, pointer already shaped in
  B2). Each is stated in `slice-b3-live-record-materials-contract.md` §Open items.
- B3 is the largest slice: decomposed into a **BE** child (migration + services +
  APIs) and an **FE** child (D14–D16 screens), architect owns the migration and
  merges. If the FE proves too large across three screens, D16 (budget movement)
  splits into a follow-up — the frozen API makes that churn-free.
</content>
</invoke>
