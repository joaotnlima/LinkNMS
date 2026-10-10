# PRD-10 — Plan and execution: baselines, gated start, daily log, site calendar, sign-off

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 3 · plan/Gaps; plan/PlanSignOff (dormant); sticky note n-plan. **Screens for these items are not drawn yet** |
| Related decisions | D-13, D-21, D-22, D-23, D-24 |
| Related docs | to-be/05 planning & execution, flows B12, B13, C14, E23 |

## 1. Problem

The plan can be built (and, with PRD-02, bought), but not **run**:

- Accepted plans don't become visible baselines.
- Tasks can start before what they depend on is done.
- There is no daily account of the site.
- Nobody sees two trades colliding on the same day.
- The sign-off screen exists but never appears.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| "Measured against baseline v{N}" line | Built, with no baselines screen | `app/src/app/projects/[id]/record/page.tsx:122` |
| `listBaselines`, `getSiteCalendar` | **In the v2 contract only, not registered** | `cowork/documentation/api/v2/openapi.yaml` |
| Variations (`listVariations`, `acknowledgeVariation`, `questionVariation`) | Backend registered | `modules/planning/http/register.mjs` |
| Dependencies authored in the plan | Built | `PlanBuildEditor.tsx` |
| Start gated by dependencies; acceptance criteria | **UI not built.** `acceptance_criteria` is persisted and patchable on the backend (also in baseline snapshots); the front end only has the type | `modules/planning/infra/pg-store.mjs:23,161`, `use-cases.mjs:46,1361`, `lib/v2/planning-view.ts:87` |
| Daily log and site photos | Not built | — |
| Working calendar `GET/PUT /projects/{id}/calendar` | Backend registered | `modules/project/http/register.mjs:71-74` |
| Sign-off panel (approve and lock, request changes, history) | Built, **dormant**: only shows when the execution phase isn't pending, and nothing in v2 activates it | `components/SignOffPanel.tsx`, `plan/page.tsx:138-150` |

## 3. Requirements

### 3.1 Baselines and variations: in the plan, not a separate page (see PRD-13)

| ID | Requirement | Priority |
|---|---|---|
| E-1 | Baseline selector in the plan header (v1, v2, …) with when, why and who. D-24: a baseline is a label on a branch. No `/plan/baselines` page. | Should |
| E-2 | Comparing against the chosen baseline is the bar itself (ghost, clay, overrun) and the "vs baseline" column: PRD-13 S-1 to S-9. Added and removed rows come later. | Must → PRD-13 |
| E-3 | Variations: the "Changes since baseline" panel and the task panel (PRD-13 S-13 to S-16). | Must → PRD-13 |
| E-4 | — (the record page is parked) | — |

### 3.2 Gated start and acceptance criteria (flow B12)

| ID | Requirement | Priority |
|---|---|---|
| E-5 | The task panel shows what a task waits on, with each predecessor's state. Starting a task whose predecessors aren't done asks for an explicit override with a reason, which goes on the record. **Decision:** hard gate or warn and record? D-23 leans to warning. | Must |
| E-6 | Acceptance criteria: a checklist on the task. Closing the task records which criteria were met. For design tasks this is PRD-05's deliverables. | Should |

### 3.3 Daily log and site photos (flow B13; phone-first)

| ID | Requirement | Priority |
|---|---|---|
| E-7 | Per build per day: who was on site (organisations, headcount), weather, work done against tasks, issues, and photos tagged to tasks or locations. | Must |
| E-8 | Phone-first capture with camera upload into Documents (`kind='photo'`). D-14 rules out offline support: say so in the UI when there is no connection. | Must |
| E-9 | Read view on the task (photos) and on the record (by day). | Should |

### 3.4 Site calendar and overlaps (flows C14, E23)

| ID | Requirement | Priority |
|---|---|---|
| E-10 | Who is on site when, by organisation and location, derived from task dates and assignments. | Must |
| E-11 | Overlap detection: two trades in the same location on the same day, flagged with a link to both tasks. | Should |
| E-12 | Feeds the disruptive-work notice of flow E23 (PRD-12). | Could |

### 3.5 Activate sign-off

| ID | Requirement | Priority |
|---|---|---|
| E-13 | Define what moves the execution phase out of `pending` in v2, so the sign-off panel can appear. Without this, PlanSignOff stays dead code. | Must |

## 4. Acceptance criteria

1. After signature, v1 appears in baselines. Moving a task 5 days creates a variation, and the compare view shows +5 d on that task.
2. Starting a task whose predecessor is open requires a reason, and the override is visible on the record.
3. A foreman on a phone logs today's headcount and 3 photos tagged to task 2.5 in under 2 minutes.
4. Two trades scheduled in "Roof" on 3 Feb appear as an overlap.

## 5. Decisions needed

> **Decided — D-48:** starting before predecessors are done warns and records a reason (no gate).

1. Gate or warn for dependency start (E-5).
2. The execution-phase activation rule (E-13).
3. The location model for overlap detection: does `project.location` (the location tree) suffice?
