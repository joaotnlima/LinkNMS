# Gantt on /api/v2 — mapping the current plan grid to the to-be contract

**Answers LINA-308 item 3**: how the existing Gantt/plan-grid UI
(`app/src/app/projects/[id]/plan/build/PlanBuildEditor.tsx`, `PlanGrid.tsx`,
`app/src/app/projects/[id]/plan/PlanBaseline.tsx`, `app/src/lib/plan-gantt.ts`,
`app/src/lib/plan-authoring.ts`) is implemented calling **only `/api/v2`**
([`openapi.yaml`](./openapi.yaml)), and what — if anything — is missing from the contract.

Companion docs: [13 — gap analysis §Planner UX](../../to-be/13-gap-analysis.md) (P1–P13),
[05 — planning & execution](../../to-be/05-planning-and-execution.md),
[11 — API conventions](../../to-be/11-api-conventions.md).

---

## 1. Capability → operation map

Every user-facing capability of the current grid, and the v2 operation(s) that serve it.
OperationIds are exactly as in `openapi.yaml`.

### 1.1 Load & render

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Load the whole plan (tree + links + dates + status + cost + health) | `getSchedule` | `GET /projects/{projectId}/schedule` | One `Schedule`: `tasks[]` (flat, `parent_id`+`depth`+fractional `position`), `links[]`, `calendar`, `health`, `stream_cursor`. Optional query narrowing: `root`, `depth`, `assignee`, `location`, `status`, `state`. |
| Bar segments (baseline ghost / current / clay extension / delay hatch / actual fill) | `getSchedule` | — | `Task.segments[]` (`Segment.kind` ∈ `baseline·current·extension·delay_start·actual`) are **render-ready from the server**; the client draws, never computes them. |
| Per-row editability (grey-out rows outside my branch) | `getSchedule` | — | `Task.can_edit` boolean per row; `Task.editor_is_assignee` drives the "not responsible — change anyway?" confirm. |
| Non-working-day shading, drag math in work days | `getCalendar` | `GET /projects/{projectId}/calendar` | `Calendar{work_days[], holidays[], closures[]}`; also embedded in `getSchedule`. `putCalendar` (owner/prime) edits it. |
| Parent status meter / roll-ups | `getSchedule` | — | `Task.status` is server-derived (incl. summaries); client only paints the meter segments. |
| Plan-health panel (undated, unassigned, open external, sequence warnings, uncosted) | `getPlanHealth` | `GET /projects/{projectId}/schedule/health` (`?root=`) | `PlanHealth` with `TaskRef[]` per check, `blocking: false` always; also embedded in every `TaskDeltaResult` and `ScheduleApplyResult`. |
| Baselines list (which branch is controlled, versions) | `listBaselines` | `GET /projects/{projectId}/baselines` (`?root=`) | Page of `Baseline{contract_id, version, reason, root_task_ids[]}`. |

### 1.2 Rows — create / edit / delete

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Add a row (`+ Add task`, add sub-task) | `createTask` | `POST /projects/{projectId}/tasks` | `TaskCreate` with **client-generated UUIDv7 `id`** (required), `parent_id`, `after_position`, `kind` ∈ `task·milestone`; returns `TaskDeltaResult` (row + propagation + health). Assignee inherited from nearest assigned ancestor. |
| Rename, description, dates typed in cells, specialty, dating mode | `updateTask` | `PATCH /tasks/{taskId}` | `TaskDelta`: `client_change_id` (uuidv7) + `changes{field: {value, base}}` — field-level delta, LWW per field, **no If-Match**. Allowed keys: `name, description, specialty, location_id, dating_mode, start, finish, duration_wd, assignee_org_id, assignee_person_id, acceptance_criteria`. Response `TaskDeltaResult{task, propagated[], variations[], overwrote[], health}`. |
| Delete a row / subtree | `applySchedule` | `POST /projects/{projectId}/schedule:apply` | Op `{op: "delete_subtree", task_id}`. There is deliberately no `DELETE /tasks/{id}`. |
| Row detail drawer (history, variations, progress, questions, documents) | `getTask` | `GET /tasks/{taskId}` | Full `Task` incl. `open_variations`, `open_questions`, `last_change{by, at, cause}`. |
| Milestones (new in v2) | `createTask` / `updateTask` | — | `kind: "milestone"`, zero duration, date optional. `summary` is never created — a task **becomes** one when it gets a child. |

