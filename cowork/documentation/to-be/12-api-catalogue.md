# 12 — API catalogue by use case

Every use case the UI needs, mapped to the endpoint that serves it. The machine-readable contract is
[`api/v2/openapi.yaml`](../../../api/v2/README.md) (153 operations); when the two disagree, fix both in the same change. If a screen needs something
not listed here, the catalogue is extended first — the UI never works around it.
Actor abbreviations: **OW** owner (household) · **GC** general contractor · **SP** specialty /
subcontractor · **CS** consultant · **ANY** any authorized participant.

## Identity & Access
| Use case | Actor | Endpoint |
|---|---|---|
| Who am I, my orgs, my pending invites | ANY | `GET /me` |
| Create organization (on sign-up) | ANY | `POST /organizations` |
| Invite person to my org / change role / remove | org admin | `POST /organizations/{id}/members`, `PATCH …/members/{personId}`, `DELETE …` |
| Accept org invitation | invitee | `POST /org-invitations/{token}:accept` |
| Staff people on a project | org admin/manager | `PUT /projects/{id}/staffing/{personId}` · `DELETE …` |

## Directory (marketplace)
| Use case | Actor | Endpoint |
|---|---|---|
| Edit my profile, credentials, areas, specialties | org admin | `PUT /organizations/{id}/profile` |
| See completeness score and how to raise it | org admin | `GET /organizations/{id}/profile/completeness` |
| Add/remove declared portfolio entry | org admin | `POST /organizations/{id}/portfolio` · `DELETE …/{entryId}` |
| Search companies | ANY | `GET /directory/organizations?specialty=&municipality=&kind=&min_rating=&cursor=` |
| View a company (profile, portfolio, rating, metrics) | ANY | `GET /directory/organizations/{id}` |
| Specialty catalogue | ANY | `GET /specialties` |

## Project (pre-project)
| Use case | Actor | Endpoint |
|---|---|---|
| Create a project (brief) | OW (or GC on behalf) | `POST /projects` |
| Claim a project created on my behalf | OW | `POST /projects/{id}:claim` |
| Edit brief | OW | `PATCH /projects/{id}` |
| Manage buildings/units | OW | `POST /projects/{id}/locations` · `PATCH/DELETE /locations/{id}` |
| My portfolio of projects (with status, variance, open questions) | ANY | `GET /projects?role=&status=` |
| Project overview (owner control view: baseline/forecast/actual, cost if visible, open items) | participant | `GET /projects/{id}/overview` |
| Participants on the build | participant | `GET /projects/{id}/participants` |
| Invite a consultant (no priced contract) | OW, GC | `POST /projects/{id}/invitations` · `POST /project-invitations/{token}:accept` |
| Cancel / close project | OW | `POST /projects/{id}:cancel` · `:close` |

