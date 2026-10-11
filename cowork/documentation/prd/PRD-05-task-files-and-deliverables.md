# PRD-05 — Files tab on the task, project files and deliverables

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 3c · F1 TaskModel (Files tab), F2 DocTask (deliverables review), F4 AddFile; 6 · account/Gaps (Documents) |
| Related decisions | D-39, D-06, D-33 |
| Related docs | to-be/08 supporting domains, to-be/15 data model, to-be/20 (`/projects/{id}/documents`) |
| Depends on | PRD-01 (4th tab) |
| Extended by | PRD-06 (PDF/DWG viewing and markup), PRD-07 (shared model) |

## 1. Problem

Planning a task, buying it (tender) and checking the work it produced are three different jobs. Today files sit inside the **Conversation** tab, as a flat list with only the latest version. Nothing says which files the task must *hand over* or whether they were accepted. For design tasks (architecture, structural, MEP) the files **are** the work, yet the task can be marked done with nothing approved.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| `documents.document` with `scope_type` (incl. `task`, `project`, `rfp`), `kind` (`drawing, bim, photo, spec, contract_doc, invoice, other`), `share_with_ancestors`, `current_version` | Built | `db/v2/0001_schema.sql:756-765` |
| `documents.document_version`, append-only (sha256, uploader) | Built; no change note or base version | `0001_schema.sql:767-778`, trigger `:973` |
| Upload: reserve → presigned R2 PUT (sha256 pinned) → complete | Built | `modules/documents/application/use-cases.mjs:1-17`, `infra/storage.mjs:60-80` |
| `POST /documents/{id}/versions` (new version) | Backend only; **no UI calls it** | `modules/documents/http/register.mjs:14-27` |
| Task files: listed under Conversation, latest version only, `kind='other'` | Built | `components/TaskWorkspace.tsx:210-318`, `lib/v2/task-workspace.ts:197-199` |
| Project documents surface | **Not built**; rail item dimmed | `components/PortalShell.tsx:315-317` |
| Deliverables, approvals per file version | **None** | — |
| Reusable sign-off | `SignOffPanel` on `project.phase_sign_off_request`: per phase, one pending per phase, dormant | `components/SignOffPanel.tsx`, `0008_project_phases_signoff.sql:91-105` |

## 3. Goals

1. A **Files** tab on every task, separate from Conversation, with two sections:
   - **Deliverables:** what the task must hand over, each with a review state.
   - **Reference:** what the work is built from.
2. Each file lives **once** in the project and is *linked* to the tasks that use it. A new version shows up everywhere.
3. A design task can't be closed until its required deliverables are approved, and approvals are on the record (who, when, which version hash).

### Non-goals

- In-browser viewing and markup of PDF/DWG (PRD-06) and the shared model (PRD-07).
- Photos and daily log capture (PRD-10).

## 4. Requirements

### 4.1 Files tab (F1)

| ID | Requirement | Priority |
|---|---|---|
| F-1 | Fourth tab **Files**, labelled with a count, or `n to review` when deliverables wait on the viewer. | Must |
| F-2 | **Deliverables** section: rows with type, name, state (`Not yet` / `Submitted · review` / `Changes requested` / `✓ Approved`), version, submitter, due. | Must |
| F-3 | **Reference** section: file rows with type tag (PDF / DWG / IFC / image / other), name, version, author, markup count (PRD-06), where else it is used ("also on 2.5.1", "deliverable of 1.4"). Filters: All / PDF / DWG / With markups. | Must |
| F-4 | If the project has a model, a **Project model** card: thumbnail, elements linked to this task, and the viewer's edit right. Opens PRD-07's page filtered to the task. | Should |
| F-5 | Conversation keeps messages only. Files attached in a message also appear under Reference. | Must |

### 4.2 Add files (F4)

