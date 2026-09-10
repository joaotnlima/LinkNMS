# ADR-0017 — Direct plan authoring ("Build the plan here")

- Status: Accepted
- Date: 2026-09-10
- Deciders: Full-Stack Architect (owner), Chief of Staff (informed)
- Issue: LINA-228 "Build plan directly on LinkNMS"
- Anchors: ADR-0012 §B (plan baseline epic), ADR-0002 §4/§5 (tamper-evidence),
  ADR-0004 (permission model), ADR-0006 §1 (schema isolation / ledger seam),
  slice-b1-plan-import-contract.md, slice-b2-plan-baseline-contract.md

## Context

`/projects/:id/plan` offers two routes in (pen D7). Route 1 — **import a
spreadsheet** — has shipped (Slices B1/B2): a GC uploads an `.xlsx`, maps
columns, confirms, and the plan lands as a **proposed v1** the other party
reviews and accepts into a frozen baseline. Route 2 — **build it here** — was
drawn as "Not built yet".

LINA-228 builds Route 2. The pen frame *Build the plan — schedule (Gantt)* and
the *Interaction spec — Create & organise tasks* describe an ambitious planner:
an inline Gantt with draggable bars, auto-schedule, a task-detail drawer,
dependencies, per-task owners/specialties, milestones, and comments.

The issue narrows that deliberately. Quoting the issue:

> the skeleton of the plan should already be given … The idea is that it won't be
> assigned, have dates or anyone assigned or any sub task — that is for the user
> to fill.

So the shippable slice is: **seed a standard construction-plan skeleton** (phases
and their tasks, names only — no dates, no owner, no sub-tasks), let the author
edit it, and commit it as a proposal. That maps exactly onto the model we already
have — the two-level WBS (`schedule.stage` with `parent_id`) and the
proposal → review → baseline lifecycle (`schedule.plan_version`).

## Decision

### 1. Authoring produces a proposed v1 — one write, mirroring import

Direct authoring creates a plan the same way an import does: a single
transaction that writes one `plan_proposed` ledger event, a `plan_version`
(v1, `status='proposed'`, `source_import_id = NULL`, `supersedes_version_id =
NULL`), the author's `'proposed'` authorship stamp, and the WBS `stage` rows
(parents before children). It then flows through the **existing** D11–D13
surface (`PlanBaseline`): the other party reviews, requests changes, rejects, or
accepts it into a frozen baseline. Nothing downstream of the write is new.

New endpoint: `POST /projects/:projectId/plan-versions:author`, JSON body
`{ stages: AuthoredNode[] }`. See the companion contract
`docs/architecture/slice-direct-plan-authoring-contract.md`.

**Why a v1 proposal and not a stored "draft".** The pen shows a *"Draft · not
committed"* badge and a *Cancel*. We honour that **client-side**: the editor
holds the unsaved draft in the browser, and committing turns it into the
proposal. The server only ever sees a committed proposal. This avoids a new
`draft` plan-version status, a second freeze-guard carve-out, and a per-keystroke
write path — none of which the issue needs. The cost is that an abandoned draft
is lost; the skeleton re-seeds on reload, so the loss is edits over the seed, not
the seed. Server-persisted drafts are a documented follow-up.

### 2. No new migration

The schema from migrations 0002 (`parent_id`, WBS) and 0003 (`plan_version`,
`plan_acceptance`, the `plan_version_one_open_per_project` partial unique index,
the `stage_freeze_guard` trigger) already supports everything. Authoring adds no
column and no table. Given the repo is a single shared git tree where concurrent
agents collide on migration numbers (a recorded hazard), shipping this slice
**migration-free** is a deliberate advantage.

**Double-submit / idempotency.** Import keys idempotency on its `plan_import`
header. Authoring has no such header, and adding one would be a migration. Instead
we lean on the invariant we already enforce: **at most one open proposal per
project** (`plan_version_one_open_per_project`). An author call checks for an open
version and returns `409 open_plan_exists`; a racing double-insert trips the unique
index and is mapped to the same `409`. A legitimate retry therefore does not
double-write — it 409s, and the client re-reads the plan and finds the proposal it
created. This is weaker than import's replay-returns-the-original idempotency, and
we accept it: the worst case is a retry sees a 409 instead of a 201, never two
plans.

### 3. Authorisation: `PROPOSE_PLAN`, open to both parties

Import is GC-only (`IMPORT_PLAN` ∈ counterparty). Direct authoring uses
`PROPOSE_PLAN`, which the capability table (ADR-0004) already grants to **both**
`owner` and `counterparty`. This is intentional and consistent:

- The review flow is two-sided and self-protecting: `REVIEW_PLAN` denies the
  proposer, so whoever authors, the *other* party accepts. A baseline still
  requires both stamps.
- The pen's own D7 imagined an *"owner drafted one for you"* route. Letting either
  party author a v1 from the generic skeleton realises that intent without
  widening anything the authz table did not already allow.

If the product later wants authoring restricted to the GC, that is a one-line
capability change, not a schema change. Noted as an explicit reversible decision.

### 4. Authoring is the first route into a fresh build

Once a build exists and has no plan, building the plan is the primary next step.
The live Route 2 makes `/projects/:id/plan` actionable from empty, and the
build-overview surfaces it as the lead call to action. We do not force a redirect
into the editor from the creation wizard: a build may be owner-created (the owner
invites the GC, who may prefer to import), so the plan surface — which presents
*both* routes — is the correct landing, not the editor specifically.

