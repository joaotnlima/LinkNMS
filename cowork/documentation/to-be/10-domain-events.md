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
| `tendering.rfp.published`, `.addendum_issued`, `.closed`, `.awarded`, `.cancelled` | Tendering | Notifications, Directory (open listing), Planning (`.awarded` → baseline at award, D-43) | ● |
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
