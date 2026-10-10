# PRD-09 — Bootstrap a build: overview, participants, Excel import, "your plan is in"

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 2 · bootstrap/Gaps; sticky note n-boot. **Screens not drawn yet**; the reference is the hi-fi mockup `cowork/design/web-app/screens/bootstrap-flow.html` |
| Related docs | flows/01 bootstrap (screens 1–11), to-be/20 §3 |
| Related decisions | D-35 (contract shape derived) |

## 1. Problem

A build is created, and then the product goes quiet:

- There is no build home.
- There is no place to see or invite participants.
- The GC's plan, which already exists in Excel, can't be brought in.
- The owner isn't told when the plan arrives.

The flow doc promises all four, and the UI copy promises some of them too (n-boot).

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| `/projects/{id}` | Redirects to `/plan` | `app/src/app/projects/[id]/page.tsx` |
| `PillarPanel` (schedule, budget, scope, safety tiles) | Exists, **imported nowhere** | `components/PillarPanel.tsx` |
| `getProjectOverview`, `listParticipants`, invitations | Backend registered | `modules/project/http/register.mjs` |
| Participants page | **No route** | — |
| Excel import | **Not built.** `/plan/import` redirects to `/plan?compose=import`, which `/plan` ignores. The parser is gone (`services/schedule/plan-import-parser.mjs` is only referenced in comments). `exceljs` is still a dependency, and a template is generated to `app/public/plan-template.xlsx` | `plan/import/page.tsx`, `app/package.json:17`, `app/scripts/build-plan-template.mjs` |
| Notifications | Backend `/me/notifications`; no UI; the only email is the RFP invite | `modules/collaboration` |
| Copy promising steps that don't exist | Still present | `EmptyPortal.tsx:38`, `lib/build-creation.ts:84` (`BASICS_LEDE`) |
| `creatorRole`, `expectedStart`, "signed contractor?" asked but not sent or persisted | Still true | `lib/v2/build-create.ts:26-30` |
| Invite code says "join as the general contractor" for every role | Still true | `app/invitations/accept/page.tsx:36` |

## 3. Requirements

### 3.1 Build overview: `/projects/{id}` (flow B8)

| ID | Requirement | Priority |
|---|---|---|
| O-1 | The build's home: four pillars (schedule, budget, scope, safety) from `getProjectOverview`, built on `PillarPanel`. Each pillar links to its surface. | Must |
| O-2 | "What's waiting for you": the viewer's pending decisions (bids in, deliverables to review, change orders, sign-offs). | Should |

### 3.2 Participants: `/projects/{id}/participants` (flows A3–A4)

| ID | Requirement | Priority |
|---|---|---|
| O-3 | List of parties: organisation, role on the build, people, invite state. | Must |
| O-4 | Invite action (`PartyInvite`): name, email, role, scope note. Absorbs v1 `/invite`. | Must |
| O-5 | Invite-code acceptance shows the **actual** invited role, not always "general contractor". | Must (bug) |

### 3.3 Excel import (flow A5, screens 8–10)

| ID | Requirement | Priority |
|---|---|---|
| O-6 | Dropzone for `.xlsx` with a sheet picker; reject other types inline. An empty or header-only sheet explains itself and never dead-ends. | Must |
| O-7 | Column mapper: each column → Action / Sub-action / Start / End-or-Duration / Trade / Dependency, with a live preview of ~10 rows. **Only a missing required mapping (Action, Start, End) blocks Confirm.** | Must |
| O-8 | Preview: WBS tree, mini Gantt, row and warning counts. Per-row problems are warnings, not blockers. | Must |
| O-9 | Import into an empty plan. Warn if a plan exists; the diff/merge re-import is a follow-up (flows/01). | Must |
| O-10 | Link the existing template (`app/public/plan-template.xlsx`) from the empty plan and the dropzone. Check it matches the column contract. | Should |
| O-11 | Trade column maps to the specialty taxonomy when it matches (PRD-03 R-2). | Could |

### 3.4 "Your plan is in" (flow A6)

| ID | Requirement | Priority |
|---|---|---|
| O-12 | On import confirm, the record is stamped ("Plan imported by {GC}, {n} actions, {m} sub-actions") and the owner is notified in-app and by email. | Must |

### 3.5 Copy and data fixes (n-boot)

| ID | Requirement | Priority |
|---|---|---|
| O-13 | Either persist `creatorRole`, `expectedStart` and "signed contractor?", or stop asking for them. | Must |
| O-14 | Align the empty-portfolio and Basics copy with the steps that actually exist. | Must |

## 4. Acceptance criteria

1. A GC uploads a typical `.xlsx` with merged Action rows and a blank Action column on sub-rows, maps columns, sees warnings for 2 bad dates, confirms, and the plan shows every row. The owner gets a notification.
2. `/projects/{id}` shows the four pillars instead of redirecting.
3. An invite for a specialty accepted by code says "join as {specialty}".

## 5. Decisions needed

- Excel parsing on client or server. `exceljs` is already a dependency; reuse it server-side, or parse in the browser. Restore or rewrite the removed `plan-import-parser`.
