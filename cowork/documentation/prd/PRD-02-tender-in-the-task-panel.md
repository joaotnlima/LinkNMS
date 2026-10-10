# PRD-02 — Tender from the task panel: compose, send, follow, award

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 3b · B2 TenderCompose, B3 TenderLive, B4 TenderAward, B5 TenderComponents; 4c · C2 Review |
| Related decisions | D-29, D-36, D-39, D-15, D-07 |
| Depends on | PRD-01 (docked panel, tab labels) |
| Extended by | PRD-04 (bidders from the directory, ask to bid, sources) |

## 1. Problem

The mission for the task screen is **plan and create RFPs without leaving it**. LINA-420 got the read side into the drawer: a Tender tab with stepper, dates, bidders and proposals. Every *action* still opens a 1040px modal over the plan: compose, invite, send, compare, award. The modal hides the plan, which is the thing that tells you whether the dates and critical path still work.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| Tender tab: stepper Draft → Out for bids → Comparing → Awarded | Built, no dates under steps | `app/src/components/TenderDrawerTab.tsx:63-74`, `:224-235` |
| Bids due "in N days", Covers, "Plan dates … locked" | Built | `TenderDrawerTab.tsx:238-253` |
| Critical-path note | Built, generic. **No computed award-by date** | `TenderDrawerTab.tsx:256-264` |
| Bidders with status and amount, "+ Invite more" (opens modal) | Built | `TenderDrawerTab.tsx:267-293` |
| Proposals in, "Open in all tenders →", "Close bidding now" | Built | `TenderDrawerTab.tsx:301-336` |
| Compose RFP | **Modal**, one long form plus a separate Invite step | `PlanBuildEditor.tsx:1489-1502`, `ProcurementSection.tsx:252-440`, `:517-577` |
| Compare and award | **Modal**. Compare needs ≥2 shortlisted bids; award does not (any live bid) | `lib/v2/tendering-view.ts:373-388`, `:475-480`; `ProcurementSection.tsx:1029-1039`, `:1638`, `:1696` |
| Orange "Start tendering" card in the Tender tab | Built. Uses the builder party colour for an action | `TenderDrawerTab.tsx:183-192` |

## 3. Goals

1. Compose → review → send → follow → award all happen **inside the docked panel**, with the plan visible.
2. Each step says what it does to the plan: dates lock, critical path, award-by date.
3. One lifecycle vocabulary and colour set everywhere (see PRD-01 G-8).

### Non-goals

- Finding bidders in the directory and the open request (PRD-04). This PRD keeps "add by email".
- The full tenders page `/plan/procurement` and the line-by-line matrix. They stay, linked from the panel.
- Clarifications (PRD-08).

## 4. Requirements

### 4.1 Compose (B2): three steps in the panel

| ID | Requirement | Priority |
|---|---|---|
| T-1 | The Tender tab with no tender shows a neutral, owner-blue "Request proposals" action, not the builder-orange card. | Must |
| T-2 | Step **1 · Scope**: mode (Light design / Detailed build, from D-39), covered tasks (default: the task and its sub-tree), bids-due date and time, invite only / open. | Must |
| T-3 | Scope lists tasks **left out** of the sub-tree with the reason, e.g. "already assigned to Nuno Ferreira", plus an `Include it` action. `＋ Add tasks from the plan` adds other rows. | Must |
| T-4 | Scope shows the **work window** from the plan and states that those dates lock while the tender is out. | Must |
| T-5 | If any covered task is on the critical path, show the award-by date and the working days left between bids-due and the planned start. | Must |
| T-6 | Step **2 · Bidders**: add by email; each shows `Queued` until sent; remove. (Directory search arrives with PRD-04.) | Must |
| T-7 | Step **3 · Review & send**: a summary of scope and bidders and one confirmation stating what sending does: mints a personal link per bidder and locks the dates. | Must |
| T-8 | Each completed step collapses to a one-line summary with `Edit`. Locked steps can't be opened yet. "Discard draft" is always available. | Must |
| T-9 | "Private until you send it" banner while in draft. | Should |

### 4.2 Follow (B3)

| ID | Requirement | Priority |
|---|---|---|
| T-10 | Show dates under each stepper step: created, sent, bids due / comparing from, awarded. | Should |
| T-11 | `Copy link` per bidder who hasn't opened the invite. | Should |
| T-12 | "Record an emailed bid" opens inline in the panel, not the modal. The attachment stays required. | Should |
| T-13 | The award-by date is computed (see §5) and shown in the critical-path alert. | Must |

### 4.3 Compare and award (B4): in the panel at 640px

| ID | Requirement | Priority |
|---|---|---|
| T-14 | Side-by-side columns per proposal: Total, Duration, **Can start**, **Valid until**, **Lines unpriced**, Files, then `Pick`. No averages or ranking. Note: today's full Compare shows a Median column (`ComparisonMatrix`, `ProcurementSection.tsx:1638-1680`). Decide whether the panel and the full Compare follow the same rule. | Must |
| T-15 | Show the task's plan window next to the columns and flag a proposal whose duration or can-start date doesn't fit. | Should |
| T-16 | Award confirmation states the consequences: closes the tender, declines the others, drafts their contract, **unlocks the task dates**, keeps every proposal on the record. | Must |
| T-17 | The panel's side-by-side compare works on all submitted bids. Today the full Compare needs ≥2 shortlisted bids (`tendering-view.ts:475-480`); award is already ungated. | Should |
| T-18 | `Line-by-line matrix →` opens the existing full Compare. Amounts follow the money permission (D-07). | Must |

### 4.4 Lifecycle completeness

| ID | Requirement | Priority |
|---|---|---|
| T-19 | **Cancelled** is a visible state on the chip, band and panel, with a reason line. | Must |

## 5. Data and API

- **Award-by date** = latest award date that still lets the earliest-start bidder start on the planned start, i.e. planned start − mobilisation lead (default 5 working days, a setting). Computed server-side from the plan calendar. The lead-time default is an assumption: validate it with owners and GCs.
- Composer steps call the existing tendering use-cases (create draft, put recipients, publish). No new endpoints are expected; verify that partial drafts can be saved per step.
- `procurementState` needs `cancelled` (shared with PRD-01).

## 6. Acceptance criteria

1. From an unassigned task, a user can create, fill, review and send an RFP without any modal opening and without the grid being dimmed.
2. Sending a tender over a critical task whose bids-due date leaves fewer than N working days before the planned start shows the warning with the computed award-by date.
3. After bidding closes, the panel shows the comparison columns, and awarding from the panel produces the same domain events and records as awarding from the modal today.
4. A cancelled tender shows as Cancelled in the grid chip, the Gantt band and the panel.

## 7. Decisions needed

> **Decided — D-42:** both. The panel covers compose → award; the modal is redesigned as the full workspace (matrix, files, emailed bids).

1. **Modal vs docked panel.** This reverses the LINA-420 modal for compose and award (see PRD-01 §7).
2. **Award-by lead time** default and whether it can be set per task.