### 1.3 Structure — reorder / indent / outdent / promote / demote

All structural moves are atomic batch operations on `applySchedule`
(`POST /projects/{projectId}/schedule:apply`, body `ScheduleApply{client_change_id, dry_run, operations[]}`,
response `ScheduleApplyResult{created[], changed[], deleted[], links_created[], links_bridged[], health}`):

| Current gesture | Operation |
|---|---|
| Reorder among siblings (↑/↓, drag row) | `{op: "move_subtree", task_id, new_parent_id, after_position}` — same parent, new fractional position |
| Demote (indent under previous sibling) | `{op: "indent", task_id}` |
| Promote (outdent to grandparent) | `{op: "outdent", task_id}` |
| Move a phase / whole subtree elsewhere | `{op: "move_subtree", ...}` (`new_parent_id: null` = top level) |
| Paste rows | `{op: "paste_rows", parent_id, rows: TaskCreate[]}` |
| Bulk-create rows + links (scaffold) | `{op: "create_rows", rows: TaskCreate[], links: LinkCreate[]}` |
| Preview a structural change without writing | same call with `dry_run: true` → the diff |

Depth > 10 → `422 too_deep`. The current hard 3-level cap and the
phase / task / sub-task vocabulary are gone (P7): a row is `task`, `summary` or `milestone` at depth 1–10.

### 1.4 Dates — drag to move / resize / click-to-schedule

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Commit a bar drag (move) or resize | `updateTask` | `PATCH /tasks/{taskId}` | `changes: {start: {value, base}, finish: {value, base}}` on pointer-up ("save on commit"). Server recomputes lag if linked, runs propagation, answers `propagated[]`. |
| Live drag preview (resulting lag + rows that would move + project-end delta) | `previewMove` | `POST /tasks/{taskId}:preview-move` | Body `MovePreview{start, finish}` → `MovePreviewResult{resulting_lag_wd, would_move[], project_end_delta_wd}`. Call it throttled during the drag; the hover label shows work days. |
| Click an empty track to plant a bar | `updateTask` | — | `dating_mode: "dated"` + `start`/`finish` in one delta. |
| Record the actual finish of an `external` row (licence issued) | `recordActual` | `POST /tasks/{taskId}:record-actual` | Body is the `MovePreview` shape (`start`/`finish`); returns `TaskDeltaResult`. |
| Drag a summary (shift whole subtree) | `updateTask` on the summary | — | Server shifts the subtree by the working-day delta; needs `can_edit` on every moved row, else `403 forbidden` with the blocked rows. Summaries cannot be resized. |

Client geometry (`plan-gantt.ts`: `barGeom`, `applyDrag`, `connectorPath`, window/time-base math)
**stays client-side** — but re-based on working days using `Calendar` (P5).

### 1.5 Links (dependencies)

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Draw a link edge-to-edge (the `depFromEdges` gesture) | `createLink` | `POST /tasks/{taskId}/links` (`taskId` = **successor**) | `LinkCreate{id (uuidv7), predecessor_id, successor_id, from_anchor, to_anchor, lag_wd}`. Anchors replace the type names: `starts_after`=end→start, `starts_with`=start→start, `ends_with`=end→end (SF valid in API, hidden in UI). Returns `TaskDeltaResult` — the snap/propagation is in the response, not client-computed. |
| Edit a link's lag / anchors (drawer's link editor) | `updateLink` | `PATCH /links/{linkId}` | Body `LinkCreate`. Dragging a linked successor instead goes through `updateTask` and is **stored as new lag** by the server. |
| Unlink (the ✕ on the connector midpoint) | `deleteLink` | `DELETE /links/{linkId}` | 204; frees the successor. |
| Cycle detection | server | — | `409 dependency_cycle` with the cycle path — replaces `detectCycle()` as the authority; keep the client pre-check only as a courtesy. |
| Connector drawing | `getSchedule` | — | `Link{predecessor_id, successor_id, from_anchor, to_anchor, lag_wd, created_by}`; geometry (`connectorPath`) stays client-side. |

