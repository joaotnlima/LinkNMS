# 09 — State machines

Every lifecycle is a **declared transition table** in the module's `domain/` layer, executed by one
`transition(aggregate, action, actor)` function. Status columns are constrained enums in the DB
(a closed type), transitions are decided in code, and every transition emits an event and — where
marked ● — a ledger entry. This closes the as-is gap of scattered `if (status !== …)` checks.

## Project ●
| From | Action | To | Guard |
|---|---|---|---|
| draft | publish_first_rfp | tendering | brief complete |
| draft / tendering | sign_first_owner_contract | contracted | ≥1 prime/direct contract signed |
| contracted | start | in_execution | first task in_progress |
| in_execution | close | closed | all owner-level contracts closed or terminated |
| draft / tendering | cancel | cancelled | no signed contract |

## RFP ●
draft → published (`publish`) → closed (`deadline` / `close_early`) → awarded (`award`); draft/published/closed → cancelled.
Guard on award: proposal `submitted`/`shortlisted`, status `closed` (or all invitees responded).

## Proposal (lane)
invited → draft → submitted → shortlisted → awarded | declined; invited → submitted (issuer records an emailed answer); submitted/shortlisted → withdrawn (bidder, before award).
Revisions while RFP is `published` create a new version; the latest submitted version counts.

## Contract ●
See [06](./06-tendering-and-contracting.md). `signed` requires both signatures; `provisionally_received` requires no open non-conformities; `closed` after warranty period or manual final reception.

## Change order ●
draft → submitted → approved | rejected; draft/submitted → withdrawn (proposer). Guard: decider org ≠ proposer org; contract in `signed`/`active`.

## Measurement ●
draft → submitted → approved | disputed; disputed → submitted (revised).

## Payment record ●
expected → declared_paid (client) → confirmed (supplier); declared_paid → disputed → declared_paid.

## Task status (derived) ●
not_started → in_progress → blocked ⇄ in_progress → done → verified; done → in_progress (rejected). Corrections backwards require a note.

## Task schedule state (derived, not ledgered)
`planned` (no baseline) | `on_baseline` | `extended` (current finish beyond baseline) | `sequence_warning` — recomputed after every change.

## Variation
open → acknowledged (owner / contract client) → formalised (change order approved, re-baselined) | closed (the row returns to its baseline, or the task is verified done).
A new change on the same row and kind re-opens an acknowledged variation. `questioned` is a flag, not a state: an open question may exist at any point.

## Verification request ●
pending → accepted | rejected.

## Non-conformity ●
open → assigned → fixed → closed; fixed → assigned (fix rejected).

## Question
open → answered → resolved; answered → open (follow-up).

## Meeting minute ●
draft → circulated → acknowledged (all attendees).

## Subscription
trialing → active → past_due → canceled; past_due → active.