| ID | Requirement | Priority |
|---|---|---|
| F-6 | Upload `.pdf .dwg .dxf .ifc` and images, up to a set cap. The board says 200 MB; the RFP model cap is 100 MB (`modules/tendering/domain/rfp-model.mjs:18`); the task Files UI says "up to 10 MB" (`TaskWorkspace.tsx:235`) but nothing enforces it. Choose one cap. | Must |
| F-7 | Per-upload state: Ready / Making preview… / No preview, download only / needs a decision. | Must |
| F-8 | When a matching file already exists, offer "new version of X" vs "separate file". For IFC: new version of the project model vs a separate model, e.g. structural. | Must |
| F-9 | **Link from the project**: search project files by sheet number or name, filter by type, multi-select. Linking never copies. | Must |
| F-10 | "Also on sub-tasks" toggle (inherited; removable per sub-task) and "Attach to the RFP" when the task has a tender. The board copy states the bidder visibility. | Should |
| F-11 | When a linked file gets a new version, the owners of every task that uses it are notified (PRD-12 notification centre). | Should |

### 4.3 Deliverables and review (F2)

| ID | Requirement | Priority |
|---|---|---|
| F-12 | **Required deliverables** come from the RFP scope of the awarded tender: the design-mode deliverables text, D-39. They can be edited on the task by the client side. | Must |
| F-13 | The assignee submits a file version against a deliverable with a note. | Must |
| F-14 | The client side **approves** or **requests changes**, with a comment. Approval records person, org, time and the version **sha256**. | Must |
| F-15 | A new version after approval returns the deliverable to `Submitted · review`. | Must |
| F-16 | Progress "x of n approved". **Mark done is disabled until all required deliverables are approved.** | Must |
| F-17 | Approved deliverables can be linked as Reference on downstream tasks, e.g. S-110 → 2.5 Roofing. | Should |
| F-18 | `Compare v1 ↔ v2` for PDFs (overlay; PRD-06). | Should |

### 4.4 Project files page: `/projects/{id}/documents` (to-be/20)

| ID | Requirement | Priority |
|---|---|---|
| F-19 | Every project file with type, version, tasks using it, deliverable state, and folder/type filters. Activates the dimmed "Documents" rail item. **Design not drawn yet.** | Must |

## 5. Data and API

- **Linking.** `document` has a single `scope_type`/`scope_id`. To link one file to many tasks, add `documents.document_link (document_id, task_id, role reference|deliverable, inherited boolean)`. Alternatively, keep `scope_type='project'` and use links for tasks. `share_with_ancestors` covers part of inheritance; check whether it fits "also on sub-tasks" before adding a column.
- `document_version`: add `note text`, `base_version_no int null`, and `change_kind` (`upload | markup_only | edit`) for PRD-06 and PRD-07. The table is append-only, so this is additive and safe.
- **Deliverables.** New `documents.deliverable (id, task_id, title, required, source_rfp_id null, due)` and `documents.deliverable_submission (deliverable_id, document_id, version_no, note, status, decided_by_person, decided_by_org, decided_at, sha256)`. Events: `DeliverableSubmitted`, `DeliverableApproved`, `DeliverableChangesRequested`.
- **Task completion gate.** The planning status change to done checks required deliverables. This is a *gate*. D-23 says "show the change, do not gate it" for plan changes after baseline; check that this gate doesn't conflict.
- `kind`: add `pdf` and `dwg`, or keep `drawing` and rely on `mime`. Prefer mime plus `drawing` to avoid a migration of meaning.

## 6. Acceptance criteria

1. Uploading a PDF from task 2.5 creates one project document linked to 2.5. Linking it from 2.5.1 adds a link, not a copy, and a v2 upload shows as v2 on both tasks.
2. A design task with 5 required deliverables cannot be marked done until all 5 are approved. Each approval stores the version's sha256.
3. A new version after approval puts the deliverable back into review and notifies the approver.
4. Files no longer appear only inside Conversation.

## 7. Decisions needed

> **Decided — D-48:** required deliverables gate "done". **D-49:** upload cap 100 MB (default, unconfirmed).

1. Upload cap (F-6).
2. Is "done only when deliverables are approved" a gate or a warning? See D-23.
3. Can the GC approve deliverables on the owner's behalf? This follows D-06 and D-33, but it needs a stated rule.
4. Reuse `SignOffPanel` visuals only, or also generalise `phase_sign_off_request`? Recommendation: new deliverable tables. The phase sign-off is per phase and allows only one pending request.
