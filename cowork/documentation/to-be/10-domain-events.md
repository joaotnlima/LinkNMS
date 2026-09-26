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
| `tendering.rfp.published`, `.addendum_issued`, `.closed`, `.awarded`, `.cancelled` | Tendering | Notifications, Directory (open listing) | ● |
| `tendering.clarification.answered` | Tendering | Notifications | ● |
| `tendering.proposal.submitted`, `.withdrawn` | Tendering | Notifications (issuer) | ● (scope: rfp issuer + bidder) |
| `contracting.contract.created`, `.signed`, `.activated`, `.provisionally_received`, `.closed`, `.terminated` | Contracting | Project (participation), Planning (bind + baseline), Reputation, Billing | ● |
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

Ledgered events store their `data` as the ledger payload with the event's `scope`; the ledger is
written by the producing module inside its transaction, the outbox row in the same transaction.
