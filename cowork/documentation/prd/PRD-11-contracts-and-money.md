# PRD-11 — Contracts and money: contract tree, change orders, measurements, payments

| | |
|---|---|
| Status | **PARKED** (founder, 2026-10-10): contracts, money and change orders stay API-only for now. No new pages. Schedule changes are shown in the plan instead (PRD-13). Kept for later reference; K-11 (€ formatter) can still ship on its own |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 5 · record/Gaps; sticky note n-record; kept as-built boards RecordSchedule, RecordHistory, Audit, Money, ChangeOrders, ChangeOrder. **New screens not drawn yet** |
| Related decisions | D-04, D-07, D-08, D-09, D-10, D-23, D-27, D-38 |
| Related docs | to-be/06 tendering & contracting, to-be/20 §3–4, flows B9, D18–D20 |

## 1. Problem

An award drafts a contract, but there is nowhere to read it or act on it:

- `/budget` shows money without the contract behind it.
- Change orders live at a top-level URL with no contract parent.
- "+ Raise change order" is disabled.
- Measurements and payments exist only in the API.
- Money is shown in **$** in the app but **€** on RFPs.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| `/projects/{id}/budget` (Money) | Built | `app/src/app/projects/[id]/budget/page.tsx` |
| Change-order list and detail | Built; detail at top-level `/change-orders/{id}` | `change-orders/page.tsx`, `app/change-orders/[id]/page.tsx` |
| Raise change order | **Disabled**; `/change-orders/new` redirects to the list; `.rc-kinds` CSS unused | `change-orders/page.tsx:58` |
| Contracts (create, get, sign, close, terminate, financials), measurements (suggest, create, approve, dispute), payments (confirm, dispute), cash flow | Backend registered | `modules/contracting/http/register.mjs` |
| Currency | `lib/format.ts` hardcodes `$` and en-US; tendering uses € | `lib/format.ts`, `lib/v2/tendering-view.ts:182` |
| Record Plan and Money tabs | Placeholders (`PendingTab`); `/budget` links to the Plan placeholder | `record/page.tsx`, `budget/page.tsx:201` |

## 3. Requirements

### 3.1 Contract tree and detail (to-be/20)

| ID | Requirement | Priority |
|---|---|---|
| K-1 | `/projects/{id}/contracts`: every contract the viewer can see, as a tree (owner-level contracts are siblings, subs are children, D-04). Each node shows party, scope, state and value **where the viewer may see it** (D-07: the owner never sees sub prices). Absorbs `/budget`. | Must |
| K-2 | `/projects/{id}/contracts/{id}`: parties, scope (tasks), BoQ lines (D-09), state, sign/close actions, financials (contracted, measured, paid, to complete). | Must |
| K-3 | `/budget` redirects to `/contracts`. `/change-orders/{id}` moves under its contract and the old URL redirects. | Must |

### 3.2 Raise a change order (flow B9)

| ID | Requirement | Priority |
|---|---|---|
| K-4 | `…/contracts/{id}/change-orders/new`: kind (scope / time / both), **reason** (separate from the title, which today doubles as the reason), BoQ lines added, changed or removed, and time impact. | Must |
| K-5 | Back-to-back per contract (D-08). Formalisation is optional (D-23 amendment). | Must |

### 3.3 Measurements, or autos de medição (flow D18)

| ID | Requirement | Priority |
|---|---|---|
| K-6 | Per period: quantities executed against BoQ lines (suggested from task progress), submitted by the supplier side, approved or disputed by the client side. | Must |
| K-7 | Approval unlocks the payment milestone. "Measured" on Money reads from here. | Must |

### 3.4 Payments, cash flow, cost to complete (flows D18–D20)

| ID | Requirement | Priority |
|---|---|---|
| K-8 | Payments are **recorded, never processed** (D-10): confirm received, or dispute. | Must |
| K-9 | Owner cash flow across contracts, and a variance report (plan vs measured vs paid). | Should |
| K-10 | Cost roll-up per viewer side: supplier sees revenue, client sees cost, margin = revenue − cost (D-38). | Must |

### 3.5 Fixes (n-record)

| ID | Requirement | Priority |
|---|---|---|
| K-11 | **One money formatter**, € and pt-PT/en locale, used everywhere. Remove `$` from `lib/format.ts`; tendering's `formatMoney` shows € but with the en-US locale (`lib/v2/tendering-view.ts:178-185`). | Must |
| K-12 | Fill or remove the record's Plan and Money placeholder tabs. | Should |

## 4. Acceptance criteria

1. An owner on a turnkey build sees the GC contract and its subs' scope, but no sub prices anywhere in the tree or the detail.
2. A change order raised with kind "time" and a reason appears under its contract, and the old URL redirects.
3. An approved measurement updates Measured on the contract and the cash flow.
4. No `$` remains in the UI.

## 5. Decisions needed

- Is a measurement suggested automatically from task progress, or entered manually first?
