# PRD-13 — Changes against the baseline, shown and managed in the plan

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 3b · B6 Slippage, B7 SlipEdit, B8 SlipChanges |
| Replaces | the separate record and change-order pages for schedule changes. The record row is parked in the APAGAR area; PRD-11 is parked |
| Related decisions | D-13, D-22, D-23, D-24, D-26 |
| Related docs | to-be/05 §5 (segments), §6 (variations), §7 (notifications batched in 15 minutes) |
| Depends on | PRD-01 (grid, docked panel); PRD-12 N-1 (notification centre) |

## 1. Problem

What changed against the plan is the heart of the record, but a separate "record" page is the wrong place for it. People look at the plan. A late or extended task should **change the plan view itself**:

- When someone **extends** a task, the bar grows in clay by the extra working days, from the baseline finish to the new finish.
- When a task **isn't closed** by its finish date, the bar keeps growing in clay **up to today**, every day, until someone closes it or sets a new finish.

Money and change orders stay in the API for now. No new pages.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| Render-ready segments `baseline`, `delay_start`, `current`, `extension`, `actual` | **Backend built** | `modules/planning/application/projection.mjs:20-37` |
| Any UI drawing those segments (ghost, clay extension, hatch) | **Not built** | `PlanGrid.tsx`, `V2PlanGridReadOnly.tsx` |
| Overdue detection and filter in the grid | Built | `PlanGrid.tsx:446`, `:466-479` |
| Variations: list, get, acknowledge, question | Backend registered | `modules/planning/http/register.mjs` |
| Baseline snapshot | Taken at **contract signature** (D-13). There is no UI to sign contracts | doc 05 §5; `signContract` in contracting |
| "Overdue running" (not closed past finish, growing to today) | **No segment for it** | — |

## 3. Goals

1. Anyone opening the plan sees at a glance which tasks are late, by how much, and why. The handover date's net change is in the header.
2. The task owner moves a finish date in the panel and sees, **before saving**, what it pushes and who is told.
3. The owner acknowledges or questions each change from the plan. Nothing gates the work (D-23).

### Non-goals

- Cost and material variations, change orders, contracts and payments (PRD-11, parked).
- Baseline comparison of scope (rows added or removed). This can follow later.

## 4. Requirements

### 4.1 The bar (B6)

| ID | Requirement | Priority |
|---|---|---|
| S-1 | Render the backend segments. **Planned** is the normal blue bar. The **baseline ghost** (dashed outline) shows only where the bar moved. **Extension** is solid clay (`status-pending-change`) from baseline finish to current finish. **delay_start** is a clay hatch on the ghost. | Must |
| S-2 | New segment **`overrun`**: task not done and `today > current.finish` → hatched clay from `current.finish` to today, with an arrow tip at today. It grows daily. Computed server-side like the others (doc 05: "no client computes them"). | Must |
| S-3 | A task closed late keeps a solid clay segment (baseline finish → actual finish). A task closed early shows green done plus a ghost and "−n wd". | Must |
| S-4 | Every clay segment has a **label**: `+5 wd · moved by TN`, `+5 wd · not closed`, `+3 wd · pushed by 2.3`, `+7 wd · closed late`. Never colour alone. | Must |
| S-5 | Grid column **vs baseline**: `+n wd` (clay), `on plan` (muted), `−n wd` (green). Summary rows show their net. | Must |
| S-6 | Header: project handover with the net change (`◆ Handover 7 May · +5 wd`) and `Changes since baseline · n` with an unseen count. | Must |
| S-7 | Filter **Late or extended**. | Should |
| S-8 | Legend under the grid. | Should |
| S-9 | Overrun (S-2) works **without a baseline**: it compares with the current finish. Extension and ghost need a baseline. | Must |

### 4.2 Moving a finish date (B7)

| ID | Requirement | Priority |
|---|---|---|
| S-10 | Editing a date on a baselined task shows an impact note **before commit**: working days versus baseline, linked tasks pushed (names), new handover date, and who will be notified. | Must |
| S-11 | Optional "Why?" stored on the variation. No approval step (D-23). Save follows D-26 (field delta). | Must |
| S-12 | Overdue prompt on the owner's task: "should have finished on {date}", with `Mark done` and `Set a new finish`. The owner also gets a notification on the first overdue working day. | Must |

### 4.3 Reviewing changes (B6 panel, B8)

| ID | Requirement | Priority |
|---|---|---|
| S-13 | Plan tab: Baseline vs Now (dates, working days, delta), critical-path effect, and **Changes on this task**: who, when, from → to, reason, notified at, seen state. | Must |
| S-14 | Owner actions: **Acknowledge** (records who and when) and **Ask a question** (opens a question to the responsible party). The change-order link stays hidden while PRD-11 is parked. | Must |
| S-15 | **Changes since baseline** panel (opened from the header): every variation, newest first, with net effect on handover, filters (all / not seen / time), `Acknowledge all in view`, and a link to each task. Propagated changes say "pushed by {task}; nobody edited this row". | Must |
| S-16 | Notifications batched per project in a 15-minute window, with the net effect (doc 05 §6). | Must |

## 5. Data and API

- Add `overrun` to `segmentsOf` (`projection.mjs`). It needs `today` (already a parameter) and `task.status`.
- Overrun is **not** a variation until someone acts: it changes no stored data. When the task closes late, the variation is `time` with cause `closed_late`.
- The task view model needs `deltaWd` versus baseline (working days, on the project calendar) and `seenByViewer` per variation. Handover net delta: on the plan view model.

## 6. Acceptance criteria

1. After baseline, a task whose finish moves from 26 Feb to 5 Mar shows a clay segment labelled `+5 wd`, a ghost of the baseline, `+5 wd` in the column, and the handover delta in the header.
2. A task not closed 5 working days after its finish shows a hatched segment to today. The next working day it shows +6 wd, with no edit made.
3. The owner is notified once per 15-minute window. Acknowledge stores who and when, and the unseen count drops.
4. Before saving a new finish, the task owner sees the linked tasks it pushes and the new handover date.
5. No clay is shown on a plan that has no baseline, except overrun.

## 7. Decisions needed

> **Decided — D-43:** the baseline is taken at award for the awarded branch, with start and duration from the winning proposal. **D-44:** overrun is drawn to today; successors show a projection only.

1. **When is the baseline taken?** D-13 takes it at **contract signature**, and contracts are parked. Without a baseline there is no clay extension. Options:
   - (a) on **tender award** for the awarded branch;
   - (b) when the owner **approves the plan** (the dormant sign-off, PRD-10 E-13);
   - (c) keep signature and build the minimal sign action.

   Recommendation: (a) plus (b). Award is the commitment moment, and approval covers tasks done in-house.
2. **Does an overrun push linked successors automatically every day?** D-22 links push. Pushing daily rewrites other parties' dates without anyone editing. Recommendation: show the projected push as a ghost and write it only when someone sets a new finish or closes the task. B6 currently shows 2.5.2 as pushed; adjust if you choose this.
3. **Colour.** Clay `#a9601f` is close to the builder party colour `#b4633b`, and `plan-actual` uses the builder colour. Keep hatching and labels mandatory, and don't use builder orange for the actual-progress fill.
