# 18 — Does the current database answer the to-be? (verification)

**Verdict: no.** The as-is schema supports the trust mechanics (ledger, append-only progress, two-sided
change orders) but not the product the to-be describes. 3 of 22 requirements are met as they are, 6 need
the concept reshaped, and 13 have no table at all. The to-be model was therefore written as executable DDL and
proven against the "Casa Silva" seed: [`db/v2/`](../../../db/v2/README.md).

As-is inventory (from `services/*/migrations`, `db/`): `identity` (party, project, membership,
invitation, seat, sign_in_token + a Clerk-mirror RBAC catalogue duplicated in `authz`), `schedule`
(stage, stage_progress, stage_dependency, plan_version, plan_acceptance, project_baseline,
line_material, material_movement, plan_import, plan_template, specialty, stage_comment,
stage_attachment, project_phase, phase_sign_off_request, rfp, rfp_recipient, rfp_proposal,
plan_change_log), `change_order`, `decision`, `ledger` (audit_event, budget_event), `waitlist`.

## Requirement by requirement

✔ = holds as it is · ◐ = the concept exists, the shape is wrong · ✘ = missing

| # | Requirement (to-be doc) | As-is | Fit | To-be tables |
|---|---|---|---|---|
| 1 | Many organisations per project (several subs, directs, consultants) | `membership` `UNIQUE(project_id, role)` — one of each | ✘ | `project.participation` derived from contracts |
| 2 | Organisation is the actor; people belong to orgs (16) | `party` = a person with a global role; RBAC catalogue in two schemas | ✘ | `identity.organization`, `org_membership` (Clerk mirror), `project_staffing` |
| 3 | Contract tree prime / direct / sub / service (03, 06) | none — money hangs off the project | ✘ | `contracting.contract` (+ parent, one live prime) |
| 4 | BoQ lines on the rows of the plan, per contract (D-09, D-27) | `line_material` on stage, per plan version, no contract | ◐ | `contracting.boq_item.task_id` + `contract_id` |
| 5 | Price confidentiality along the chain (V2/V3/V5) | impossible without contracts | ✘ | derived from contract parties (checks §1–2) |
| 6 | WBS 1–10 levels + milestones (D-25) | `stage.parent_id`, capped at 3 in code, no milestone | ◐ | `planning.task.depth`, `kind` |
| 7 | Stable ids (D-20) | `stage.id` re-minted per save, `key` as workaround | ✘ | client UUIDv7, no re-mint |
| 8 | Links by anchors + lag (D-21, D-32) | `stage_dependency.dep_type` FS/SS/FF, no lag | ◐ | `planning.link` (from/to anchor, lag) |
| 9 | Field-level deltas, last write wins, attribution (D-26) | whole-tree rewrite per save; `plan_change_log` per phase | ◐ | `planning.task_field_change` (+ base value, cause, channel) |
| 10 | No draft; baseline per branch at signature (D-24) | `plan_version` draft→proposed→accepted, one `project_baseline` | ✘ | `planning.baseline` per contract + `baseline_root/task/cost_line` |
| 11 | Variations + acknowledgement + digest (D-23) | `material_movement` (cost only) | ◐ | `planning.variation`, `variation_ack`, `variation_digest` |
| 12 | Dated / undated / external rows; plan health (D-28) | dates nullable, no mode | ◐ | `task.dating_mode` + health query |
| 13 | Edit scope by branch; inherited assignee (D-33) | assignee = party id; authz by role only | ✘ | `task.branch_contract_id`, `assignee_inherited` (checks §3) |
| 14 | RFP from plan rows; individual emails; lanes; email channel (D-29, D-36) | `rfp` per phase, recipients by email, proposal = a min/max budget | ✘ | `tendering.*` (rfp_root, package rows/items, recipient, proposal lane, rows, links, lines) |
| 15 | Change orders per contract, back-to-back, optional (D-08, D-23) | `change_order` per project, one delta number | ◐→✘ | `contracting.change_order(+_line, _time, linked, from_variation_ids)` |
| 16 | Measurements and payment records (D-10) | none | ✘ | `contracting.measurement(_line)`, `payment_record` |
| 17 | Verification ≠ reporter org; NC closed by raiser; inspections | `phase_sign_off_request` only | ✘ | `quality.*` with CHECKs (checks §8g–h) |
| 18 | Append-only progress | `stage_progress` SELECT/INSERT only | ✔ | `planning.progress_report` (+ `verified`, proxy reporting) |
| 19 | Tamper-evident, per-project hash chain in the same transaction | `ledger.audit_event` + `append_event()` | ✔ | `record.audit_event` + **scope** (V7 redaction), actor org/role, channel |
| 20 | Two-sided rule in the DB | `decided_by <> proposed_by` CHECK | ✔ | kept on change orders, verifications |
| 21 | Documents versioned, sha256 in the record | `stage_attachment` (single version, no hash) | ◐ | `documents.document(_version)` |
| 22 | Directory, reputation, billing per org, templates by subtree | `plan_template` (names-only JSON), `seat` per email | ✘ | `directory.*`, `reputation.*`, `billing.*`, `planning.plan_template(_row,_link)` |

## What the executable model proves

`db/v2/verify.sh` builds the 13 schemas (72 tables), loads the seed and prints:

1. **Readable contracts per organisation (V2).** Douro reads its prime and both subs; the owner never
   reads a sub.
2. **Cost column per viewer (V5, D-27).** On *Caixilharia*, the owner sees €19,680 cost, Douro sees
   €19,680 revenue, €15,840 cost and €3,840 margin, and Atlântico sees €15,840 revenue.
3. **Edit scope (D-33).** The owner can edit 19 rows, Douro 13, Atlântico 3, Canalizações Norte 1,
   Eletro Mota 1.
4. **Owner's change view.** Four time variations plus the formalised cost one. The material change on
   the sub contract is invisible to the owner.
5. **Ledger as the owner reads it.** The two sub-contract entries are redacted, and the chain verifies
   end to end (`valid = true`).
6. **Proposal lanes under T-500.** Platform, email and invited, as the issuer sees them.
7. **Eight forbidden writes, all refused by the database:** self-decided change order, in-place edit of
   a signed BoQ line, rewriting progress, tampering with the ledger, a second live prime, an 11th level,
   self-verification, and closing another organisation's non-conformity.

**A design bug the checks caught.** The first roll-up summed every visible line, so Douro's
*Canalização* showed €17,400, which is revenue and cost added together. The rule is now explicit: a
viewer's roll-up is split by its **side** of each contract (supplier ⇒ revenue, client ⇒ cost), and
margin = revenue − cost. This is what [05 §8](./05-planning-and-execution.md) and V5 meant, now
made precise.

## Consequence for D-03

The gap is in the domain model, not the platform. This confirms **option A** in
[13](./13-gap-analysis.md): new module schemas and `/api/v2`, keep the platform pieces (ledger writer,
CI, migration checksums, Clerk, R2).