### 1.6 Status, assignee, specialty

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Status picker on a leaf row (append-only) | `reportProgress` | `POST /tasks/{taskId}/progress` | `ProgressCreate{status ∈ not_started·in_progress·blocked·done, percent?, note?, photo_document_ids[]}` → `ProgressReport`. `verified` is written by Quality (verification), never reported. |
| Status history (drawer) | `listProgress` | `GET /tasks/{taskId}/progress` | Page of `ProgressReport` with `reported_by`, `on_behalf_of_org_id`. |
| Assignee picker | `updateTask` | `PATCH /tasks/{taskId}` | `changes: {assignee_org_id, assignee_person_id}`. Read `Task.assignee{org_id, org_name, person_id, inherited}`. Options come from `listParticipants` (`GET /projects/{projectId}/participants`) and, for people of my own org, `listMembers` (`GET /organizations/{orgId}/members`). |
| Editing a row assigned to another org (confirm dialog) | `updateTask` | — | Send `confirm_not_assignee: true` after the UI confirm; assignee is notified. |
| Specialty cell (select) | `updateTask` + `listSpecialties` | `PATCH /tasks/{taskId}` · `GET /specialties` | `changes: {specialty}`; catalogue from `listSpecialties`. |

### 1.7 Cost column (new — D-27)

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Cost cell / roll-up per viewer | `getSchedule` | — | `Task.cost: CostRollup{mine, revenue, cost, margin}` (Money = `{amount_cents, currency}`), **absent** when no visible lines — render empty, never zero. `_visibility.commercial:false` explains withheld fields. |
| Cost-line editor in the drawer | `listCostLines` / `createCostLine` / `updateCostLine` / `deleteCostLine` | `GET·POST /tasks/{taskId}/cost-lines`, `PATCH·DELETE /cost-lines/{costLineId}` | `CostLine{code, description, unit, quantity (decimal string), unit_price, material_spec, contract_id}`. Party-of-contract only; post-baseline changes auto-raise a `cost`/`material` variation. |

### 1.8 Variations (replaces the "pending change" clay chip source)

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Change view / variation badge on a row | `listVariations` | `GET /projects/{projectId}/variations` (`?kind&status&since&task`) | Page of `Variation{kind ∈ time·cost·material·scope, baseline_value, current_value, delta, cause ∈ direct·propagated, history[]}`. Row badge count also on `Task.open_variations`. |
| Variation detail | `getVariation` | `GET /variations/{variationId}` | Net position vs baseline + full history. |
| "I saw it" | `acknowledgeVariation` | `POST /variations/{variationId}:acknowledge` | Records who/when. |
| "Ask about it" | `questionVariation` | `POST /variations/{variationId}:question` | Body `CommentCreate` → opens a question on the row. |

### 1.9 Excel import wizard (inspect → map → preview → confirm)

| Current step | operationId | Method / path | Shape note |
|---|---|---|---|
| Upload the file | `uploadScheduleImport` | `POST /projects/{projectId}/schedule-imports` | Returns `ScheduleImport{status: uploaded, sheets[], columns[{header, samples[]}]}`. ⚠️ request body/target-parent not yet in the spec — see §3.5. |
| Map columns | `mapScheduleImport` | `POST /schedule-imports/{importId}:map` | Body `ScheduleImport` (its `mapping` object). |
| Preview rows + warnings | `previewScheduleImport` | `POST /schedule-imports/{importId}:preview` | `ScheduleImport.preview: TaskCreate[]` + `warnings[{row, message}]`. |
| Confirm | `confirmScheduleImport` | `POST /schedule-imports/{importId}:confirm` | Returns `ScheduleApplyResult`; rows written with `cause=import`. Idempotency-Key supported. |