### 5. Honest departures from the pen (deferred, not dropped)

The following pen affordances are **out of scope** for LINA-228 and are not
mocked as dead controls. They are deferred follow-ups because either the issue
excludes them or the data model does not back them:

| Pen affordance | Why deferred |
| --- | --- |
| Drag bars to schedule / drag edges to resize | Dates are set via fields in this slice; Gantt drag is a later enhancement. |
| Auto-schedule | No scheduling engine; no dependency graph to schedule against. |
| Task-detail drawer, description, comments | No per-stage description/comment store; comments belong on the decision/record surfaces. |
| Dependencies ("depends on") UI | `stage_dependency` exists but only import populates it; no authoring UI yet. |
| Per-task owner / assignee avatars | No per-stage assignee column; the issue explicitly excludes assignment. |
| Specialty/trade tags | `stage.trade` exists (free-form); authoring leaves it optional/unsurfaced in v1 to match "unassigned". |
| Milestone / Bug task types, third-level sub-tasks | Model is two-level (action/sub-action); the issue excludes seeded sub-tasks. |
| Paste Confluence/Loom link or drop image to generate | No extraction pipeline. |

The editor ships with **add / rename / reorder / remove** of phases and tasks and
**optional date entry**, which is the full issue scope. Reordering is by explicit
move controls, not drag-and-drop, in this slice.

## Consequences

- A plan can now be created without a spreadsheet. Route 2 is live.
- The proposal/baseline machinery is reused verbatim; the write path is a sibling
  of `plan-import` `:confirm`, keeping the tamper-evidence discipline identical
  (one ledger event per write, in the same transaction as the projection).
- No migration, no new status, no new grant. The slice is additive and reversible.
- Follow-ups (server-persisted drafts, Gantt drag, dependencies UI, assignment)
  are tracked separately and gated on real product demand.

---

## Annex (LINA-230, 2026-09-10) — authoring is private drafting; proposal is a second act

**This annex supersedes §1's "a v1 proposal and not a stored draft" decision and
§2's "no new migration", and amends §3.** Everything else in ADR-0017 stands.

### Why

Founder feedback on LINA-228:

> "Once I set the plan — I am NOT already sending him to approval… I'm only saving
> the work done."

The original decision (§1) committed authoring straight to a **proposed v1**, so
clicking "Create plan" immediately exposed the plan to the other party for review.
That conflated two distinct acts. The founder wants authoring to be **private
drafting** — save my work, keep editing — with **proposing** ("Send for approval")
a separate, deliberate act. A server-persisted draft (explicitly deferred in §1)
is now required, not optional.

### The model — a `draft` status before `proposed` (migration 0005)

A plan-version now has a `draft` status that precedes `proposed`:

- **`:author` writes a `draft`**, emitting `plan_drafted` (NOT `plan_proposed`).
  The draft is invisible to the other party — `getPlan` surfaces it to its author
  only, never in history. `frozen_at` stays null; no `REVIEW_PLAN` exposure.
- **`POST …/plan-versions/:id:propose`** — the "Send for approval" button — flips
  `draft → proposed` in one transaction: `plan_proposed` event, status flip, and
  the author's authorship stamp. Authorised by `PROPOSE_PLAN`; actor must be the
  drafter (same row-is-authority rule as `:withdraw`).
- The two-event trail is therefore `plan_drafted` (per save) **then**, later,
  `plan_proposed` — distinct, ordered, both attributable.

### Three calls the issue left to the Architect

1. **No `drafted` plan_acceptance stamp** (the issue suggested one). `plan_acceptance`
   is append-only (INSERT+SELECT, no UPDATE grant) with `UNIQUE(plan_version_id,
   party_id)`, and the freeze pairing needs the drafter's **`proposed`** stamp. A
   `drafted` stamp would occupy that unique slot and could only become `proposed`
   by mutating an append-only row — a trust regression. So draft authorship is
   recorded by the `plan_drafted` ledger event (actor) + the version's
   `proposed_by_party_id`; the single `proposed` stamp is written at `:propose`,
   pairing with the reviewer's accept to freeze. **Freeze logic is unchanged.**

2. **`version_no` is assigned at `:propose`, NULL while `draft`** — invariant
   `(status='draft') = (version_no IS NULL)`. Proposed plans stay numbered v1,
   v2… with no gaps burned by drafting or re-saving, and a draft is unambiguous.

3. **`:author` upserts the single draft in place** (one draft per project, partial
   unique index `WHERE status='draft'`). Re-saving replaces the draft's stages via
   a **scoped, trigger-guarded DELETE** on `schedule.stage`: migration 0005 grants
   DELETE and adds `stage_freeze_delete_guard`, which mirrors `stage_freeze_guard`
   — a frozen/terminal version's stages can **never** be deleted; a draft's (never
   proposed, never on the shared record) may. This keeps one clean draft row (no
   phantom superseded/orphan versions) while the audit guarantee — immutability of
   proposed/accepted versions and the ledger — is untouched.

### Authorisation (amends §3)

`:propose` is the drafter's own act: `PROPOSE_PLAN` + `actor == proposed_by_party_id`.
The reviewer still cannot propose someone else's draft (403), and `REVIEW_PLAN`
still denies the proposer once proposed — the two-sided baseline rule is intact.

### Scope note

Two parties racing to start a draft on the same build is out of scope: a second
party's `:author` while a draft exists returns `409 draft_exists`. The realistic
flow is a single author per build; multi-author drafting is deferred.
