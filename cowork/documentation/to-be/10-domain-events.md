# 10 — Domain events

Published through a transactional **outbox** (`platform.outbox`, written in the same transaction
as the change). A dispatcher delivers to in-process handlers; handlers are idempotent (dedupe on
`event_id`). Envelope:

```json
{ "event_id": "uuidv7", "type": "contracting.contract.signed", "version": 1,
  "occurred_at": "…", "project_id": "…", "actor": {"person_id": "…", "org_id": "…"},
  "scope": {"type": "contract", "id": "…"}, "data": { } }
```

| Event | Producer | Main consumers | Ledger |
|---|---|---|---|
| `project.created`, `project.status_changed` | Project | Feed, Billing (usage) | ● |
| `project.location_changed` | Project | Planning | ● |
| `project.invitation.accepted` | Project | Notifications (inviter org) | ● |
| `tendering.rfp.published`, `.addendum_issued`, `.closed`, `.awarded`, `.cancelled` | Tendering | Notifications (`.awarded`, `.cancelled` → bidders), Directory (`.published` → unclaimed profiles for address-only invitees, PRD-04 X-2), Planning (`.awarded` → baseline at award, D-43) | ● |
| `tendering.clarification.answered` | Tendering | Notifications | ● |
| `tendering.bid_request.requested`, `.approved`, `.declined` (D-47, PRD-04) | Tendering | Notifications (`.requested` → issuer; `.approved` / `.declined` → the asking company) | ● (scope: rfp_private) |
| `tendering.rfp.recipients_added` (invite more on a sent RFP, PRD-04 X-2) | Tendering | Directory (unclaimed profiles for address-only invitees) | — (the ledger entry of the same name is the audit) |
| `directory.profile.claimed` (PRD-04 §6.3) | Directory | Tendering (back-fill the organisation on past invites to the address) | — |
| `tendering.proposal.submitted`, `.withdrawn` | Tendering | Notifications (issuer), Directory (listing stats: proposals sent, PRD-03 R-17) | ● (scope: rfp issuer + bidder) |
| `contracting.contract.created`, `.signed`, `.activated`, `.provisionally_received`, `.closed`, `.terminated` | Contracting | Project (participation), Planning (bind + baseline — a no-op when the award already took it), Reputation, Billing, Directory (on the record: `.signed` and the state changes, PRD-03 R-11) | ● |
| `contracting.change_order.submitted`, `.approved`, `.rejected` | Contracting | Planning (re-baseline on time CO), Notifications, Directory (change orders raised/approved, PRD-03 R-11) | ● |
| `contracting.measurement.submitted`, `.approved`, `.disputed` | Contracting | Notifications | ● |
| `contracting.payment.declared`, `.confirmed`, `.disputed` | Contracting | Reputation (payment reliability) | ● |
| `planning.task.created`, `.updated` (field delta), `.deleted`, `.moved` | Planning | Feed, SSE | ● |
| `planning.task.propagated` (rows pushed by a link, with cause) | Planning | SSE, Notifications (assignees of moved rows) | ● |
| `planning.variation.recorded`, `.updated`, `.acknowledged`, `.questioned`, `.formalised`, `.closed` | Planning | Notifications (owner digest, 15 min window), Feed, SSE | ● |
| `planning.edit.overwritten` | Planning | Notifications (overwritten author) | — |
| `planning.link.added`, `.changed`, `.removed` | Planning | SSE | ● |
| `planning.progress.reported` | Planning | Quality (on done), Contracting (activation), Directory (tasks finished on the planned date, PRD-03 R-11), Feed, SSE | ● |
| `planning.baseline.taken` | Planning | Feed, Project (the first one activates the execution phase, PRD-10 E-13) | ● |
| `planning.daily_log.recorded` (PRD-10 E-7) | Planning | Feed | ● |
| `planning.plan.imported` (PRD-09 O-12) | Planning | Notifications (the owner) | ● |
| `planning.deliverable.submitted`, `.approved`, `.changes_requested` | Planning | Notifications (submitted → client side of the task; decided → submitter + assignee org) | ● (sha256) |
| `quality.verification.accepted`, `.rejected` | Quality | Planning, Contracting (measurable qty), Reputation | ● |
| `quality.nonconformity.*` | Quality | Contracting (reception guard), Notifications | ● |
| `documents.version.uploaded` | Documents | Feed, Planning (re-submits a deliverable the document was submitted for, PRD-05 F-15), Notifications (owners of the tasks linking the file, F-11), Documents (DWG/DXF preview conversion, PRD-06 V-11) | ● (sha256) |
| `documents.model.edited` (record-side model save or restore, PRD-07) | Documents | Notifications (the model's author when someone else saved; owners of the tasks whose elements changed) | ● (sha256) |
| `collaboration.question.opened`, `.answered`, `.resolved` | Collaboration | Notifications, Reputation (answer time) | ● |
| `collaboration.minute.acknowledged` | Collaboration | Feed | ● |
| `reputation.review.published` | Reputation | Directory | — |
| `billing.subscription.changed` | Billing | IAM cache | — |

**`tendering.rfp.cancelled` data (PRD-02 T-19):** `rfp_id, project_id, reason?` — the issuer's optional one-line reason.
**`tendering.rfp.published` (PRD-02 T-7):** the personal links of the recipients queued on the draft are minted in the same
transaction (ledger payload `links_minted`); the individual emails leave after commit. Removing a queued recipient from a draft is
ledgered as `tendering.rfp.recipient_removed` (audit only, no outbox event — nothing was ever sent).

**`tendering.rfp.published` data (PRD-04):** adds `listed` and `specialty_codes` (`visibility` stays, deprecated, in step with
`listed`).

**`tendering.bid_request.*` data (D-47, PRD-04 X-13):** `rfp_id, bid_request_id, org_id` (the asking company); `.approved` adds
`adopted` (true when a prior e-mail invite to the org's address became its lane). Scope `rfp_private` (id = the request): the
ledger payload carries `rfp_id, bid_request_id` (+ `adopted`) and **no organisation** (D-29: who bids stays in `tendering.*`);
the outbox data carries `org_id` so the notification centre can tell the company. `tendering.rfp.invitation_declined` (a
company declines its invite from the inbox) is ledger-only, no outbox event.

**`tendering.rfp.recipients_added` (outbox only, PRD-04 X-2):** `rfp_id, project_id, count` — published only when links were
minted on an already-sent RFP. The directory then reads the address-only invitees through tendering's published
**invitee port** (`emailInviteesOf(rfpId)` → `{emails, specialty_codes}`, sent RFPs only) and seeds one unclaimed profile
per company address (`domain/unclaimed.mjs`: the name is the address's domain; personal-mail hosts are skipped — no person
is ever listed). Addresses never travel on an event or the ledger here.

**`directory.profile.claimed` data (PRD-04 §6 criterion 3):** `org_id` (the claimant), `previous_profile_id`, `slug`,
`email` (the address the claim link went to). Scope `org_private` (the claimant), no project, outbox only (directory
writes are not ledgered). Tendering's consumer sets `org_id` on every invite to that address that has none — and the
`bidder_org_id` of their lanes — except on the claimant's own RFPs; it only fills NULLs, so a replay changes nothing.

**`tendering.clarification.answered` data (PRD-08 H-8):** `rfp_id, clarification_id` — scope `project`; never the asker
(V8). The answer is public to every bidder of the RFP. Consumers: the notification centre (PRD-12) notifies every bidder org;
token-only bidders (recipients with no org) are emailed a link-less notice by tendering itself after commit (their personal
links are stored hashed, so no link can be put in the mail). `tendering.clarification.asked` is ledger-only (scope
`rfp_private`), no outbox event.

**`tendering.rfp.awarded` data (D-43):** `rfp_id, proposal_id, contract_id, root_task_ids[], supplier_org_id, start, duration_wd` —
the winning proposal's start (`summary_start`) and duration (`summary_duration_wd`), `null` when the bid carries none. Planning
takes the awarded branch's baseline v1 (reason `award`) from these facts alone; it never reads `tendering.*`.
`planning.baseline.taken` data carries `reason`.
Since PRD-05 the award also carries `purpose` (`design` | `execution`) and `deliverables[]` — for a design RFP, the list items
(`- `, `* `, `• `, `1.` / `1)`) of the RFP's "Brief & deliverables" text (`scope_text`), at most 50, each ≤ 300 characters; `[]`
otherwise. Planning seeds them as **required deliverables** of the first tendered row (`source_rfp_id` = the RFP; idempotent on
task + RFP + title), D-39/D-48.

**`documents.version.uploaded` data (PRD-05):** `document_id, version_no, scope_type, scope_id, kind, title, sha256, mime, note,
linked_task_ids[]` (the tasks linking the document at that moment). `documents.link.added` / `.removed` are ledger-only (scope
`project`), no outbox event.

**Markups and DWG previews (PRD-06).** Saving markups appends a `markup_only` document version (same bytes, same
sha256) and is ledgered as `documents.markups.saved` (data `document_id, version_no, base_version_no, sha256,
markup_ids[]`, scope `project`) — **no outbox event**: the bytes did not change, so no "new version" notification and no
deliverable re-review (PRD-05 F-11/F-15 consumers stay quiet). Closing, re-opening and linking a markup to the question or
issue it became are ledger-only (`documents.markup.closed` / `.reopened` / `.linked`). The question and the issue are the
existing `collaboration.question.opened` and `quality.nonconformity.raised`, notified as before. Documents **consumes its own
`documents.version.uploaded`** for DWG/DXF versions: the conversion job (DwgConverter port, D-49) writes the preview
artefacts and sets `preview_status` `ready` / `unavailable` (+ reason) — derived state, not ledgered. Idempotent: the
preview is keyed by (document, sha256); a replay finds it and only re-mirrors the status.

**`documents.model.edited` data (PRD-07 M-12, M-17):** `document_id, version_no, base_version_no, change_kind (edit | restore),
note, sha256 (the re-pointed bytes — unchanged, D-45), author_org_id, edited_by_author, change_count, links_added, links_removed,
pins_added[], pins_closed[], task_ids[]` (the rows whose elements changed). Scope `project`. A new `.ifc` of the model is the
ordinary `documents.version.uploaded`.

**`planning.deliverable.*` data (PRD-05 F-13..F-15):** `deliverable_id, task_id, title, submission_id, document_id, version_no,
sha256, submitted_by_org_id`; `.approved` / `.changes_requested` add `decided_by_org_id, decided_by_person_id, comment?`. Scope
`project`. `.submitted` is also published when a new version of a submitted document re-opens the review (actor = the uploader).
Creating, editing, removing and seeding deliverables is ledger-only (`planning.deliverable.created` / `.updated` / `.removed` /
`.seeded`).

Ledgered events store their `data` as the ledger payload with the event's `scope`; the ledger is
written by the producing module inside its transaction, the outbox row in the same transaction.

**`planning.progress.reported` (PRD-10 E-5, E-6):** a start before the task's predecessors are there carries
`out_of_sequence: {reason, waiting_on: [{task_id, name, status, needs}]}` (the D-48 override, also in the ledger payload); a `done`
carries `acceptance: [{criterion, met}]` when the task has a checklist (Quality's verification snapshot).

**`planning.daily_log.recorded` data (PRD-10 E-7):** `date, entry_ids[], kinds{kind: count}, task_ids[]` (the rows the capture
tagged), scope `project`. One per capture (`addDailyLogEntries`), written with the entries; the ledger payload carries the same
plus each photo's `document_id` and `version_no`. Headcounts, notes and weather stay in `planning.daily_log_entry`.

**`planning.baseline.taken` → Project (PRD-10 E-13):** the first baseline of a build moves its `execution` phase
`pending → active` (the procurement phase stays active: tendering goes on specialty by specialty, D-43). A projection of the
ledgered baseline, not ledgered itself; idempotent (only a `pending` phase moves).

**`planning.plan.imported` data (PRD-09 O-12):** `import_id, filename, sheet, actions, sub_actions, links, warnings,
imported_by_org_id, imported_by_org_name, owner_org_id` — scope `project`. Written in the confirm's plan transaction with the
rows (the structural batch's own `planning.task.moved` entry stays the row-level audit); the ledger payload carries the
same counts, which is the record's "Plan imported by {GC}, {n} actions, {m} sub-actions" stamp (flow 01 screen 11).

**`quality.nonconformity.*` data (PRD-12 N-3):** `nonconformity_id, project_id, task_id, contract_id, location_id, kind,
severity, status, assigned_to_org_id, raised_by_org_id` (+ `note` on the transitions) — scope `project`. Contracting's
reception guard reads `status`; the notification centre names the assigned or the raising org from the data alone.

**`collaboration.question.opened` data (PRD-12 N-5):** adds `topic` (`clarification` | `design_change` | `scope_gap`); a
`scope_gap` is always addressed to the project owner (read through the project's build port `ownerOf`, never
`project.*`). `.answered` adds `topic` and, for a design change, `decision` (`approved` | `rejected`).

**Share links (PRD-12 N-12, flow D21) — ledger only, no outbox event:** `project.share_link.created` (audience, document
ids, expiry), `project.share_link.revoked`, and `project.share_link.accessed` for every access the public surface serves
(`share_link_id, action (view | download), document_id?`) — scope `project`, so every participant can see that "the
municipality opened the licence pack on T". The address and user agent stay in `project.share_link_access` (owner-only
read), never in the hash chain.

**`project.invitation.accepted` data (PRD-12 N-1):** `invitation_id, org_id, invited_by_org_id, invite_capacity` — scope
`project`. Published in the acceptance transaction (it was ledger-only before PRD-12).

### Notification centre (PRD-12 N-1, N-2)

Collaboration owns `collaboration.notification` and turns events into per-person rows. It never reads another
module's tables to find recipients: each owning module publishes a **notification port** (application layer),
injected at the composition root (`app/src/server/v2/dispatcher.ts`):

| Event | Category | Recipients | Port that names them | Deep link (`object_ref.url`) |
|---|---|---|---|---|
| `tendering.proposal.submitted` | `bids` | issuer org | tendering `rfpAudience` | `/projects/{p}/plan?task={root}&tab=tender` |
| `tendering.clarification.answered` | `tendering` | bidder orgs with an account (never the issuer) | tendering `rfpAudience` | `/projects/{p}/tendering/rfps/{rfp}?tab=clarifications` |
| `tendering.rfp.awarded` | `tendering` | winner org ("won"), every other bidder org ("not selected") | tendering `rfpAudience` | `/projects/{p}/tendering/rfps/{rfp}` |
| `tendering.rfp.cancelled` | `tendering` | bidder orgs | tendering `rfpAudience` | `/projects/{p}/tendering/rfps/{rfp}` |
| `tendering.bid_request.requested` | `bids` | issuer org | tendering `rfpAudience` | `/projects/{p}/plan?task={root}&tab=tender` |
| `tendering.bid_request.approved` / `.declined` | `tendering` | the asking company (`data.org_id`, by role `org:tendering:bid`) | — (on the event) | `/requests/{rfp}` · `/requests?tab=near` |
| `planning.variation.recorded`, `.updated` | `variations` (15-min digest) | owner + client of the row's contract, narrowed by `collaboration.variation_subscription` | planning `variationAudience` | `/projects/{p}/plan` |
| `project.invitation.accepted` | `invitations` | inviter org | — (on the event) | `/projects/{p}` |
| `collaboration.question.opened` / `.answered` / `.resolved` | `questions` | addressee / asker / addressee org | — (on the event) | `/projects/{p}/questions?q={comment}` |
| `quality.nonconformity.raised`, `.assigned`, `.fix_rejected` | `quality` | the assigned org (never the actor's org) | — (on the event) | `/projects/{p}/quality?nc={id}` |
| `quality.nonconformity.fixed` | `quality` | the raising org (it closes or rejects the fix) | — (on the event) | `/projects/{p}/quality?nc={id}` |
| `quality.nonconformity.closed` | `quality` | the assigned org | — (on the event) | `/projects/{p}/quality?nc={id}` |
| `planning.deliverable.submitted` | `files` | the client side of the task: orgs whose edit scope contains the row (owner, clients up the branch chain), minus the assignee and the submitter | planning `deliverableAudience` | `/projects/{p}/plan?task={t}&tab=files` |
| `planning.deliverable.approved`, `.changes_requested` | `files` | the submitter org and the task's assignee org (never the decider) | planning `deliverableAudience` | `/projects/{p}/plan?task={t}&tab=files` |
| `documents.version.uploaded` (with `linked_task_ids`) | `files` | the owner of every linking task — its effective assignee org, else the project owner — minus the uploader | planning `taskOwners` | `/projects/{p}/plan?task={t}&tab=files` |
| `planning.plan.imported` | `plan` | the project owner (`data.owner_org_id`), never the importing org | — (on the event) | `/projects/{p}/plan` |
| `documents.model.edited` | `files` | the model's author (not when it saved itself) + the owner of every task whose elements changed (effective assignee org, else the project owner) — never the editing org | planning `taskOwners` | `/projects/{p}/model?version={n}` |

People inside a recipient org come from the identity port `projectAudience(projectId, orgId)` (staffed on the
project, or admin/manager — the same rule as reading the project) or `orgAudience(orgId, permission)` for bidders,
who are not project participants. A person with `in_app` off for the category gets no row; with `email` on
(the default) a new row is also mailed through the shared MailSender port, after the row is written — a replayed
event inserts nothing and so mails nothing.

### Directory read model — "On the record" (PRD-03 R-11, D-46)

Directory never reads another module's tables for the facts it shows: it keeps its own read model
(`directory.record_contract`, `record_task`, `record_change_order`, `record_proposal`), filled by an idempotent consumer
(dedupe on `event_id` in `directory.consumed_event`; every write is an upsert by the source id):

| Event | Read-model effect |
|---|---|
| `contracting.contract.signed` (`kind, client_org_id, supplier_org_id`) | contract row, `status = signed`, `signed_at` — the supplier gains a **verified client** (D-46) |
| `contracting.contract.activated` / `.provisionally_received` / `.closed` / `.terminated` (`from, to`) | contract status; `closed`/`terminated` stamp `finished_at` |
| `contracting.change_order.submitted` / `.approved` / `.rejected` / `.withdrawn` (`change_order_id, contract_id`) | change-order status (raised = reached `submitted`) |
| `planning.progress.reported` with `status = done` | task row: `assignee_org_id, contract_id, baseline_finish, actual_finish` (on time ⇔ actual ≤ baseline) |
| `planning.progress.reported` with `not_started` / `in_progress` / `blocked` | removes the task row (a rejected verification re-opens the work); `verified` keeps it |
| `tendering.proposal.submitted` (`proposal_id, bidder_org_id`) / `tendering.rfp.awarded` (`proposal_id`) | proposals sent / awarded for the listing stats |

**`planning.progress.reported` data on `done` (PRD-03):** adds `assignee_org_id` (the row's effective assignee),
`contract_id` (its branch contract, null outside any branch), `baseline_finish` and `actual_finish` (`YYYY-MM-DD` or
null). Amounts never travel. Directory produces one event, `directory.profile.claimed` (PRD-04, above).
