# 08 — Supporting domains

## Quality

**VerificationRequest**: created when a task is declared `done`.
`(task, requested_by, acceptance_criteria_snapshot, status: pending → accepted | rejected, decided_by, reason, evidence_document_ids[])`
- Requested from the task's coordinator (client of the task's contract) by default, but any participant
  or an invited inspector may decide it — never the organisation whose report marked the row `done`
  ([17 §5](./17-personas-roles-interactions.md)). Nobody verifies their own organisation's work.
- `accepted` → Planning appends `verified`; `rejected` → Planning appends `in_progress` with the reason.

**NonConformity**: `(project, task?, contract?, raised_by, severity, description, photos, status: open → assigned → fixed → closed | rejected_fix)`.
Raised by any participant; assigned to the responsible supplier; closed only by whoever raised it
(or the coordinator). Open non-conformities block `provisionally_received` of the contract.

**Inspection** (consultants — inspector, HSE): a dated record with checklist, findings and
documents, optionally linked to tasks; may spawn non-conformities.

## Documents

**Document**: `(scope_type ∈ {project, location, contract, task, rfp, proposal, profile, change_order, measurement}, scope_id, kind ∈ {drawing, bim, photo, spec, contract_doc, invoice, other}, title, share_with_ancestors?)`
**DocumentVersion**: `(document, version_no, storage_key, mime, size, sha256, uploaded_by, at)` — append-only.
- Bytes in object storage (R2), downloads via short-lived signed URLs after a visibility check (V6).
- The `sha256` of each version goes into the ledger payload: the file itself can be proven unchanged.
- BIM: upload + preview where the format allows (IFC viewer), as evidence only (product boundary kept).
- **Task files (PRD-05).** A file lives once in the project (`scope_type = project`) and is *linked* to the tasks that use
  it (`document_link`, role `reference` | `deliverable`, optionally inherited by sub-tasks); a new version shows on every
  linking task and notifies their owners. Every kind is capped at 100 MB (D-49); `preview_status` tracks the DWG conversion
  of PRD-06. **Deliverables** — what a task must hand over and their review — belong to Planning (the task's acceptance
  and the D-48 `done` gate); Documents only holds the bytes. Reviewers are the *client side* of the task: an organisation
  whose edit scope contains the row (owner, or a client up the branch's contract chain — so the GC may approve its sub's
  deliverables on the owner's behalf), never the task's assignee and never the organisation that submitted the version.
- **Drawings: markup layer and previews (PRD-06).** LinkNMS never authors drawings: "edit" on a PDF or DWG is a
  **markup layer on the record** (`documents.markup` — cloud, arrow + note, text, measure, calibration; pinned to a page or
  layout and to the version it was saved in; open/closed; optionally pointing at the Collaboration question or the Quality
  issue it became). Saving markups appends a `markup_only` version that reuses the base version's storage key and sha256 —
  the bytes are provably unchanged. PDFs render client-side (pdf.js); measurements show units only after the sheet is
  calibrated. DWG/DXF are converted server-side after upload through the **DwgConverter port** (application layer): the
  default adapter (`DWG_CONVERTER` unset or `none`) converts nothing and marks the file `unavailable`
  (`converter_not_configured`, download only); `DWG_CONVERTER=libredwg` shells out to the LibreDWG CLI (`dwg2SVG`,
  `dwgread -O JSON`, `dxf2dwg` for DXF) found in `LIBREDWG_BIN_DIR` (or `PATH`). Preview SVGs are derived objects with their
  own storage keys (`v2/documents/{id}/previews/{sha256}/{n}.svg`), keyed by the bytes.
  **Deployment requirement (D-49):** LibreDWG is **GPL-3.0** and is **not** bundled in any image or package of this repo.
  Installing it next to the server process (and enabling `DWG_CONVERTER=libredwg`) waits for the **legal check** D-49 asks
  for; until then DWG/DXF files are download-only. The serverless app runtime cannot run a CLI — the conversion consumer
  has to run where the binaries are (a worker draining the outbox).

## Collaboration

**Thread** on any object reference `(object_type, object_id)`; visibility = the object's.
**Comment**: `kind ∈ {note, question, answer}`, `body`, `mentions[]`, `attachments[]`.
- A **question** has state `open → answered → resolved`, an addressee org, and an SLA clock.
  Open questions show on the object and on the addressee's queue — this is the dispute channel
  for the owner (D-13).
- Comments are editable for 10 minutes, then immutable; deletions leave a tombstone.

**MeetingMinute** (ata de reunião de obra): `(project, date, attendees[], items[{text, owner_org, due_date, linked_object?}])`,
`status: draft → circulated → acknowledged` (each attending org acknowledges). This is the to-be home
of the as-is *decision log*: a decision is an acknowledged minute item.

**Activity feed**: projection of domain events, filtered by viewer visibility.
**Notifications**: per person, channels in-app + email; preferences per event category; digests.

## Record (ledger)

Kept from the as-is (ADR-0002), extended with scope:

`AuditEvent(project_id, seq, occurred_at, actor_person_id, actor_org_id, category, type, scope_type, scope_id, payload, payload_hash, prev_hash, entry_hash)`

- One hash chain per project; a single `append_event()` writer (SECURITY DEFINER), per-project
  advisory lock, same transaction as the domain change.
- `scope_type ∈ {project, contract, org_private}` drives redaction (V7).
- `GET /projects/{id}/record` returns the viewer's projection: full entries in scope, redacted
  entries otherwise. `GET /projects/{id}/record:verify` recomputes the chain for any participant.
- Tamper-*evident*, never tamper-*proof* (product boundary kept).