## Planning & Execution (the plan / WBS) — behaviour in [05](./05-planning-and-execution.md)
| Use case | Actor | Endpoint |
|---|---|---|
| Load the plan: tree, links, dates, segments, `can_edit` per row for the viewer, (baseline / current / extension / actual), cost roll-up per viewer, health | participant | `GET /projects/{id}/schedule?root=&depth=&assignee=&location=&status=` |
| Create a row (task / milestone) under a parent — assignee inherited from the branch | edit scope contains the parent (D-33) | `POST /projects/{id}/tasks` (client `id`) |
| Commit a change to one row (name, dates, duration, assignee, description, dating mode) — delta + propagation; response flags `editor_is_assignee` | edit scope contains the row | `PATCH /tasks/{id}` |
| Move / indent / outdent / delete a subtree, paste rows | edit scope contains every affected row and the target parent | `POST /projects/{id}/schedule:apply` |
| Add / change / remove a link (`from_anchor`, `to_anchor`, lag) | edit scope contains the successor | `POST /tasks/{id}/links` · `PATCH /links/{id}` · `DELETE /links/{id}` |
| Preview a drag before committing (resulting lag, rows that would move by propagation) | edit scope contains the row | `POST /tasks/{id}:preview-move {start?, finish?}` |
| Cost lines on a row (qty, unit, unit price, material spec) | contract party / row editor | `POST /tasks/{id}/cost-lines` · `PATCH /cost-lines/{id}` · `DELETE /cost-lines/{id}` |
| Record the actual date of an external row (licence issued) | edit scope contains the row | `POST /tasks/{id}:record-actual {finish}` |
| Task detail (fields, history of every delta, variations, progress, questions, documents) | participant | `GET /tasks/{id}` |
| Report progress (with photos) | edit scope contains the row (attributed) | `POST /tasks/{id}/progress` |
| Change view: variations vs baseline (time / cost / material / scope), net and history | participant (cost per V2/V5) | `GET /projects/{id}/variations?kind=&since=&status=` · `GET /variations/{id}` |
| Acknowledge a variation | owner, contract client | `POST /variations/{id}:acknowledge` |
| Question a variation (opens a question to the responsible party) | participant | `POST /variations/{id}:question` |
| Formalise variations as a change order (optional) | contract party | `POST /contracts/{id}/change-orders {from_variation_ids[]}` |
| Plan health (undated, unassigned, open external, sequence warnings, uncosted) | participant | `GET /projects/{id}/schedule/health?root=` |
| Baselines of a branch | participant | `GET /projects/{id}/baselines?root=` |
| My rows (this week, late, extended) | ANY | `GET /me/tasks?window=week&state=extended` |
| Site presence calendar | participant | `GET /projects/{id}/site-calendar?from=&to=` |
| Project calendar (work days, holidays, closures) | owner/GC edit, participants read | `GET/PUT /projects/{id}/calendar` |
| Import plan from Excel (under a row) | edit scope contains the target parent | `POST /projects/{id}/schedule-imports` → `:map` → `:preview` → `:confirm` |
| Template library: browse by construction type / phase / scope (personal, org, public, LinkNMS) | ANY | `GET /plan-templates?construction_type=&phase=&scope=` · `GET /plan-templates/{id}` |
| Save the plan or a selected subtree as a template (structure + links only) | any participant (reading is enough) | `POST /plan-templates {root_task_ids[], scope, construction_type, phase_tags}` |
| Share / unshare, edit, delete a template | template owner | `PATCH /plan-templates/{id}` · `DELETE /plan-templates/{id}` |
| Insert a template under a row, unticking specialties (links bridged) | edit scope contains the target parent | `POST /projects/{id}/schedule:apply {insert_template: {template_id, parent_task_id, exclude_row_keys[]}}` |
| Documents on a row | row readers | `POST /documents {scope_type: task}` (see Documents) |
| Request proposals from a row / subtree | owner, or GC for its own branch | `POST /projects/{id}/rfps {root_task_ids[], recipients[]}` (see Tendering) |
| Live updates (row deltas, propagation, variations, presence) | participant | `GET /projects/{id}/events:stream` |

