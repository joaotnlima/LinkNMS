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
