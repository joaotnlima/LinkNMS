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

- The owner opens the **marketplace** (the listing of linkNMS member orgs) **or invites firms
  directly by email** to engage design firms. Two engagement shapes, the owner's choice
  (founder 1.1 / 1.2):
  - **Turn-key** — award **one** Design RFP to a GC (or a lead architect) that produces the whole
    project (architecture + coordinates the rest).
  - **By specialty** — publish **one Design RFP per discipline** (architect, structure, energy,
    water, MEP …); each firm prices only *its* discipline on the shared model.
  Many firms *design but do not execute*; the marketplace must surface them with **portfolio samples
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

## Founder workflow (LINA-406) — step-by-step feasibility

The founder restated the end-to-end flow (LINA-406 thread, 2026-10-05). Mapping each step to the
architecture confirms the whole workflow **is expressible on the one RFP engine** — the only missing
pieces are the two prerequisites already named below (marketplace directory + versioned design
model). Verdict per step:

| # | Founder's step | Expressible? | Reuses / needs |
|---|---|---|---|
| 1 | Owner opens the marketplace (member listing) **or** invites firms by email, to find firms that can *define the project* | **Design marketplace: blocked** · email-invite: **reuses today** | Invite path = existing `rfp_recipient` + token form. The marketplace listing is the **Directory epic** ([07](./07-marketplace-and-billing.md)) — not built. |
| 1.1 | Turn-key: contract **one GC** to produce the whole project | **Yes** | One Design RFP, `purpose=design`, awarded to one firm. New: `purpose` discriminator. |
| 1.2 | By specialty: contract engineers/firms **per discipline** | **Yes** | N Design RFPs (one per discipline), each awarded independently. Same discriminator. |
| 2 | Award (1.1 or 1.2) | **Yes** | Existing `award` action — but a **design** award grants **authoring rights on the model**, *not* a contract/baseline. New award-effect branch. |
| 2.1 | A **versioned shared BIM model** exists; every selected firm may edit it to finalise the project | **Deferred (hard prerequisite)** | This *is* the BIM-document task the founder set aside. Phase 1 has nothing to open/author without it. Versioning + per-discipline authoring rights are new. |
| 3 | BIM model complete → hand off | **Yes (transition)** | Project-phase transition pre-construction → construction; relates to phases/sign-off (ADR-0024). |
| 3.1 | Identify GC or specialties for **execution** planning — Gantt + BoQ | **Shipped** | Execution RFP from plan rows + BoQ — exactly [06](./06-tendering-and-contracting.md), live. |
| 3.2 | Award execution contract(s) → create **baseline** | **Shipped** | `award` → contract → merge subtree → baseline. Live (LINA-321/354). |
| 3.3 | Any delta between baseline and executed = an **"alteration"** | **Shipped** | Change-order model: budget moves **only** via change orders (ADR-0014); `plan_change_log` + CO guard (LINA-280). This is precisely "alteração". |

**Net:** the back half (3.1–3.3) is fully built and untouched. The front half (1–2.1) is expressible
with three small additions — a `purpose: design|execution` discriminator, a design-award effect that
grants model-authoring instead of a baseline, and a Project-phase hand-off — all of which sit on top
of **two prerequisites that do not yet exist**: the Directory/Marketplace (step 1) and the versioned
shared design model (step 2.1, the deferred BIM task). Neither can be built inside LINA-406.

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