## Tendering
| Use case | Actor | Endpoint |
|---|---|---|
| Create RFP from one or more plan rows (package = subtree + docs + cost lines without prices) | OW · GC (own branch) | `POST /projects/{id}/rfps {root_task_ids[]}` |
| Add recipients: platform orgs (search by specialty + area) and/or emails | issuer | `POST /rfps/{id}/recipients` · `GET /directory/organizations?specialty=&municipality=` |
| Per-recipient delivery status (sent / opened / proposal / declined) | issuer | `GET /rfps/{id}/recipients` |
| Edit package (BoQ template, tasks, docs) | issuer | `PATCH /rfps/{id}` · `PUT /rfps/{id}/boq` |
| Publish (sends one individual email per recipient) / addendum / close / cancel | issuer | `POST /rfps/{id}:publish` · `/addenda` · `:close` · `:cancel` |
| Browse open RFPs matching me | SP, GC | `GET /marketplace/rfps?specialty=&municipality=` |
| My RFP inbox (invited + applied) | SP, GC | `GET /me/rfps` |
| Ask / answer clarification | bidder / issuer | `POST /rfps/{id}/clarifications` · `POST /clarifications/{id}:answer` |
| Proposal lanes under a tendered row, with pre-computed comparison (price, duration, dates, missing lines, docs, status, link) | issuer: all lanes · bidder: own lane | `GET /tasks/{id}/proposal-lanes` |
| Build my proposal plan in my lane (rows, durations/dates, links, prices, docs) | bidder | `GET /proposals/{id}` · `POST /proposals/{id}/rows` · `PATCH /proposal-rows/{id}` · `PUT /proposals/{id}/lines` · `POST /proposals/{id}:submit` · `:withdraw` |
| Record an answer received by email (PDFs + total, duration, conditions) | issuer | `POST /proposals/{id}:record-offline` |
| Compare proposals line by line | issuer | `GET /rfps/{id}/comparison` |
| Shortlist / award (on signature: copy the winner's plan under the tendered row, or assign the row if answered by email) | issuer | `POST /proposals/{id}:shortlist` · `POST /rfps/{id}:award {proposal_id}` |

## Contracting
| Use case | Actor | Endpoint |
|---|---|---|
| Create contract directly (off-platform deal) | client | `POST /projects/{id}/contracts` |
| Contract detail (projected: V2 full, V3 scope only) | participant | `GET /contracts/{id}` |
| Contract tree of the project | participant | `GET /projects/{id}/contracts` |
| Edit draft BoQ / terms | client (draft) | `PUT /contracts/{id}/boq` · `PATCH /contracts/{id}` |
| Sign / counter-sign | managers of both orgs | `POST /contracts/{id}:sign` |
| Sponsor supplier seats | client | `POST /contracts/{id}:sponsor` |
| Provisional / final reception, terminate | client | `POST /contracts/{id}:receive-provisionally` · `:close` · `:terminate` |
| Propose change order (scope/time), link back-to-back | either party | `POST /contracts/{id}/change-orders` |
| Submit / approve / reject / withdraw CO | per state machine | `POST /change-orders/{id}:submit` · `:approve` · `:reject` · `:withdraw` |
| Submit measurement (suggested from verified tasks) | supplier | `GET /contracts/{id}/measurements:suggest?period=` · `POST /contracts/{id}/measurements` |
| Approve / dispute measurement | client | `POST /measurements/{id}:approve` · `:dispute` |
| Declare / confirm payment | client / supplier | `POST /payments/{id}:declare-paid` · `:confirm` · `:dispute` |
| Owner cash-flow (all owner-level contracts) | OW | `GET /projects/{id}/cash-flow?from=&to=` |
| Contractor financials per contract (value, COs, measured, paid, retention) | party | `GET /contracts/{id}/financials` |

## Quality
| Use case | Actor | Endpoint |
|---|---|---|
| Verification queue | coordinator | `GET /me/verifications?status=pending` |
| Accept / reject completion | coordinator | `POST /verifications/{id}:accept` · `:reject` |
| Raise / assign / fix / close non-conformity | per state machine | `POST /projects/{id}/nonconformities` · `POST /nonconformities/{id}:assign` · `:fix` · `:close` · `:reject-fix` |
| Record inspection | CS | `POST /projects/{id}/inspections` |

## Documents
| Use case | Actor | Endpoint |
|---|---|---|
| Upload (new doc or new version) | per scope | `POST /documents` · `POST /documents/{id}/versions` · `POST /document-versions/{id}:complete` |
| List documents of an object | readers of scope | `GET /documents?scope_type=&scope_id=` |
| Download | readers of scope | `GET /document-versions/{id}:download` |

## Collaboration
| Use case | Actor | Endpoint |
|---|---|---|
| Comment / ask question on any object | readers | `POST /threads/{objectType}/{objectId}/comments` |
| Answer / resolve question | addressee / asker | `POST /comments/{id}:answer` · `:resolve` |
| Open questions addressed to me | ANY | `GET /me/questions?status=open` |
| Meeting minutes | participant | `POST /projects/{id}/minutes` · `:circulate` · `:acknowledge` |
| Activity feed | participant | `GET /projects/{id}/activity?cursor=` |
| Notifications & preferences | ANY | `GET /me/notifications` · `POST /notifications:mark-read` · `PUT /me/notification-preferences` |

## Record
| Use case | Actor | Endpoint |
|---|---|---|
| Who changed what, when (projected, redacted outside scope) | participant | `GET /projects/{id}/record?object_type=&object_id=&cursor=` |
| Verify chain integrity | participant | `POST /projects/{id}/record:verify` |
| Export the record (PDF/JSON) | participant | `POST /projects/{id}/record:export` |

## Reputation
| Use case | Actor | Endpoint |
|---|---|---|
| Reviews I can write now | ANY | `GET /me/reviews/eligible` |
| Write / reply | eligible reviewer / subject | `POST /reviews` · `POST /reviews/{id}:reply` |
| Reviews & metrics of an org | ANY | `GET /organizations/{id}/reviews` · `GET /organizations/{id}/metrics` |
| Consent to portfolio photos | OW | `PUT /projects/{id}/portfolio-consent` |

## Billing
| Use case | Actor | Endpoint |
|---|---|---|
| Plans for my org kind | org admin | `GET /billing/plans` |
| Subscribe / change / cancel | org admin | `POST /billing/subscriptions` · `PATCH …/{id}` · `:cancel` |
| Usage vs entitlements | org admin | `GET /billing/usage` |
| Buy add-ons (open-RFP credits, promotion) | org admin | `POST /billing/add-ons` |
| Provider webhook | system | `POST /billing/webhooks/{provider}` |
