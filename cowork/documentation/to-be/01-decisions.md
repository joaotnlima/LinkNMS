# 01 — Decisions

Decision log from the 2026-09-23 architecture session. Status values: **Accepted** (decided by the
founder), **Proposed** (recommended by the review, awaiting explicit confirmation).

| ID | Decision | Status |
|---|---|---|
| D-01 | Proceed without completing the 12-conversation validation | Accepted — risk owned |
| D-02 | Architecture first: domains and APIs before any UI | Accepted |
| D-03 | Fate of current code decided after the to-be | Accepted |
| D-04 | Project = one build; owner-level contracts are siblings; subs are child contracts | Accepted |
| D-05 | Every organization pays, tiered by value obtained | Accepted |
| D-06 | Visibility follows the contract chain | Accepted |
| D-07 | Owner sees subcontractor identity and scope, never price | Accepted |
| D-08 | Change orders are back-to-back per contract — formalisation is optional (see D-23) | Accepted, amended 09-24 |
| D-09 | Prices are defined by Bill of Quantities (mapa de quantidades) | Accepted |
| D-10 | Payments are recorded, never processed | Accepted |
| D-11 | ~~Gantt edit rights by contract; assignee owns its task dates~~ | **Superseded by D-31** |
| D-12 | ~~Committed vs earliest-possible dates~~ | **Superseded by D-21/D-22** |
| D-13 | Baseline frozen at signature; all changes live | Accepted, refined by D-23/D-24 |
| D-14 | No offline support | Accepted |
| D-15 | RFPs are invite-only or open, chosen per RFP | Accepted |
| D-16 | Reputation: owner rates GC and subs' work; GC ↔ sub rate each other | Accepted |
| D-17 | No company verification; profile completeness boosts ranking | Accepted |
| D-18 | Keep the trust architecture of the as-is | Accepted |
| D-19 | The organization is the commercial actor, not the person | Proposed |
| D-20 | Stable, client-generated identifiers (UUIDv7) | Proposed |
| D-21 | The plan is a WBS; links (starts after / starts with / ends with) drive dates | Accepted |
| D-22 | No link, no chaining; links are rigid (push **and** pull), server-side, duration-preserving, across organisations | Accepted |
| D-23 | After baseline: show the change (clay, variation, notification), do not gate it | Accepted |
| D-24 | No draft: the plan is composed over time; baseline is a label on a branch at signature | Accepted |
| D-25 | Hierarchy depth chosen by the user, up to 10 levels; milestones exist | Accepted |
| D-26 | Save on commit, field-level deltas, last write wins, author and time recorded | Accepted |
| D-27 | No contract column; cost column only where cost lines exist; summaries aggregate | Accepted |
| D-28 | Undated rows allowed everywhere; flagged by a non-blocking plan-health check | Accepted |
| D-29 | RFP launched from a row/subtree; one individual email per recipient | Accepted |
| D-30 | Templates: structure + links only; subtree or whole plan; personal / org / public / LinkNMS library by construction type | Accepted |
| D-31 | ~~Any participant may change any row~~ — narrowed by D-33 | Amended |
| D-32 | Links join anchors (end→start, start→start, end→end); SF kept in the API, hidden in the UI | Accepted |
| D-33 | Edit scope follows branches: each organisation edits and creates only inside its branch; its clients edit inside it too; assignee inherited from the branch | Proposed (generalises the founder's rule) |
| D-34 | RBAC in Clerk (orgs, 7 roles incl. inspector, custom permissions, active org); relationships in LinkNMS; allow = permission ∧ relationship ∧ staffing ∧ entitlement | Proposed |
| D-35 | Contract shape (turnkey / direct / hybrid) is derived from which rows are tendered and awarded | Proposed |
| D-36 | Bids are proposal lanes shown under the tendered row (Tendering), not child rows of the WBS; answer on platform (own plan) or by email (issuer records it) | Proposed (adapts the founder's child-task idea) |
| D-37 | MCP server as a client of /api/v2: acts as the person, dry-run → confirm, human-only acts excluded, tools generated from `x-mcp-tool` | Proposed |
| D-38 | Cost roll-up per viewer is split by side: supplier ⇒ revenue, client ⇒ cost, margin = revenue − cost | Accepted (found by db/v2 checks) |

---

### D-01 — Proceed without full validation
The `02-problem.md` gate required 12 conversations (6 builders, 6 owners). State at decision time:
2 general contractors and 4 owners interested; specialties not yet spoken to. The founder chose
to proceed to test the market.
**Consequence:** the specialty side is the least validated and the one whose payment willingness
(D-05) matters most. Treat specialty-facing features as experiments with explicit success metrics.

### D-04 — Project and contract cardinality
- A **Project** is one build, defined by the owner in a pre-project phase before any RFP.
- A project holds **1..n owner-level contracts**: one `prime` (turnkey) or several `direct`
  (owner ↔ specialty) — siblings, which is how hybrid builds are expressed.
- A supplier may hold **child contracts** (`sub`) under its own contract.
- Multiple buildings (allotments, terraced houses) are **Locations inside one project**, not
  separate projects.

### D-05 — Every organization pays
Owner, GC and specialty each hold a paid subscription, tiered by the value obtained.
**Recorded dissent:** a paywall on participation can leave a gap in a paying GC's record when an
invited subcontractor refuses to pay. **Mitigation adopted:** *sponsored seats* — a contract client
may cover its supplier's entitlement for that project. There is no free participation tier.

### D-06 — Visibility follows the contract chain
Being on the project shows the plan. Being party to a contract shows that contract's money.
Formal rules in [04](./04-visibility-and-access.md).

### D-07 — Subcontractors visible, prices hidden
The owner sees who works on site and what they are contracted to do (also required for safety
coordination, DL 273/2003). The owner never sees subcontract prices or the GC's margin.

### D-08 — Back-to-back change orders
A change order lives on one contract. A GC↔sub change affects the owner only if the GC raises a
linked change order on the prime contract. Links are traceable in both directions.

### D-09 — Bill of Quantities
Contracts and proposals are priced as BoQ lines (chapter, item, unit, quantity, unit price). This
enables line-by-line proposal comparison, measurement-based payment and task ↔ cost links.

### D-10 — Record payments, do not move money
The platform records measurements (autos de medição), expected invoices and payment
declarations/confirmations. No custody, no payment-institution licensing. A PSP can be attached
later through the same model.

### D-11 — Edit rights
Each contract's supplier edits the tasks of that contract. The contract's client coordinates the
dependencies *between* its contracts (the GC across its subs, the owner across direct contracts).
The assignee of a task owns that task's dates.

### D-12 — Committed vs earliest dates (Superseded by D-21/D-22 on 2026-09-24)
Because the assignee owns its dates (D-11), a slipping predecessor would not move a successor and
the project forecast would lie. So every task carries a **committed** date (written by the
assignee) and an **earliest possible** date (computed from dependencies). If committed < earliest
the task is **in conflict**, visible to all. The project forecast uses the later of the two.
Nobody edits another party's task; nobody can pretend not to have seen the slip.

### D-13 — Two plan levels
- **General plan:** per specialty, high-level durations, built in pre-project / RFP. On contract
  signature it becomes that contract's **baseline** (frozen).
- **Execution:** assignees break their tasks into sub-tasks; sub-tasks move the parent's
  **forecast**, never the baseline.
- The owner sees **baseline → forecast → actual** per task until it closes.
- Every change is visible immediately (no draft/publish layer). Disagreement happens on the task
  itself: comments and questions on the activity, or a plan review with the GC.

### D-16 — Reputation
- Owner → GC (contract), owner → subcontractor (the work performed on the owner's project),
  GC → sub, sub → GC.
- Only after the relevant contract is completed or terminated.
- Objective metrics from the record are shown alongside. Details in [07](./07-marketplace-and-billing.md).

### D-17 — No verification process
NIF, IMPIC licence (alvará) and insurance are **self-declared**. Profiles that provide them rank
higher (gamified completeness). Displayed as "declared", never as "verified".

### D-18 — What is kept from the as-is
Modular monolith (domain modules independent of the web framework), PostgreSQL, one schema per
module, the hash-chained ledger written in the same transaction as the domain change, append-only
progress, the pure authorizer, and the two-sided rule (the proposer never decides).

### D-19 — Organization as actor (Proposed)
Contracts, proposals, reviews, subscriptions and profiles belong to **organizations**. People act
on behalf of an organization. A private owner is a `household` organization; a couple is two
people in one household.

### D-20 — Stable identifiers (Proposed)
All aggregates use UUIDv7 generated by the client for creations, so the Gantt can create, link
and reference tasks before the server round-trip. An identifier is never re-minted.

---

## Session 2026-09-24 — plan behaviour

Full behaviour in [05](./05-planning-and-execution.md).

### D-21 — WBS with links that drive dates
The plan is one tree. Rows may be linked (starts after, starts with, ends with, optional lag). Dates
move only by a direct edit or because a link pushes them. Example given by the founder: with *ends
with*, extending the predecessor's end makes the linked task end later and therefore start later.
**Supersedes D-12**: there is no separate "committed" vs "earliest" date; the plan's dates are the
dates, and links keep them consistent.

### D-22 — Propagation rules
Rows are chained **only** by an explicit link. A link is rigid: when the predecessor moves later
the successor is pushed, and when it moves earlier the successor is pulled. Propagation is
server-side and topological, keeps each moved row's duration, crosses organisations, and records the
cause on each moved row. Dragging a linked row changes its lag. Started rows keep their actual start;
done rows never move. (The review had proposed push-only, so that a subcontractor is never pulled
earlier without agreeing; the founder chose rigid links. The pull is notified to the moved row's
assignee like any other move.)

### D-23 — Show the change, do not gate it
After baseline, every time/cost/material/scope change creates a Variation, is drawn in clay against
the baseline, and notifies the owner with a link to the change view. The owner acknowledges,
questions, or phones; the responsible party adjusts if they agree. A change order (D-08) is an
**optional** formalisation that re-baselines; it is not required for the plan to change.
**Recorded dissent (once):** "shown" is not "agreed". The product's founding problem is two parties
without a record the other accepts. Mitigation adopted: the acknowledgement (who opened what, when)
is recorded, and formalisation stays one click away.

### D-24 — No draft
The plan is built over time by the parties who join (owner, architect, engineers, then bidders).
A branch becomes baselined when its contract is signed — scope, time, cost and quality (PMP).
Replaces the as-is private draft → proposal → acceptance workflow.

### D-25 — Depth and milestones
From 1 to 10 levels, the user's choice. Summaries derive dates and cost from their children.
Milestones exist, with optional dates.

### D-26 — Concurrency
Changes are sent when the user commits them (drop a bar, leave the cell), as field-level deltas with
the value the client saw. The last write wins per field; overwrites are reported to the overwritten
person; every delta is in the ledger with author and time. Changes reach everyone through the live stream.

### D-27 — Columns
No contract column. A cost column exists and shows a value only where the row or its subtree has cost
lines visible to the viewer; summaries aggregate their children.

### D-28 — Undated rows
Allowed in every phase (a licence cannot be scheduled; it depends on the municipality). A non-blocking
plan-health check flags them before an RFP, before signature, and in the execution health panel.

### D-29 — RFP from the plan
Documents attach to rows. From a row or subtree the user requests proposals from platform
organisations (by area/specialty) and/or email addresses. Each recipient receives an **individual**
email with a personal link, so no bidder learns who else is competing.

### D-30 — Templates
Structure and links only: no dates, durations, assignees or prices. The know-how a GC reuses is the
sequence; the specialties vary. Any subtree or the whole plan can be saved. Scopes: personal,
organisation, public (marketplace), and a LinkNMS starter library per construction type. On insert,
unneeded specialties can be unticked and links through removed rows are bridged. See [05 §11](./05-planning-and-execution.md).
Durations are **not** saved: the same trade takes 3 weeks on one build and 2 months on another,
because it depends on the size to cover.

## Session 2026-09-24 (cont.)

### D-31 — Anyone can change the plan
Any project participant can create, move, date, link, delete and change the status of any row. New rows
have no assignee. When the editor is not the assignee, the UI asks for confirmation, the change is
attributed and the assignee is notified. **Supersedes D-11** (edit rights by contract) and resolves P10.
Two limits stay, because they protect the record rather than the plan: cost lines are editable only by
the parties of their contract, and `verified` must come from a different organisation from the one that
marked the row `done`.

### D-32 — Links as anchors
A link joins the start or end of one row to the start or end of another: end→start (starts when it
ends), start→start (starts with), end→end (ends with). The current app already offers exactly these
three, so there is no functional gap. Gaps vs the current app: no lag, and *ends with* stretches the
successor instead of moving it (see [13](./13-gap-analysis.md) P4). start→end (SF) exists in the API for
completeness and is not offered in the UI.

### D-33 — Edit scope follows branches (narrows D-31)
The founder's rule: a subcontractor holds a row with a hierarchy under it and may change and create rows
only inside it; the GC creates rows there and may change their assignee, which defaults to the
subcontractor. Generalised to every organisation:
- A **branch** is a row bound to a contract (`task.contract_id`) plus everything under it. It belongs to
  the contract's supplier.
- An organisation's **edit scope** is its own branches plus every branch of the contracts it is the
  client of, down the chain. The owner's scope is the whole plan (it is the client at the top, and
  owns the rows outside any branch — licensing, coordination).
- Inside its scope an organisation can create, edit, move, delete and link rows, and report progress.
  Outside it the plan is **read-only**; the organisation can still comment and ask questions.
- A **link** can be created by whoever has the **successor** in scope, because the link moves the
  successor. The predecessor can be any row.
- **Assignee.** A new row inherits the assignee of its nearest assigned ancestor (the API does it).
  Only an organisation whose scope contains the row's parent can change the assignee organisation, to
  itself or to one of its suppliers. Anyone in the assignee organisation can set the person.
- Within scope, editing a row assigned to another organisation (a GC editing a subcontractor's row)
  still asks for confirmation and notifies the assignee (D-31).
- The two limits of D-31 stand: cost lines by contract parties only, and `verified` from another
  organisation.

### D-34 — Access model split between Clerk and LinkNMS (Proposed)
Clerk holds identity, organisations (households included), role per member, custom permissions and the
active organisation. LinkNMS holds every project relationship (participation, contract parties, branch
scope, staffing). The in-DB role catalogue of the as-is is deleted. `org:money:view` adds a
confidentiality layer inside each company. Full model in [16](./16-access-model-clerk.md).

### D-35 — Contract shape from the tree (Proposed)
Tendering the execution summary to one company makes a prime (turnkey). Tendering specialty rows
separately makes direct contracts. Mixing both makes a hybrid. The GC tenders inside its prime branch
with the same mechanism. `operating_model` is derived for display.

### D-36 — Proposal lanes (Proposed)
The founder proposed one child task per RFP invitee, holding that invitee's plan, with the comparison
on the parent. The UX is kept: lanes are drawn under the tendered row and the comparison is
pre-computed there. The storage is not: bids live in Tendering, because as real WBS rows they would
corrupt roll-ups (the sum of competing prices), leak prices to other participants, and litter the
ledger. Answers come on the platform (the bidder's own plan) or by email (PDFs recorded by the issuer).
On signature the winner's plan is copied into the project and baselined.