### 1.10 Templates

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Browse library (personal / org / public / LinkNMS library) | `listTemplates` | `GET /plan-templates` (`?construction_type&phase&scope`) | Page of `PlanTemplate` — structure + links only, **no dates/durations/assignees/prices** (D-30). |
| Inspect one | `getTemplate` | `GET /plan-templates/{templateId}` | `rows[{row_key, parent_row_key, kind, name, specialty}]`, `links[]` on row_keys. |
| Save plan/subtree as template | `createTemplate` | `POST /plan-templates` | `PlanTemplateCreate{id, root_task_ids[], scope, name, construction_type, phase_tags[]}`. |
| Rename / share / unshare / delete | `updateTemplate` / `deleteTemplate` | `PATCH·DELETE /plan-templates/{templateId}` | — |
| Insert under a row, **unticking specialties** | `applySchedule` | `POST /projects/{projectId}/schedule:apply` | `{op: "insert_template", template_id, parent_task_id, exclude_row_keys[]}` — server **bridges links** through removed rows (`links_bridged[]` in the result). Inserted rows arrive `undated`. |

### 1.11 Drawer extras — comments, attachments, activity

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Per-row comments / questions | `listComments` / `createComment` | `GET·POST /threads/task/{objectId}/comments` | `CommentCreate{id, kind ∈ note·question, body, mentions[], addressee_org_id, attachment_ids[]}`. Read-only rows still allow comment/question (P9). |
| Answer / resolve a question | `answerQuestion` / `resolveQuestion` | `POST /comments/{commentId}:answer` · `:resolve` | — |
| Per-row attachments (photos, drawings) | `createDocument` → upload → `completeUpload`; `listDocuments`; `downloadDocument` | `POST /documents` (`scope_type: "task"`, `scope_id`) → PUT bytes to `upload_url` → `POST /document-versions/{versionId}:complete`; `GET /documents?scope_type=task&scope_id=…`; `GET /document-versions/{versionId}:download` (302) | Replaces the v1 R2 stage-attachment routes. |
| "Last changed by X · propagated from Y" stamp | `getSchedule` / `getTask` | — | `Task.last_change{by, at, cause}`. |
| Project activity feed | `listActivity` | `GET /projects/{projectId}/activity` | Page of `ActivityItem`. |

### 1.12 Real time

| Capability | operationId | Method / path | Shape note |
|---|---|---|---|
| Live row updates, propagation pushes, variations, presence | `streamEvents` | `GET /projects/{projectId}/events:stream` | SSE (`text/event-stream`), event envelopes projected per viewer. Resume from `Schedule.stream_cursor` / `Last-Event-ID`. Clients merge pushed rows — no reload. |

### 1.13 Client-side only (no API needed — unchanged)

