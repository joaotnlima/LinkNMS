# 23 — Design tendering (pre-construction)

**Status:** Proposed (D-39) — awaiting founder confirmation. Opened by the Architect for LINA-406.
**Scope:** the distinction between *design* tendering and *execution* tendering, and how the
existing RFP engine generalises to cover both. Does **not** design the BIM/model document itself
(a separate task, deferred by the founder) nor the Directory/Marketplace epic ([07](./07-marketplace-and-billing.md)).

## Why this document exists

[06 — Tendering & contracting](./06-tendering-and-contracting.md) models **one** tendering
mechanism and treats every RFP as *execution*: a package of plan rows priced as a Bill of
Quantities, awarded into a **contract** that merges the awarded subtree into the plan and baselines
the branch. D-04 mentions "a pre-project phase before any RFP" but never models what happens inside
it.

The founder (LINA-406) described a second, earlier use of the same machinery that the to-be does
**not** currently capture: tendering for **design services**, where the deliverable is *the project
itself* — drawings and a material specification — not built work. This document names that phase,
separates it cleanly from execution, and records what is reusable versus genuinely new.

## The two phases

```
PRE-CONSTRUCTION (design)                        CONSTRUCTION (execution)
─────────────────────────                        ────────────────────────
owner needs a project (drawings + spec)          owner has an approved project
   │                                                │
   ├─ DESIGN RFP → architect (base model)           ├─ municipal permit (licença) obtained
   ├─ DESIGN RFP → structure, energy, water …       │     from the design output
   │     each prices producing *their discipline*   │
   │     on the shared design document              └─ EXECUTION RFP → GC and/or specialties
   │                                                      package = plan (Gantt) + BoQ + the
   └─ award ⇒ authoring rights on the model               design model with finish-material
         (iterative: architect base, specialties         changes (brick X → brick Y)
          layer their part on top)                        award ⇒ contract ⇒ BASELINE
                                                           (scope · price · time) — as today (06)
         output: an approved project
         → feeds the permit AND the execution RFP
```

The design output is the hinge between the two phases: it is what the owner submits to the
municipality for a construction licence, **and** it is the package the execution RFP is built from.

### Phase 1 — Design tendering (new)

- The owner (or GC) opens the **marketplace** to engage **design-only** firms — firms that *design*
  and do not execute (a permitting-only architect, a structural engineer, an MEP designer). Many
  such firms exist in pre-construction; the marketplace must surface them with **portfolio samples
  (before vs after)** so the owner chooses on price, fit or taste.
- A **Design RFP** is published; bidders may **open the current design document** ("the document
  that models the building") and raise **clarifications** while they price.
- A proposal here prices a **service** (produce a discipline's design), not a BoQ of built
  quantities. Its shape is a fee / lump-sum / stages, not measured work.
- **Award grants authoring rights on the shared design model**, not an execution contract. This is
  the founder's "assim que adjudicado, a especialidade passa a ter direito a alterar o modelo".
- Authoring is **iterative and multi-discipline**: the architect produces the base model; each
  awarded specialty layers its part (energy, water, structure …) on the same shared document.

### Phase 2 — Execution tendering (already shipped, unchanged)

Exactly the flow in [06](./06-tendering-and-contracting.md): RFP from plan rows, BoQ proposals,
compare, award → contract → merge subtree → baseline. The only connection to Phase 1 is that the
execution RFP **package is seeded from the design output** (the model + its material spec), and the
founder's "small BIM modifications" (finish materials) happen on that model before/within the
execution RFP so the awarded baseline reflects what is actually to be built.

## What is reusable vs new

| Capability | Status | Notes |
|---|---|---|
| RFP lifecycle (draft→published→closed→awarded), invite-only / open, versioned proposals, compare, shortlist, award | **Reusable as-is** | The engine shipped in LINA-360/371/372; see 06. |
| Clarifications / Q&A during proposal | **Partial** | BE exists for authenticated bidders; the public token form exposes neither reading nor asking (gap noted in LINA-406). Needed by *both* phases. |
| Marketplace discovery of firms + portfolio (before/after samples) | **Not built** | Directory/Marketplace epic ([07](./07-marketplace-and-billing.md)); `directory.specialty` catalogue is empty, no FE, no self-serve bid path. **Blocks the design marketplace.** |
| RFP / contract `purpose` discriminator: `design` vs `execution` | **New** | Today everything is execution. Design proposals price a service, not a BoQ; award does not create a build contract or baseline. |
| Shared **design document / model** that bidders open and the winner edits | **New / deferred** | This is the BIM-document concept the founder set aside as a separate task. Without a document to open and author, Phase 1's core cannot be built. |
| Iterative multi-discipline authoring (architect base → specialties layer) | **New / deferred** | Depends on the design-document model above. |
| Hand-off: design output → permit submission + seeds execution RFP package | **New** | A Project-phase transition (pre-construction → construction). Relates to phases/sign-off (ADR-0024). |

## Proposed decision — D-39

> **D-39 (Proposed).** Tendering has two **purposes**: `design` (pre-construction) and `execution`.
> Both run on the one RFP engine (06). They differ in three ways only: (a) a design proposal prices
> a *service* (fee/lump-sum/stages), not a BoQ of built quantities; (b) a design award grants
> **authoring rights on the shared design model**, where an execution award creates a **contract and
> baseline**; (c) the design phase surfaces firms through the marketplace with portfolio samples,
> where execution tendering is typically invite-driven from a known contract chain. The design
> output is the single artifact that feeds both the municipal permit and the execution RFP package.

## Dependencies and sequencing (the honest blocker)

The *end-to-end* design-phase marketplace the founder described **cannot be built in one shot inside
LINA-406** because its two load-bearing pieces are not yet built, and one was explicitly deferred:

1. **Directory / Marketplace epic** ([07](./07-marketplace-and-billing.md)) — `OrganizationProfile`,
   the specialty catalogue, portfolio before/after, search/ranking, and a **self-serve bid path** for
   a firm that was not individually invited. None of this exists; today every proposal requires an
   emailed `rfp_recipient`. This is a product/sequencing decision (opening the epic), not mine to
   make alone.
2. **The shared design document / model (BIM)** — deferred by the founder as a separate task. Phase 1
   has nothing to "open" or grant edit rights to until it exists.

The to-be's own ordering ([00](./00-index.md)) reinforces this: *execution is the wedge; the
marketplace and its trust signal feed on finished, on-platform work*. Design-phase tendering sits on
top of the marketplace, so it is sequenced **after** the Directory/Marketplace epic and the
design-document model, not before.

### Recommendation

- **This task (LINA-406)** delivers *this document* — the architecture that names the phase and locks
  D-39 — and nothing more, because the build is blocked on the two prerequisites above.
- **Next**, with founder approval: open two epics — (E1) Directory/Marketplace, (E2) Design document
  / model (BIM) — and schedule **Design-phase tendering** after both. The already-shipped execution
  tendering is untouched.
- The one piece buildable **now** regardless of the above, and useful to **both** phases, is the
  **clarifications gap** on the public token form (LINA-406 gap #1). It does not need the marketplace
  or the design document.
