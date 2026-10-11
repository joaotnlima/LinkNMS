# PRD-01 — Plan grid and docked task panel

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 3b · B1 TenderNone, B5 TenderComponents, Component · PlanGrid |
| Related decisions | D-21, D-22, D-25, D-28, D-29, D-33 |
| Depends on | — (foundation for PRD-02, PRD-04, PRD-05) |

## 1. Problem

The plan is where owner and GC spend their day, but three things the planning work needs are missing or capped:

- **Depth.** Real builds break down 4–5 levels (phase → trade → element → sub-element). The UI stops at 3.
- **Tender visibility.** A row says it is being tendered only through a chip squeezed into the task-name cell. There is no Tender column, no filter, and descendant rows don't say they are covered by a parent's RFP.
- **Context loss.** The task drawer is a 440px overlay over a dimmed grid. While it is open you can't see the plan you are planning.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| Columns ID / Task / Status / Specialty / Owner, fold carets, drag grip | Built | `app/src/app/projects/[id]/plan/build/PlanGrid.tsx:1495-1515` |
| Search, Owner, Status, Overdue, Blocked filters | Built | `PlanGrid.tsx:1360-1440` |
| Critical-path toggle (dims non-critical rows) | Built | `PlanGrid.tsx:453-463`, `:1417`, `:1771`, `:1887` |
| Zoom Fit/Weeks/Months/Quarters/Years, Today | Built | `PlanGrid.tsx:96-103` |
| Tender chip (Draft RFP / Tendering / Comparing / Awarded) inside the name cell | Built | `PlanGrid.tsx:321-326`, `:1612-1634` |
| Gantt procurement band, dates locked while out to tender | Built | `PlanGrid.tsx:1759-1784`, `:898-945` (LINA-413) |
| Drawer tabs Plan / Tender / Conversation | Built | `PlanBuildEditor.tsx:1236-1264` (LINA-420) |
| Outline depth | **Capped at 3** in UI; backend allows 10 | `lib/plan-authoring.ts:20,547,1712`; `lib/v2/planning-hydrate.ts:19-29,76`; `modules/planning/application/use-cases.mjs:1269` |
| Drawer layout | 440px overlay over a dimmed grid | `PlanBuildEditor.tsx:1173-1183`, `plan-build.css:306-315` |

## 3. Goals

1. Plan to the depth the build needs (target 5 levels in the UI; D-25 allows 10).
2. Make tender state readable from the grid alone, for every row including descendants.
3. Keep the grid visible and usable while a task is open.

### Non-goals

- Composing, sending or awarding a tender (PRD-02).
- The Files tab content (PRD-05). This PRD only reserves the tab.
- Baselines and variations (PRD-10).

## 4. Requirements

### 4.1 Grid

| ID | Requirement | Priority |
|---|---|---|
| G-1 | Render, create, indent and fold rows to at least **5 levels**. The hydrate step must stop discarding rows deeper than 3. Indentation and the ID scheme (`2.5.2.2.1`) stay readable at level 5. | Must |
| G-2 | A dedicated **Tender** column, after Owner. Chip states: none (shows `＋ Tender` on row hover only), Draft, Out for bids `n/m in`, Bids in — your move, Awarded `· {company}`, **Cancelled**. | Must |
| G-3 | Rows covered by an ancestor's RFP show a marker in the Tender column: `↳ {RFP name}` in the same lifecycle colour. | Must |
| G-4 | **Tender filter**: any / none / draft / out for bids / bids in / awarded. | Should |
| G-5 | Summary rows show the descendant count next to the name, e.g. `(10)`. | Could |
| G-6 | Split view: ID and Task are pinned; the other columns scroll with the table; **only the timeline pane scrolls horizontally**, independently. A draggable divider sets the split. | Must |
| G-7 | A critical-path note under the grid: the number of critical tasks and the float of the selected task. | Should |
| G-8 | Lifecycle colours are the same on the chip, the Gantt band and the panel: draft neutral, out for bids owner-blue, bids in amber, awarded green, cancelled red. Every state also carries a word, never colour alone. Today tendering is amber and bids-in is accent (`plan-build.css:738-742`); align them. | Must |
| G-9 | Dates locked while out for bids render as a dashed bar. | Should |

### 4.2 Docked task panel

| ID | Requirement | Priority |
|---|---|---|
| P-1 | The panel docks to the right at **480px**, widening to 640px when a step needs it, such as compare. The grid stays interactive and does not dim. | Must |
| P-2 | **Four tabs: Plan · Tender · Conversation · Files.** Each tab label carries its state: Tender `none` / `draft` / `1/3` / `3 in` / `awarded`; Conversation unread count; Files count or `n to review`. | Must |
| P-3 | Plan tab: Status, Owner, Specialty, Dates, a Schedule row (`◆ Critical path · 0 days float`), Links, Description, and a Breakdown block (`10 sub-tasks across 4 levels`, `＋ Add sub-task`). | Must |
| P-4 | Plan tab: a "Who does this work?" choice, with two options: someone already on the build (assign) or **Request proposals**, which opens the Tender tab. | Should |
| P-5 | The panel opens for a task reached by permalink with the **same props as the in-grid drawer**. Today `tasks/[stageKey]/page.tsx:88-110` passes no `canStartTender`, `procurement` or `tenderInitialRfps`, so the Tender tab, chips and band are missing. | Must (bug) |

### 4.3 Clean-up

| ID | Requirement | Priority |
|---|---|---|
| C-1 | Remove or implement `/plan/build` and `/plan/import`. Both redirect to `/plan?compose=…`, which `/plan` ignores. Excel import is PRD-09. | Should |
| C-2 | Fix the wrong comment in `plan/import/page.tsx`, which claims the wizard is still imported by the plan page. | Could |

## 5. Data and API

- No schema change for depth (D-25 already allows 10). Change `lib/plan-authoring.ts` and `lib/v2/planning-hydrate.ts`.
- The Tender column reads the existing procurement state.
  - Add `cancelled` to `procurementState` (`lib/plan-gantt.ts:328`).
  - Add a `submitted/invited` count to the plan view model so the `n/m in` chip needs no extra request per row.
- Float per task comes from the existing critical-path computation. Expose the float value if the view model doesn't already carry it.

## 6. Acceptance criteria

1. A plan seeded with a 5-level branch loads, renders, folds, indents and outdents at every level, and round-trips without losing rows.
2. With an RFP covering `2.5` and its sub-tree, the grid shows the chip on `2.5` and `↳` markers on every covered descendant, in the lifecycle colour.
3. Scrolling the timeline horizontally never moves the ID/Task columns. Scrolling the table vertically keeps the timeline rows aligned.
4. With the panel open, the user can click another row and the panel switches task without closing. The grid is not dimmed.
5. Opening `/projects/{id}/plan/tasks/{key}` on a non-baselined plan shows the Tender tab when the task has a tender.

## 7. Decisions needed

> **Decided — D-42:** both. The docked panel and a redesigned modal for the full workspace.

- **Docked panel vs modal.** LINA-420 shipped tender compose, compare and award as a 1040px modal over the plan (`PlanBuildEditor.tsx:1482-1520`). This PRD and PRD-02 move them into the docked panel. Keep the modal only for the full-screen compare, linked from the panel. Neither doc 23 nor any decision records the modal choice, so it is free to change, but it reverses shipped work.

## 8. Risks

- Five levels in a 480px-wide grid next to a panel is tight. Validate the compact density (500px table) on a 1440px screen before building.
- Changing the hydrate cap may surface rows that exist in the database but were silently dropped. Check production data for rows deeper than 3 before release.
