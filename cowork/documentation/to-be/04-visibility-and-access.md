# 04 — Visibility & access

Three independent checks run on every request, in this order:

1. **Relationship** — what is this organization to this object? (derived, never stored as a role)
2. **Authorization** — may that relationship perform this action? (`iam.can`, pure function)
3. **Entitlement** — does the acting organization's subscription cover it? (`billing.entitled`)

The acting person and organization always come from the verified Clerk session (active organization)
— never from a header or the body. Before the relationship check, the person's **org permission**
(Clerk role) must allow the kind of action — see [16](./16-access-model-clerk.md). Money fields
additionally require `org:money:view`.

## 1. Relationships

| Relationship | Holds when |
|---|---|
| `project.owner` | org = `project.owner_org_id` |
| `project.participant` | org has a `Participation` on the project |
| `contract.client` | org = `contract.client_org_id` |
| `contract.supplier` | org = `contract.supplier_org_id` |
| `contract.ancestor_client` | org is client of an ancestor of the contract (e.g. owner above a sub) |
| `task.assignee` | org = `task.assignee_org_id` |
| `task.coordinator` | org is `contract.client` of the task's contract |
| `task.in_scope` | the row's branch contract has the org as supplier, or as client anywhere up its contract chain; rows outside any branch are the owner's (D-33) |
| `rfp.issuer` / `rfp.bidder` | org issued the RFP / holds a proposal on it |

A person additionally needs `ProjectStaffing` on the project (or org `admin`).

## 2. Read rules (visibility)

| # | Rule |
|---|---|
| **V1** | A `project.participant` reads the whole schedule: every row, dates (baseline, current, actual) and segments, status, assignee organization, links, time and scope variations, comments, and project-scoped documents. |
| **V2** | `contract.client` and `contract.supplier` read that contract's commercial data: BoQ prices, value, change-order amounts, measurements, payment records. |
| **V3** | `contract.ancestor_client` (e.g. the owner above a sub) reads the contract's **existence, supplier identity, specialties, scope text and BoQ descriptions/quantities** — never prices, value, measurements amounts or payments (D-07). |
| **V4** | A supplier never reads sibling contracts' or parent contracts' commercial data. A sub sees the schedule (V1) but not the GC's prime price. |
| **V5** | Task cost is a **projection**: `Σ(boq_item.quantity × unit_price)` over linked BoQ items, computed only from contracts the viewer may read under V2. Otherwise the field is absent (not zero, not null — absent). |
| **V6** | Documents inherit their scope: project → V1; contract → V2 (+ V3 for scope documents flagged `share_with_ancestors`); task → V1; RFP → issuer + invited/qualified bidders; proposal → issuer + author only. |
| **V7** | Ledger entries carry the scope of the change. A viewer without access to the scope receives a **redacted entry** (`seq`, `occurred_at`, `category`, `entry_hash`, `prev_hash`) so the whole chain remains verifiable end-to-end without exposing content. |
| **V8** | Proposals are never visible to competing bidders. Clarification answers are published to all bidders, questions anonymized. |

## 3. Write rules (authorization matrix)

| Action | Allowed relationship |
|---|---|
| Edit project brief, locations | `project.owner` (status `draft`/`tendering`) |
| **Edit the plan** inside a branch: create, rename, move, delete rows; dates, duration, dating mode, child rows, checklist (D-33) | organisations whose **edit scope** contains the row: the branch holder (contract supplier) and every client above it in the contract chain; the owner everywhere. Editing a row assigned to another organisation asks for confirmation and notifies the assignee |
| Create a row | edit scope contains the **parent**; the new row inherits the nearest assigned ancestor's assignee |
| Change a row's assignee organisation | edit scope contains the row's **parent**; the new assignee must be the actor itself or one of its suppliers |
| Set the assignee person | any member of the assignee organisation, or the actor above |
| Add/change/remove a link | edit scope contains the **successor** (the link moves it); the predecessor may be any row |
| Rows outside the actor's scope | read-only; comment and question allowed |
| Edit rows of a proposal | the bidder, inside its own proposal only |
| Move rows by propagation | the system, on behalf of whoever made the triggering change — may move other organisations' rows (D-22), always attributed |
| Acknowledge / question a variation | owner and contract client (acknowledge); any reader (question) |
| Edit cost lines (quantity, unit price, material) | parties of the line's contract only — you cannot edit what you cannot see (V2); the owner edits his own pre-contract estimates |
| Report progress on a row | edit scope contains the row (D-33), attributed |
| Verify / reject completion | organisations whose edit scope contains the row (the client chain up to the owner) **or** a consultant invited with capacity `inspection`/`safety`; never the organisation whose report marked it `done` ([17 §5](./17-personas-roles-interactions.md)) |
| Issue RFP | `project.owner` (owner level) · `contract.supplier` (sub level, under its contract) |
| Submit proposal | invited or qualified org (≠ issuer) |
| Award, sign contract | client manager; supplier manager counter-signs |
| Propose change order | either party of the contract |
| Decide change order | the **other** party (two-sided rule: proposer never decides) |
| Submit measurement | `contract.supplier` · approve: `contract.client` |
| Declare payment made | `contract.client` · confirm received: `contract.supplier` |
| Comment / ask question | anyone who can read the object |
| Review | per eligibility in [07](./07-marketplace-and-billing.md) |

`iam.can({ action, relationships[], actor, subject })` stays **pure**: the application layer
resolves relationships first (via ports), then asks.

## 4. Entitlements

`billing.entitled(org, capability, context)` → `allow | deny(reason, upgrade_hint)`.

| Capability key | Example limit |
|---|---|
| `projects.active` | number of active projects the org may be party to |
| `seats` | people with org membership |
| `rfp.publish` / `rfp.open_listing` | issue RFPs; list them publicly |
| `proposal.submit_open` | bid on open RFPs (credits/month) |
| `schedule.advanced` | CPM view, baselines comparison export |
| `directory.promoted` | promoted placement |
| `reports.export` | exports |

**Sponsorship.** If `contract.sponsored_by_org_id` is set, the supplier's entitlement checks for
that project resolve against the sponsor's subscription (D-05 mitigation). Reads required to take
part in a signed contract (V1/V2) are **never** blocked by entitlements — entitlements gate
*creating* and *managing*, not *seeing what you already agreed to*. Otherwise a lapsed
subscription would lock a party out of evidence about its own contract.

## 5. Implementation notes
- Visibility is enforced in the **query layer**, by a `ViewerContext { person, org,
  readableContractIds, ancestorContractIds, projectIds }` computed once per request and cached.
- Row-level: every read model query filters by `ViewerContext`; commercial columns are selected
  only for `readableContractIds`.
- Tests: every rule V1–V8 has an adversarial test (a viewer who must NOT see a field).
