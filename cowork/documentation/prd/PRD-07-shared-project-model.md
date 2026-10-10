# PRD-07 — One shared project model: read by everyone, edited by the winners, always versioned

| | |
|---|---|
| Status | Draft — for founder review. **Blocked on decision §7.1** |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 3c · F3 ProjectModel, F8 ModelEdit, F9 SaveVersion, F10 Versions, Component · Viewport |
| Superseded board | F7 ModelView (in the APAGAR area): its task filter and inspector become states of F3 |
| Related decisions | **D-41 (conflict)**, D-39, D-33, D-06 |
| Related docs | to-be/24 BIM viewer; BRAND.md line 67 |
| Depends on | PRD-05 (versions, links), PRD-01 (Files tab card) |

## 1. Problem

The IFC model is used by many tasks: roofing, frame, plumbing, windows. Today it lives inside one RFP, view-only. Nobody can:

- open the model for the build;
- see which elements belong to which task;
- leave an issue on an element;
- let the company that won a package record its part.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| IFC viewer (web-ifc 0.0.57, three 0.169): orbit, category show/hide, two-point measure | Built, **view-only** | `app/src/components/ifc/IfcViewer.tsx`, `ifc-loader.ts:70-153`, `app/package.json:22-23` |
| Geometry merged per category, so **no element picking** | Built | `ifc-loader.ts` |
| Mounted only on RFP screens (composer, owner inbox, public token page) | Built | `ProcurementSection.tsx:572,955`, `app/rfp/[token]/page.tsx:140` |
| Model scope: one per RFP, `scope_type='rfp'`, `kind='bim'`, 100 MB, editable only while draft | Built | `modules/tendering/domain/rfp-model.mjs:5-18`; draft rule in `modules/tendering/application/use-cases.mjs:439-445`, `:524` |
| `/projects/{id}/model` | **No route** | — |
| web-ifc write/save API | **Unverified.** No write calls in code; `node_modules` not installed in the audit checkout | — |

## 3. Goals

1. One model per project, at **`/projects/{id}/model`**, readable by every participant.
2. Elements linked to tasks: colour by task, status or who edits, and filter to one task from its Files tab.
3. Companies **edit only their part**, from the moment they win it. Every save is a new version attributed to them. Nothing is overwritten.

### Non-goals

- Geometry authoring (move, reshape). Excluded on purpose: the architecture project carries the architect's signature and liability.
- Clash detection beyond manually raised issues.

## 4. Requirements

### 4.1 Page (F3)

| ID | Requirement | Priority |
|---|---|---|
| M-1 | Route `/projects/{id}/model` with a rail icon. Version selector, History, and `Edit my elements` (only when the viewer has a write scope). | Must |
| M-2 | **Element picking**: load geometry per element (not merged per category), with a selection highlight and an inspector showing name, IFC class, GlobalId, linked task and properties. | Must |
| M-3 | Colour by **Task / Status / Who edits**, with a legend list of tasks and element counts, plus "not linked to any task". | Must |
| M-4 | Opened from a task (`?task=2.5`): that task's elements isolated and others faded. | Must |
| M-5 | Issues list with pins on elements. An issue can reference several tasks. | Should |
| M-6 | Access panel: who reads, who edits and on which scope, plus pending scopes ("opens for the winner on award"). | Should |

### 4.2 Access

| ID | Requirement | Priority |
|---|---|---|
| M-7 | **Read:** every participant of the project. **Bidders on an open RFP:** only the views attached to that RFP (today's rule, D-41). | Must |
| M-8 | **Edit scope:** author and owner, the whole model; GC, the elements of its contracted branch; each awarded company, **only the elements linked to its awarded tasks**. Follows D-33 "edit scope follows branches". | Must |
| M-9 | Write scope opens on award and closes on cancellation or contract end. Only the **author** uploads a new `.ifc`. | Must |

### 4.3 Edit (F8) and save (F9)

| ID | Requirement | Priority |
|---|---|---|
| M-10 | Edit tools: Select, **Link to task**, **Issue pin**, Measure, **edit properties** (e.g. material). Move/reshape is shown disabled with the reason. | Must (links, pins) / **Decision** (properties) |
| M-11 | Edits form a **private draft** listing unsaved changes, each tagged `IFC` (written into the file) or `Record` (kept on LinkNMS, carried by GlobalId). | Must |
| M-12 | Save dialog: change list, **required note**, "edited by {person} ({role})" when the saver isn't the author, notify the author, notify the linked tasks' owners. | Must |
| M-13 | A dimensional property change (e.g. width) carries the warning "geometry unchanged — the model no longer matches its own properties". Recommendation: make dimensional properties read-only (§7.3). | Must |
| M-14 | **Concurrent drafts.** Each draft records its base version. On save, changes to elements nobody touched since are applied on top of the latest. Overlaps are resolved element by element. Never last-write-wins. | Must |

### 4.4 Versions (F10)

| ID | Requirement | Priority |
|---|---|---|
| M-15 | History: version, who, when, note, change count, base version, current flag, "author review pending". | Must |
| M-16 | Compare any two versions by GlobalId: added / removed / properties changed / record changes. Side by side or overlay. | Should |
| M-17 | **Restore vN** creates v(n+1) as a copy. No deletion, ever. | Must |
| M-18 | Upload a new `.ifc` from Revit or ArchiCAD. Links and issues carry over by GlobalId; unmatched elements are listed for relinking. Warn when an export regenerates GlobalIds ("all removed, all added"). | Must |

## 5. Data and API

- Move the model from `scope_type='rfp'` to `'project'`. RFPs reference the project model, or a pinned version of it, instead of owning one. Migrate existing RFP models.
- `bim.element_link (project_id, global_id, task_id, created_by_org, created_at)` and `bim.issue (id, project_id, global_ids[], task_ids[], text, state, author)`. These are record-side, so they survive re-uploads.
- `bim.edit_scope` is derived, not stored: award → tasks → linked GlobalIds. Enforce it server-side on save. Feasibility of row-level enforcement over thousands of GlobalIds is **unverified**: benchmark it.
- `document_version` gains `note`, `base_version_no` and `change_kind` (shared with PRD-05).
- IFC property write-back (M-10 properties) needs a web-ifc write path. **Verify against the pinned 0.0.57 before committing.** If it is missing, ship record-side edits only (links, pins).

## 6. Acceptance criteria

1. Every participant can open `/projects/{id}/model`. A bidder on an open RFP sees only what the RFP attaches.
2. Telhados do Norte, awarded 2.5, can link and pin only elements already linked to 2.5 or its sub-tasks. The server rejects any other GlobalId.
3. Two drafts on v3 touching disjoint elements both save, producing v4 and v5, with no loss. Overlapping drafts force an element-level choice.
4. Restoring v2 creates a new version equal to v2. v3 and later remain.
5. Re-uploading an IFC whose GlobalIds are preserved keeps all links and issues.

## 7. Decisions needed

> **Decided — D-45:** record-side edits only (links, pins, versions by upload). No IFC writes. M-10 property editing and M-13 are out. The route `/projects/{id}/model` is added to the URL map.

1. **D-41 / doc 24 / BRAND.md.** All three say view-only ("does not author or edit models"). Writing record-side data (links, pins, versions) is arguably not "authoring". Writing IFC properties is. Amend D-41 explicitly, or limit this PRD to record-side edits.
2. Route `/projects/{id}/model` is not in to-be/20's URL map. Add it, or nest it under `/projects/{id}/documents`.
3. Dimensional properties: read-only (recommended) or editable with the mismatch warning.
4. Does the GC's scope cover the whole model or only its contracted branch?
