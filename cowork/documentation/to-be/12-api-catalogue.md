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
| Members of my org with their roles | org admin | `GET /organizations/{id}/members` |
| Invite person to my org / change role / remove (Clerk invitation + membership, PRD-12 N-9) | org admin | `POST /organizations/{id}/invitations`, `PATCH /organizations/{id}/members/{personId}`, `DELETE …` |
| Accept org invitation | invitee | Clerk's hosted invitation flow (doc 16 §2) — no LinkNMS endpoint |
| Staff people on a project | org admin/manager | `PUT /projects/{id}/staffing/{personId}` · `DELETE …` |

## Directory (marketplace)
| Use case | Actor | Endpoint |
|---|---|---|
| My profile as I edit it | org admin/manager | `GET /organizations/{id}/profile` |
| Create / edit my profile: specialties, base + radius, availability, stated credentials (PRD-03 R-3, R-20) | org admin/manager | `PUT /organizations/{id}/profile` (If-Match once it exists) |
| Completeness checklist — never changes the order (R-19, D-46) | org admin/manager | `GET /organizations/{id}/profile/completeness` |
| Your listing, last 30 days (R-17) | org admin/manager | `GET /organizations/{id}/listing-stats` |
| My portfolio; add/remove a stated entry | org admin/manager | `GET`/`POST /organizations/{id}/portfolio` · `DELETE …/{entryId}` |
| Find companies near a build (R-4..R-7, D-46) | ANY (public) | `GET /directory/organizations?specialty=&near_project=\|lat=&lng=&radius_km=&municipality=&can_start_by=&work_type=&proof=&size=&claimed=&cursor=` |
| A company's public profile (R-10..R-16) | ANY (public) | `GET /directory/organizations/by-slug/{slug}` · `GET /directory/organizations/{id}` |
| Claim an unclaimed profile — link to the profile's e-mail (R-16) | org admin/manager | `POST /directory/organizations/{id}:claim` · `POST /directory/claims/{token}:accept` |
| Show my build's name on its companies' profiles (R-12) | OW | `GET`/`PUT /projects/{id}/portfolio-consent` |
| Specialty taxonomy, two levels PT/EN (R-1) | ANY (public) | `GET /specialties` |
| Plan specialty labels (free text, per org) | ANY | `GET`/`POST /specialty-labels` |

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
| Preview a drag before committing (resulting lag, rows that would move by propagation, new project finish, delta vs baseline, who is notified — PRD-13 S-10) | edit scope contains the row | `POST /tasks/{id}:preview-move {start?, finish?}` |
| Cost lines on a row (qty, unit, unit price, material spec) | contract party / row editor | `POST /tasks/{id}/cost-lines` · `PATCH /cost-lines/{id}` · `DELETE /cost-lines/{id}` |
| Record the actual date of an external row (licence issued) | edit scope contains the row | `POST /tasks/{id}:record-actual {finish}` |
| Task detail (fields, history of every delta, variations, progress, questions, documents) | participant | `GET /tasks/{id}` |
| Report progress (with photos) — `done` refused while a required deliverable is unapproved (D-48) | edit scope contains the row (attributed) | `POST /tasks/{id}/progress` |
| Deliverables of a task: state, x of n approved, done gate, what the viewer may do (PRD-05) | participant | `GET /tasks/{id}/deliverables` · `GET /projects/{id}/deliverables` |
| Add / edit / remove a required deliverable | client side of the task (edit scope ∋ row, not the assignee) | `POST /tasks/{id}/deliverables` · `PATCH /deliverables/{id}` · `DELETE /deliverables/{id}` |
| Submit a file version against a deliverable (with a note) | the task's assignee org | `POST /deliverables/{id}:submit {document_id, version_no?, note?}` |
| Approve / request changes (approval records person, org, time, version sha256) | client side of the task, never the submitter | `POST /deliverables/{id}:approve` · `:request-changes {comment}` |
| Change view: variations vs baseline (time / cost / material / scope), net and history | participant (cost per V2/V5) | `GET /projects/{id}/variations?kind=&since=&status=` · `GET /variations/{id}` |
| Acknowledge a variation | owner, contract client | `POST /variations/{id}:acknowledge` |
| Acknowledge several variations at once ("Acknowledge all in view", PRD-13 S-15) | owner, contract client | `POST /projects/{id}/variations:acknowledge {variation_ids[]}` |
| Question a variation (opens a question to the responsible party) | participant | `POST /variations/{id}:question` |
| Formalise variations as a change order (optional) | contract party | `POST /contracts/{id}/change-orders {from_variation_ids[]}` |
| Plan health (undated, unassigned, open external, sequence warnings, uncosted) | participant | `GET /projects/{id}/schedule/health?root=` |
| Baselines of a branch | participant | `GET /projects/{id}/baselines?root=` |
| My rows (this week, late, extended) | ANY | `GET /me/tasks?window=week&state=extended` |
| Site presence calendar | participant | `GET /projects/{id}/site-calendar?from=&to=` |
| Project calendar (work days, holidays, closures) | owner/GC edit, participants read | `GET/PUT /projects/{id}/calendar` |
| Planning settings (mobilisation lead for the award-by date, default 5 wd) | owner/GC edit, participants read | `GET/PUT /projects/{id}/planning-settings` |
| What tendering some rows means for the plan: covered / left-out rows (and why), work window, critical path, award-by date and working days from bids-due (PRD-02) | participant | `GET /projects/{id}/schedule/tender-window?task_ids=&include=&bids_due=` |
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
| Remove a queued bidder from a draft (nothing was sent yet) | issuer | `DELETE /rfps/{id}/recipients/{recipientId}` |
| Edit package (BoQ template, tasks, docs) | issuer | `PATCH /rfps/{id}` · `PUT /rfps/{id}/boq` |
| Publish (mints a link per queued recipient and sends one individual email each) / addendum / close / cancel (optional reason) | issuer | `POST /rfps/{id}:publish` · `/addenda` · `:close` · `:cancel {reason?}` |
| Browse open RFPs matching me | SP, GC | `GET /marketplace/rfps?specialty=&municipality=` |
| My RFP inbox (invited + applied) | SP, GC | `GET /me/rfps` |
| Ask / answer clarification (asking only until `questions_deadline`; answers public to all bidders, asker never shown) | bidder / issuer | `POST /rfps/{id}/clarifications` · `POST /clarifications/{id}:answer` |
| Ask a clarification from the personal link (no session) | link-only bidder | `POST /rfp-links/{token}/clarifications` |
| Tendering home of a project: every RFP the viewer can see, with covered tasks, bids due, `n/m in` and open questions (issuer); own lane (bidder) | participant · bidder | `GET /projects/{id}/rfps` |
| Per-task procurement state of a project (Tender column + Gantt band: governing RFP, status, opened / bids due, invited & landed counts, winner — no prices) | issuer (participant; only RFPs it issued) | `GET /projects/{id}/task-procurement` |
| Proposal lanes under a tendered row, with pre-computed comparison (price, duration, dates, missing lines, docs, status, link) | issuer: all lanes · bidder: own lane | `GET /tasks/{id}/proposal-lanes` |
| Build my proposal plan in my lane (rows, durations/dates, links, prices, docs) | bidder | `GET /proposals/{id}` · `POST /proposals/{id}/rows` · `PATCH /proposal-rows/{id}` · `PUT /proposals/{id}/lines` · `POST /proposals/{id}:submit` · `:withdraw` |
| Record an answer received by email (PDFs + total, duration, conditions) | issuer | `POST /proposals/{id}:record-offline` |
| Compare proposals line by line | issuer | `GET /rfps/{id}/comparison` |
| Attach the build's model to the package (follow current or pin a version) / detach it (PRD-07 §5) | issuer, draft | `PUT /rfps/{id}/model` · `DELETE /rfps/{id}/model/{documentId}` · read: `GET /rfps/{id}/model/{documentId}:view-url` (bidders: `/rfp-links/{token}/model/…`) |
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
| Files of a task (linked project files + task attachments, role, inherited, also used on) | participant | `GET /tasks/{id}/documents` |
| Link project files to a task (never a copy; optionally on every sub-task) / remove a link | edit scope contains the task | `POST /tasks/{id}/document-links` · `DELETE /tasks/{id}/document-links/{documentId}` |
| Project files (search, filter by type, tasks using each file) | participant | `GET /projects/{id}/documents?q=&type=` |
| Download | readers of scope | `GET /document-versions/{id}:download` |
| View a version in the browser (inline URL for the PDF renderer) | readers of scope | `GET /document-versions/{id}:view-url` |
| DWG / DXF preview (layouts as SVG, layers, warnings, or download-only with the reason) | readers of scope | `GET /document-versions/{id}/preview` |
| Markup layer of a drawing (every version) | readers of scope | `GET /documents/{id}/markups` |
| Save markups — a "markups only" version, same bytes and sha256 | participant reading the file | `POST /documents/{id}/markups:save` |
| Close / re-open a markup; point it at the question or issue it became | markup author (close: or scope editor) | `POST /markups/{id}:close` · `:reopen` · `:link` |
| The build's shared model: versions, element ↔ task links and issue pins at a version, the viewer's edit scope, who edits (PRD-07) | participant | `GET /projects/{id}/model?version=` |
| Upload the model's first / next `.ifc` (links and issues carry over by GlobalId) | participant (first) · model author | `POST /projects/{id}/model/versions` → `POST /document-versions/{id}:complete` |
| Save a draft of record-side edits (link / unlink / pin / close pin) as a new version; per-element merge of concurrent drafts | author · owner · D-33 scope ∋ linked rows | `POST /projects/{id}/model:save` |
| Restore vN as v(n+1) | author · owner | `POST /projects/{id}/model:restore` |
| Record changes between two versions (file changes are compared in the viewer) | participant | `GET /projects/{id}/model/record-diff?from=&to=` |
| The model card of a task's Files tab | participant | `GET /tasks/{id}/model` |