Column resize / reorder / double-click auto-fit, table↔Gantt split divider,
time-base nav (Fit / Weeks / Months / Quarters / Today), grab-drag pan, floating timeline nav,
collapse/expand, search box, filter bar (owner / status / overdue / blocked — applied over the
loaded `Schedule`; `getSchedule`'s `assignee`/`status`/`state` params exist for narrowed fetches),
hover labels, connector geometry, link-drag snapping. Persist view prefs (widths, order, split,
collapsed set, time base) in `localStorage` as today — see §3.7 for the cross-device caveat.

---

## 2. Behaviour changes, keyed to the gap analysis (P1–P13)

| # | What the client stops / starts doing |
|---|---|
| P1 | **Stop** the 900 ms whole-tree autosave (`POST plan-versions:author`). **Start** per-commit `updateTask` field deltas with `base` values, and `applySchedule` for structural batches. No client-side "last write wins whole plan": the server reports `overwrote[]` per field and notifies the other author. |
| P2 | **Stop** `savedKeys` / `stageIdByKey` / key→id remapping / "save first before status·comments·files". **Start** minting UUIDv7 ids client-side on row and link creation (`TaskCreate.id`, `LinkCreate.id`, `client_change_id`). A row is fully addressable — status, comments, attachments — the instant it is created. `statusSettableKeys` and the stale-id recovery in `PlanBaseline` disappear. |
| P3 | **Delete** the draft/proposed/accepted machinery: no plan version, no "Send for approval" banner, no read-only-until-accepted grid, no draft-vs-live grid split (`PlanBuildEditor` vs `PlanBaseline` collapse into one grid). Baseline is a per-branch label taken at contract signature (`listBaselines`); "controlled" rows just render segments. |
| P4 | **Stop** client-side link snapping (`enforceLink`, `snapToLinks`, the `ends_with`-resizes bug). **Start** trusting the server: send the drag as a delta, render `propagated[]` from the response and SSE. Dragging a linked row becomes a lag edit (server-computed; `previewMove` shows the resulting lag during the drag). |
| P5 | Date math moves from calendar days (`diffDays`, `addDays`) to **working days** on the project `Calendar`. Durations are `duration_wd`; hover labels say work days; shade non-working days on the canvas. Keep `plan-gantt.ts` geometry, feed it a work-day axis. |
| P6 | **Stop** drawing one bar from `TaskDraft.start/end`. **Start** drawing `Task.segments[]` layered (ghost baseline, current, clay `extension` with a label — never colour alone, `delay_start` hatch, `actual` fill), plus the variation badge linking to the change view. |
| P7 | **Drop** the phase/task/sub-task 3-level model (`PhaseDraft`/`TaskDraft`, `promoteNode`/`demoteNode` client logic). Rows are a flat list with `parent_id`/`depth` (1–10) /fractional `position`; render milestones (diamond, zero width); summaries derive dates and cost — never editable directly. |
| P8 | Link types survive 1:1 but are expressed as **anchors + lag**: translate `starts_after/starts_with/ends_with` → `(from_anchor, to_anchor)` at the API edge; the link drawer gains a lag field (`lag_wd`, may be negative). |
| P9 | **Stop** gating the grid by role (GC/owner authoring). **Start** per-row `can_edit` from the response: read-only rows grey out but keep comment/question. Branch scope is server truth — the client never computes it. |
| P10 | Status control stays open to all (as today, LINA-306), plus the new `verified` state — rendered but never settable from the grid (comes from Quality via verification). |
| P11 | **Add** the cost column (per-viewer `CostRollup`, empty ≠ zero) and the cost-line editor in the drawer. Specialty becomes a catalogue-backed select (`listSpecialties`) — already true since LINA-306 r8. |
| P12 | **Add** the SSE subscription per open plan: merge row deltas, propagation, variations and presence; replace the "draft saved" stamp with a live activity indicator; show `overwrote` toasts. |
| P13 | **Remove** the Procurement/Execution accordion from `/plan`. Tendering renders as **proposal lanes** under the tendered row (dashed, collapsible, never in roll-ups/health/propagation) via the Tendering tag (`listProposalLanes`, `getComparison`) — out of scope for this doc. |

---

## 3. MISSING FROM THE CONTRACT

Checked rigorously against `openapi.yaml`. Verdicts per capability group first, then the
gaps we **request** (founder directive: "if anything is missing from the api to achieve the
same current layout, request it").

**Covered — nothing missing:** plan load & render (segments, can_edit, health, calendar),
row CRUD, indent/outdent/promote/demote/reorder (`applySchedule` ops incl. `indent`/`outdent`),
drag/resize/click-to-schedule (+ `previewMove`), all 3 link types + lag + SF, cycle detection,
status setting & history, assignee, specialty catalogue, cost column & lines, variations,
undated rows (`dating_mode`), external rows (`recordActual`), milestone data model,
template insert **with untick** (`exclude_row_keys` + bridged links), plan health, baselines,
connector data, comments & questions, per-row attachments, SSE.

The gaps:

1. **`uploadScheduleImport` has no request body.**
   `POST /projects/{projectId}/schedule-imports` defines no multipart/file schema and no
   **target parent row** field, although its `x-relationship` is "edit scope ∋ target parent"
   and the summary says "under a row". `ScheduleImport` carries no `parent_task_id` either, and
   `confirmScheduleImport` takes no body to supply it. **Request:** add a request body
   (multipart `file` or the `UploadTicket` two-step used by documents) plus
   `parent_task_id` (nullable = top level), on upload or on confirm.

2. **No "my default template" (v1 parity).**
   Today a new plan auto-scaffolds from the user's single default template
   (`GET /me/plan-template`, "Save as my default", ADR-0018 / LINA-241-242). v2 has
   `scope: personal` but no default flag on `PlanTemplate`/`PlanTemplateCreate` and no
   endpoint to resolve "my default". **Request:** either an `is_default` boolean
   (per person, single) + a way to fetch it, or an explicit product decision that the
   empty-plan flow becomes "pick from the library" (then nothing is needed — but say so in
   the spec/docs so the UX change is deliberate).

3. **No way to change a row's `kind`** (task ↔ milestone).
   `TaskDelta.changes` keys don't include `kind`, and no `applySchedule` op converts it.
   Creating-then-deleting loses comments/progress/links. **Request:** add `kind` to the
   `TaskDelta` allowed keys (task ↔ milestone only; summary stays derived).

4. **No client→server presence signal.**
   `streamEvents`' summary promises "presence", but no operation lets a client announce
   "I am viewing this plan" (heartbeat/announce). **Request:** define how presence enters the
   stream — a `POST /projects/{id}/presence` heartbeat, or state that connecting to
   `streamEvents` itself registers presence (then document that in the operation).

5. **SSE resume not in the spec.**
   Conventions ([11](../../to-be/11-api-conventions.md)) promise `Last-Event-ID` resume and
   `Schedule.stream_cursor` exists, but `streamEvents` declares neither the `Last-Event-ID`
   header parameter nor the event envelope schema (payload is `type: string`). Implementable,
   but the event names/payloads the grid must merge (row delta, propagated, variation,
   presence, overwrote) are contract-relevant. **Request:** declare the header param and an
   event-envelope schema (or reference [10 — domain events](../../to-be/10-domain-events.md)
   from the operation).

6. **`recordActual` reuses the `MovePreview` schema.**
   Works (start/finish), but an "actual" is semantically different (e.g. actual start only,
   open finish) and the reuse invites drift. Cosmetic. **Request (low priority):** a dedicated
   `ActualRecord` schema.

7. **Column layout / view preferences — explicitly not requested.**
   Column widths & order, split position, collapsed rows, time base, filter state are
   client-side (localStorage) today and stay so; no v2 endpoint exists and none is needed for
   layout parity. If cross-device persistence is ever wanted, that is a new feature
   (a `/me/preferences` doc), not a parity gap.

8. **Filters — nothing missing.** Owner/status/overdue/blocked/search run client-side over the
   loaded plan; `getSchedule` additionally accepts `assignee`, `status`, `state`, `root`,
   `depth`, `location` for narrowed fetches. Overdue and free-text search have no server
   params — correctly so; they are derivable client-side from `finish` + today and row names.

Items 1–4 need spec changes before the FE can reach current-layout parity end-to-end
(1 blocks Excel import; 2 blocks the current empty-plan scaffold flow; 3 and 4 are
new-model polish). 5–6 are spec hygiene; 7–8 are confirmations that nothing is missing.

---

## 4. Reading order for the implementer

1. [11 — API conventions](../../to-be/11-api-conventions.md) — deltas + `base`, `client_change_id`, problem+json codes, `_visibility`, SSE.
2. [05 — planning & execution](../../to-be/05-planning-and-execution.md) — rows, links-as-anchors, propagation, baselines/segments, branch scopes, templates.
3. [13 — gap analysis §Planner UX](../../to-be/13-gap-analysis.md) — P1–P13 and "what carries over unchanged".
4. `openapi.yaml` — Planning tag end to end (`getSchedule` → `updateTask` → `applySchedule` → links → progress → variations → imports → templates), then `streamEvents`, `getCalendar`, `listParticipants`, `listSpecialties`, the `threads`/`documents` operations.
5. Current code to reuse: `app/src/lib/plan-gantt.ts` (geometry — make it work-day aware), the `PlanGrid` table/canvas layout, column and filter interactions. Current code to retire: `plan-authoring.ts` draft tree + key minting + `enforceDependencies`/`enforceLink`/`snapToLinks`, `PlanBaseline` draft/proposed banners, `toWire`/`hydrateDraft`.
