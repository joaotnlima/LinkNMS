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
| `tendering.rfp.published`, `.addendum_issued`, `.closed`, `.awarded`, `.cancelled` | Tendering | Notifications (`.awarded`, `.cancelled` → bidders), Directory (open listing), Planning (`.awarded` → baseline at award, D-43) | ● |
| `tendering.clarification.answered` | Tendering | Notifications | ● |
| `tendering.proposal.submitted`, `.withdrawn` | Tendering | Notifications (issuer) | ● (scope: rfp issuer + bidder) |
| `contracting.contract.created`, `.signed`, `.activated`, `.provisionally_received`, `.closed`, `.terminated` | Contracting | Project (participation), Planning (bind + baseline — a no-op when the award already took it), Reputation, Billing | ● |
| `contracting.change_order.submitted`, `.approved`, `.rejected` | Contracting | Planning (re-baseline on time CO), Notifications | ● |
| `contracting.measurement.submitted`, `.approved`, `.disputed` | Contracting | Notifications | ● |
| `contracting.payment.declared`, `.confirmed`, `.disputed` | Contracting | Reputation (payment reliability) | ● |
| `planning.task.created`, `.updated` (field delta), `.deleted`, `.moved` | Planning | Feed, SSE | ● |
| `planning.task.propagated` (rows pushed by a link, with cause) | Planning | SSE, Notifications (assignees of moved rows) | ● |
| `planning.variation.recorded`, `.updated`, `.acknowledged`, `.questioned`, `.formalised`, `.closed` | Planning | Notifications (owner digest, 15 min window), Feed, SSE | ● |
| `planning.edit.overwritten` | Planning | Notifications (overwritten author) | — |
| `planning.link.added`, `.changed`, `.removed` | Planning | SSE | ● |
| `planning.progress.reported` | Planning | Quality (on done), Feed, SSE | ● |
| `planning.baseline.taken` | Planning | Feed | ● |
| `quality.verification.accepted`, `.rejected` | Quality | Planning, Contracting (measurable qty), Reputation | ● |
| `quality.nonconformity.*` | Quality | Contracting (reception guard), Notifications | ● |
| `documents.version.uploaded` | Documents | Feed | ● (sha256) |
| `collaboration.question.opened`, `.answered`, `.resolved` | Collaboration | Notifications, Reputation (answer time) | ● |
| `collaboration.minute.acknowledged` | Collaboration | Feed | ● |
| `reputation.review.published` | Reputation | Directory | — |
| `billing.subscription.changed` | Billing | IAM cache | — |

**`tendering.rfp.cancelled` data (PRD-02 T-19):** `rfp_id, project_id, reason?` — the issuer's optional one-line reason.
**`tendering.rfp.published` (PRD-02 T-7):** the personal links of the recipients queued on the draft are minted in the same
transaction (ledger payload `links_minted`); the individual emails leave after commit. Removing a queued recipient from a draft is
ledgered as `tendering.rfp.recipient_removed` (audit only, no outbox event — nothing was ever sent).

**`tendering.clarification.answered` data (PRD-08 H-8):** `rfp_id, clarification_id` — scope `project`; never the asker
(V8). The answer is public to every bidder of the RFP. Consumers: the notification centre (PRD-12) notifies every bidder org;
token-only bidders (recipients with no org) are emailed a link-less notice by tendering itself after commit (their personal
links are stored hashed, so no link can be put in the mail). `tendering.clarification.asked` is ledger-only (scope
`rfp_private`), no outbox event.

**`tendering.rfp.awarded` data (D-43):** `rfp_id, proposal_id, contract_id, root_task_ids[], supplier_org_id, start, duration_wd` —
the winning proposal's start (`summary_start`) and duration (`summary_duration_wd`), `null` when the bid carries none. Planning
takes the awarded branch's baseline v1 (reason `award`) from these facts alone; it never reads `tendering.*`.
`planning.baseline.taken` data carries `reason`.

Ledgered events store their `data` as the ledger payload with the event's `scope`; the ledger is
written by the producing module inside its transaction, the outbox row in the same transaction.

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
| `planning.variation.recorded`, `.updated` | `variations` (15-min digest) | owner + client of the row's contract, narrowed by `collaboration.variation_subscription` | planning `variationAudience` | `/projects/{p}/plan` |
| `project.invitation.accepted` | `invitations` | inviter org | — (on the event) | `/projects/{p}` |
| `collaboration.question.*`, `quality.nonconformity.raised` | `questions`, `quality` | addressee / asker / assigned org | — (on the event) | `/projects/{p}` |

People inside a recipient org come from the identity port `projectAudience(projectId, orgId)` (staffed on the
project, or admin/manager — the same rule as reading the project) or `orgAudience(orgId, permission)` for bidders,
who are not project participants. A person with `in_app` off for the category gets no row; with `email` on
(the default) a new row is also mailed through the shared MailSender port, after the row is written — a replayed
event inserts nothing and so mails nothing.