## Collaboration
| Use case | Actor | Endpoint |
|---|---|---|
| Comment / ask question on any object | readers | `POST /threads/{objectType}/{objectId}/comments` |
| Answer / resolve question | addressee / asker | `POST /comments/{id}:answer` · `:resolve` |
| Open questions addressed to me | ANY | `GET /me/questions?status=open` |
| Meeting minutes | participant | `POST /projects/{id}/minutes` · `:circulate` · `:acknowledge` |
| Activity feed | participant | `GET /projects/{id}/activity?cursor=` |
| Notifications (deep link in `object_ref.url`, `unread_count` for the bell) & preferences | ANY | `GET /me/notifications?unread=&category=&cursor=&limit=` · `POST /notifications:mark-read` · `GET`/`PUT /me/notification-preferences` |

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

## Billing
| Use case | Actor | Endpoint |
|---|---|---|
| Plans for my org kind | org admin | `GET /billing/plans` |
| My subscription and its plan | org admin | `GET /billing/subscription` |
| Subscribe / change / cancel | org admin | `POST /billing/subscriptions` · `PATCH …/{id}` · `:cancel` |
| Usage vs entitlements | org admin | `GET /billing/usage` |
| Buy add-ons (open-RFP credits, promotion) | org admin | `POST /billing/add-ons` |
| Provider webhook | system | `POST /billing/webhooks/{provider}` |
