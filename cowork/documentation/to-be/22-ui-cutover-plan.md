# 22 — UI cutover plan (v1 → v2) and v1 deprecation

**Status:** ACTIVE — both gates cleared (2026-09-27). Owned by the Full-Stack Architect for
LINA-309 ("Connect and deprecate"). This is the execution plan for AGENT-INDEX **phase 11**
(rebuild the UI on `/api/v2`) and **phase 12** (retire v1 routes and schemas). It does not
re-open any Accepted decision; it sequences the remaining work.

> **Gate status (2026-09-27).**
> - **Gate A — v2 viewer resolves local identity: DONE.** `viewerFromClerk()` now resolves
>   `personId`/`orgId`/`orgKind` from the Clerk mirror and fails closed on a missing row
>   (LINA-309 Gate A, PR #179, on `main`). §2 below is kept as the record.
> - **Gate B — production data strategy: DECIDED = B2 (FRESH START)** by the founder/CEO
>   (child LINA-310). v2 launches empty; existing v1 projects stay read-only behind v1 for a
>   transition window; all new work happens on v2. **No migration/importer work** (B1 is not
>   taken). The per-surface slice shapes are therefore finalised — see §3.
>
> **B2 consequence the slices must honour — the identity model INVERTS from party to org.**
> v1 was party-centric (`/projects` was membership-scoped to the acting *party*, no org needed).
> v2 is org-centric (doc 16): `listProjects` calls `requireActiveOrg(viewer)` and scopes to the
> viewer's active Clerk **org**, and `/me` returns the Clerk **org-role** vocabulary, not the v1
> build-role. So every read surface must handle **"signed in but no active org"** as a first-class
> empty/onboarding state (route to org creation or the empty portal), never a crash — a brand-new
> B2 user has no org and no projects on first load. This is the single largest shape change in the
> cutover and is called out in each affected slice below.
>
> **The shared v2 client seam now exists** — `app/src/lib/v2/client.ts` (LINA-309), the single
> place the UI talks to `/api/v2`, mirroring the two-transport design of `lib/api.ts` (in-process
> by default; HTTP when `LINKNMS_API_BASE` is set). It speaks problem+json (`V2Error`/
> `V2Unauthenticated`, discriminated on the stable `code`). Every slice below imports from it.

Sources: [AGENT-INDEX](./AGENT-INDEX.md) §5 phases 11–12, [13-gap-analysis](./13-gap-analysis.md)
("what carries over"), [20-url-structure](./20-url-structure.md), [16-access-model-clerk](./16-access-model-clerk.md).

---

## 1. Where we are (as-built, verified 2026-09-27)

- **v2 backend is registered and live** on `/api/v2` (LINA-308): identity, project, contracting,
  planning, quality, tendering, documents, collaboration, billing — all mounted in
  `app/src/server/v2/registry.ts` over the platform router.
- **The entire UI still runs on v1.** `app/src/lib/api.ts` calls the v1 service handlers
  **in-process** (`@services/gateway/container.mjs`), never `/api/v2`. 37 call sites across 17 files
  reference v1 (`app/src/lib/*.ts`, `app/src/server/gateway.ts`, plan/RFP/change-order surfaces).
- The v1 data model (`identity.party` keyed by **email**) and the v2 data model
  (`identity.person` keyed by **clerk_user_id**, populated by the Clerk webhook mirror) are
  **two different identity spaces in two different schemas**. View transforms in
  `app/src/lib/view.ts` are shaped for v1 wire objects.

## 2. The two gates (must clear before cutover)

### Gate A — v2 request viewer resolves local identity (KEYSTONE, technical)

`app/src/server/v2/viewer.ts::viewerFromClerk()` currently hard-codes `personId: null` and
`orgId: null` (see the inline "until the phase-1 mirror lands" note). The access rule is
`allow = permission ∧ relationship ∧ staffing ∧ entitlement`; with a null `personId`/`orgId`,
**every relationship- and staffing-scoped v2 read is blind to who is calling.** No UI surface can
be cut over until this resolves.

The capability already exists in the identity store — `getPersonByClerkId(clerkUserId)` and
`getOrgByClerkId(clerkOrgId)` (`modules/identity/infra/pg-store.mjs`). Wiring:

1. In `viewerFromClerk()`, after `auth()`, look up the local `person` by `session.userId`.
2. If `session.orgId` is set, look up the local `organization` by that Clerk org id → `orgId`, `orgKind`.
3. Pass the resolved `personId`/`orgId`/`orgKind` into `createViewerContext` (it already accepts them).
4. **Fail closed on a missing mirror row** (person not yet mirrored): resolve to a viewer whose
   `personId`/`orgId` stay null, so scoped handlers deny rather than leak. Do not auto-provision.

This is a no-regret change under any data strategy and is the first slice. Owner: architect / backend.
**Prerequisite for Gate A to be *observable* in prod:** the Clerk webhook mirror must actually be
populating `identity.person`/`identity.organization` — confirm `CLERK_WEBHOOK_SIGNING_SECRET` is set
and events have fired (LINA-129/166 lineage).

### Gate B — production data strategy (FOUNDER/CEO decision, moves scope + timeline)

> **DECIDED 2026-09-27 — B2 (FRESH START).** Founder decision (via CEO, LINA-310):
> v2 launches empty; existing v1 projects go **read-only/archived behind the v1 API** for a
> transition window; all new work happens on v2. **No importer, no ledger re-key, no day-one
> migration.** Rationale: fastest path to cutover (saves ~3–5 days vs B1); live data stays
> accessible for reference via v1. Consequence for phase 11: every S1–S7 slice targets the
> **empty-portal** UX (no migrated portfolio to render), and S1–S7 are now cleared to merge to
> `main` once each is validated on dev. The B1 migrate/importer work below is **not** being built.

v2's schemas hold seed data only. The existing production record (v1 projects, decisions, change
orders, the append-only ledger) lives entirely in the v1 schemas. Two options:

- **B1 — Migrate:** export the live v1 record (`services/gateway/export-live-record.mjs` exists as
  phase-12 prep) and write an **importer into the v2 schemas** (does not exist yet). Preserves every
  existing project and its audit trail. Larger effort; must preserve ledger hash-chain integrity and
  re-key `party`(email) → `person`(clerk_user_id).
- **B2 — Fresh start:** v2 launches empty; existing v1 projects are read-only/archived behind v1 for a
  window, new work happens on v2. Faster, but strands live builds unless the founder accepts it.

This is **not the architect's call to make unilaterally** — it moves scope and timeline and touches
the product promise (the audit trail). **Escalated to the CEO/founder as the gating decision for
LINA-309.** Nothing in phase 11's per-surface work should merge to `main` before B is decided,
because the target shapes and the "empty portal vs migrated portfolio" UX differ.

## 3. Per-surface slice plan (phase 11 — Gate A DONE, Gate B = B2 fresh start)

Shapes are now final (Gate B = B2): each slice renders the **empty-portal / new-work-on-v2** UX;
there is no migrated portfolio to display. A v1 project appears only via the archived read-only v1
surface, out of scope for these slices.

Each slice is a thin vertical: swap one surface's data-access from the v1 in-process call to a v2
client, adapt the view transform to the v2 wire shape, keep the screen's UX. Deliver
`feature → dev → main` (ADR-0022), one worktree per agent, delete branch + Neon on merge.

| Slice | Surface(s) | v2 tags | Notes |
|---|---|---|---|
| S1 | `/me` + portfolio home (`page.tsx`, `lib/profile.ts`) | Identity, Project | Smallest read; proves the v2 client path end-to-end |
| S2 | Project dashboard + record (`getProject`, `lib/record.ts`) | Project, Contracting, Record | **Partly shipped (LINA-353) — see §3.1.** Header/state + Schedule tab on v2; Plan/Money/History blocked on a v2 record backend that does not exist yet |
| S3 | Plan grid + Gantt (`PlanGrid.tsx`, `lib/plan-baseline.ts`, `lib/plan-authoring.ts`) | Planning, Realtime | Largest; new delta/link/segment shapes (doc 05) |
| S4 | Change orders (`RaiseChangeOrderForm.tsx`, `CoDecisionButtons.tsx`) | Contracting (change orders) | **Splits — see §3.2 (LINA-358).** DETAIL + DECIDE (list/read/gate) are blocked-by-S1-only and ready now; PROPOSE is **blocked-by-S2** (needs a signed contract + live BoQ to attach line ops to). Proposer-never-decides invariant (§6.1) |
| S5 | Tendering / RFP public form (`rfp/[token]/*`, `lib/rfp-proposal.ts`, `lib/procurement.ts`) | Tendering | Public-token lifecycle gap S1 in [21](./21-gap-review.md) must be closed first |
| S6 | Sign-off + phases (`SignOffPanel.tsx`) | Project (phases) | **Was blocked on a v2 backend that did not exist — see §3.3 (LINA-356, now DONE).** The "Project (phases), Collaboration" tag was aspirational: the LINA-308 pivot never carried phases/sign-off across. The enabling backend is now on `/api/v2` (phases + sign-off in **one** module, Project — ADR-0024); S6 is the FE cutover only |
| S7 | Task workspace (`lib/task-workspace.ts`) | Collaboration, Documents | R2 downloads gated by V6 |

**Build a shared v2 client first** (`app/src/lib/v2/client.ts`): the single place that talks to
`/api/v2` (or the in-process router), mirroring the two-transport design of today's `lib/api.ts`
(in-process default; HTTP when `LINKNMS_API_BASE` is set for E2E). Every slice imports from it.

### 3.1 S2 as-built + the v2 record-backend gap (LINA-353, 2026-09-27)

Cutting S2 surfaced a gap the table above assumed away: **the v1 record surface's four tabs do not
all have a v2 read to point at.** Verified against the live backend (`server/v2/registry.ts` + each
module's `http/register.mjs`):

| Record tab | v1 source | v2 read | Status |
|---|---|---|---|
| Header / state | `getRecord` | `GET /projects/{id}` (getProject) + schedule baseline | ✅ cut |
| Schedule | `getRecord.tabs.schedule` | `GET /projects/{id}/schedule` (getSchedule) — task `status` enum is identical to v1 `ProgressStatus` | ✅ cut |
| Plan (materials) | `getRecord.tabs.plan` + `getStageMaterials`/`materials:swap` | — none | ❌ **no v2 model** |
| Money (movements) | `getRecord.tabs.money` | — none | ❌ **no v2 model** |
| History (ledger) | `getRecord.tabs.history` | `GET /projects/{id}/record` (`listRecord`, tag `Record`) | ❌ **openapi-only, registered nowhere** |

The Slice-B3 materials/movements model (`materials:swap`, `MovementView`, `price_movement` vs
`scope_change`) was never ported to a v2 module; v2 contracting is a different model (contract tree,
change orders, measurements, payments). And `listRecord` — the "who changed what" audit-ledger
projection, the product's core promise — exists in `openapi.yaml` only.

**Decided S2 shape (B2-consistent, decision-neutral, reversible):** ship the two tabs that have a
real v2 read now (`lib/v2/record.ts` + `lib/v2/record-view.ts`, driving header/state + Schedule),
plus the first **v2 build-shell chrome** helper (`lib/v2/shell.ts`, reusing S1's `getViewerProfile`
+ `listPortfolio` — S1 cut only the standalone portfolio page, not the shared shell helper that
every build-scoped page wears, so S2 is the first page that needs it and S3–S7 adopt it). The
Plan/Money/History tabs render honest "arrives with the v2 record slice" panels — under B2 a fresh
v2 project genuinely has no materials, no movements and an empty ledger, so this is truthful, not a
stub. When the backend lands the panels light up with no change to the page's shape.

**Tracked backend follow-up (moves scope → CEO decision):** register + implement `listRecord` (the
v2 ledger projection) and decide the materials/money disposition on v2 — **port** the B3 model into
a v2 module, or **re-conceive** the live-record/money surface on v2's own contracting model (change
orders / measurements / variations). History/Plan/Money depend on that decision; the `record/[stageId]`
materials detail + `MoneyMovement.tsx` stay on v1 until it lands (they are unreachable from the v2
record page, which no longer links to them).

### 3.2 S4 as-designed — v1 free-cost change order → v2 line-item model (LINA-358, 2026-09-28)

Cutting S4 surfaces the same class of gap §3.1 found: the S4 row assumed the whole surface is
blocked-by-S1-only, but **the two halves of S4 have different dependencies and one of them cannot
be built yet.** The v1 change order and the v2 change order are not the same object — one is a
project-scoped narrative, the other is a contract-scoped ledger entry — so this is the design
ruling the wiring (LINA-321) waits on. Verified against the live backend
(`modules/contracting/application/use-cases.mjs::createChangeOrder`,
`modules/contracting/domain/money.mjs`, `modules/contracting/http/register.mjs`) and the merged v2
data layer (`app/src/lib/v2/change-orders.ts` + `change-orders-view.ts`, PR #188).

**What the two models actually carry:**

| Facet | v1 (`RaiseChangeOrderForm` → `ChangeOrderDetail`) | v2 (`createChangeOrder` → `ChangeOrder`) |
|---|---|---|
| Scope | **Project**-scoped narrative record | **Contract**-scoped ledger entry (`POST /contracts/{id}/change-orders`) |
| "What changed" | free-typed `title` | `kind` = `scope` \| `time` \| `scope_and_time` + a `reason` (the human line) |
| Cost | free-typed `costDeltaCents` (any amount, typed by hand) | **derived** — `amount_delta` = Σ `lineAmountCents(qty × unit_price)` over BoQ line ops; never typed |
| Scope body | `scopeImpactNote` (free text) | `lines[]` ops `add` \| `replace` \| `remove` against the contract's **live BoQ** (`add`/`replace` carry a client-minted `new_line` = code/description/unit/quantity/unit_price) |
| Schedule body | `scheduleImpactDays` + `scheduleImpactNote` | `time[]` ops (baseline start/finish) |
| Quality | `qualityFlag` + `qualityNote` | **no representation** |
| Who raised it | name + **build role** (raised by "{name} ({role})") | `Actor { org_id, person_id?, org_role? }` — no display name, no build role |
| Budget context | before → after pair on the CO body | **not on the CO** — `GET /contracts/{id}/financials` (value / approved_changes / measured / …) |
| Lifecycle | single `proposed → decided` | five states `draft → submitted → approved \| rejected \| withdrawn` |

**Ruling 1 — sequencing (Architect):** S4 splits.
- **DETAIL + DECIDE + LIST are ready now** (blocked-by-S1-only): the reads and the whole
  decision gate exist and are tested — `getChangeOrderDetail`, `submit`/`approve`/`reject`/`withdraw`
  (PR #188), the `two_sided_rule` surfacing, and the list endpoint `GET /projects/{id}/change-orders`
  (LINA-357). This half of LINA-321 can wire `CoDecisionButtons.tsx` + the detail/list pages
  against v2 immediately.
- **PROPOSE is blocked-by-S2**, not by S1. `createChangeOrder` requires a `contractId` in the path
  and BoQ line ops that reference **live `boq_item_id`s of a signed contract**. There is no way to
  raise a v2 CO without first selecting a contract and its BoQ — and that contract/BoQ surface is
  **S2 (Contracting)**, which has not shipped (§3.1). The doc-22 table's "S4 blocked-by-S1-only" was
  a gap; corrected in the S4 row above.

**Ruling 2 — mapping (Architect, ledger-integrity call):** the v1 free-cost `RaiseChangeOrderForm`
is **retired**, not adapted. The v2 propose surface is a **BoQ-line authoring form** (pick contract →
choose `kind` → add/replace/remove BoQ lines and/or time ops → the server sums `amount_delta`),
built together with S2's contract/BoQ surface. **No interim synthetic lump-sum line.** A single
hand-typed "lump-sum" line would mint a fake BoQ item (the op requires code/description/unit/
quantity/unit_price ≥ 0) that then becomes a *live* line every downstream measurement and payment
references — it corrupts the meaning of the ledger, which is the product's core promise. Because
PROPOSE is blocked on S2 regardless, there is no schedule pressure that a degraded interim would
relieve. Field mapping for the new form: v1 `title` + `scopeImpactNote` → `reason` + `lines[]`;
`scheduleImpactDays`/`Note` → `kind:time` + `time[]`; there is **no** v2 home for a
`qualityFlag`/`qualityNote` — a quality-only change with no cost and no schedule impact is not a
change *order* in v2 and belongs on the record as a comment/decision (**flag to Product**, below).

**Ruling 3 — detail rendering (Architect):** resolve from the authoritative source, do not invent.
- **Party name:** resolve `proposed_by.org_id` / `decided_by.org_id` → org display name via an
  identity read at render time; never put a name on the CO body. **Drop the v1 build-role line** —
  the v2 `Actor` carries `org_role` only, no build role.
- **Budget before → after:** **dropped** (it would be an invented pair). Replace it with the
  contract financials snapshot from `GET /contracts/{id}/financials` (contract value, approved
  changes, and this CO's `amount_delta`) — the honest running-total surface.
- **Status:** render the v2 five-state `status` directly, not the lossy legacy three-state chip
  (`toLegacyChipStatus` collapses draft+submitted and withdrawn, documented in
  `change-orders-view.ts`); `kind`, `lineCount`, `timeCount` render straight off the CO body.

**Flag to Product/CEO (scope, not blocking this ruling):** v2 change orders have no `quality` axis
and no free-cost path. If "raise a quality-only concern" or "log an ad-hoc cost that isn't a BoQ
line movement" must remain a first-class action, it needs its own v2 surface (a record
comment/decision, or a new event) — it is **not** a change order. Raised so the S4 propose UX is
scoped honestly; does not block LINA-321's DETAIL/DECIDE half.

**Net for LINA-321:** proceed now with the DETAIL/DECIDE/LIST wiring (Rulings 1 + 3). Hold the
PROPOSE half behind S2 and build it as the BoQ-line form (Ruling 2), not a port of the free-cost
form. Track PROPOSE as blocked-by-S2 rather than a separate estimate against S1.

### 3.3 S6 enabling backend — phases + sign-off ported to /api/v2 (LINA-356, 2026-09-28)

Same class of gap as §3.1/§3.2: the S6 row tagged the surface **"Project (phases), Collaboration"**
as if a v2 phase + sign-off backend already existed. It did not. The LINA-308 fresh-start pivot
(`db/v2`) never carried the surface across — as-built verification (2026-09-27): no `project_phase`
and no `phase_sign_off_request` in `db/v2/0001`, no module registered any `/phases` or `/sign-off`
route, and `openapi.yaml` v2 had neither path. The whole surface still lived in v1
(`services/schedule/phases.mjs` + migrations 0012/0013). **S6 was a FE cutover with nothing to point
the v2 client at**, so it was blocked on this enabling backend.

**Shipped (LINA-356):** the v1 `createPhaseService` contract re-implemented on `/api/v2`:
- **Schema** `db/v2/0008_project_phases_signoff.sql` (forward-only): `project.project_phase`
  (UNIQUE `(project_id,kind)` + `(project_id,sequence)`; the **one-way `signed_off` trigger** ported
  verbatim — the tamper-evident lock) and `project.phase_sign_off_request` (resolved in place;
  partial UNIQUE `WHERE status='pending'` → one pending per phase; `CHECK ((status='pending') =
  (resolved_at IS NULL))`).
- **Routes** on the Project module: `GET /projects/{id}/phases` (both participants read; lazy-seeds
  procurement=active + execution=pending on first read, each carrying `sign_off_requests[]`),
  `POST …/phases/{phaseId}/sign-off` (request; 409 `phase_not_active`/`no_plan_tasks`/
  `sign_off_already_pending`), `…/approve` (resolve + flip to `signed_off` in **one** transaction;
  403 `two_sided_rule` `cannot_self_approve`), `…/reject` (frees the pending slot).
- **Guard re-homed:** `assertPlanEditable` is now `store.isPlanLocked(projectId)` wired into every
  **structural** planning write (`createTask`/`updateTask`/`applySchedule`/`create|update|deleteLink`/
  `create|update|deleteCostLine`) — a signed-off execution phase returns `409 plan_locked`, and the
  edit routes through the change-order ledger (ADR-0014). Execution *reporting* is deliberately not
  gated.

**Decision — ADR-0024 (Architect, atomicity call):** phases **and** sign-off stay in **one** module
(**Project**), not split Project/Collaboration as the row loosely tagged. `approveSignOff` resolves
the request **and** flips the phase to `signed_off` in one transaction — "the decision and the lock
commit together" is the audit invariant; splitting across two module stores would break that
atomicity. Sign-off is a project-lifecycle concern → Project is its home; Collaboration keeps
comments/attachments only. The executable ADR-0024 record lives in the `db/v2/0008` header.

**Audit-trail decision (ADR-0024):** v1's phase-anchored `plan_change_log` was **not** ported. v2
already logs every plan-task field change to `planning.task_field_change` (append-only by DB trigger,
`db/v2/0001`) — richer than the v1 phase-anchored log — and `assertPlanEditable` stops those writes
at the lock, after which the change-order ledger takes over. No redundant phase-anchored log is added.

**Net for S6 (LINA-323):** the backend dependency is closed. S6 is now the FE cutover only — point
`getPhases` + `SignOffPanel` at a new `app/src/lib/v2/phases.ts` client seam (fail-closed empty on
no active org, per the S1 pattern).

## 4. Phase 12 — deprecate v1 (only after every surface is on v2)

1. Confirm no UI import path reaches `app/src/app/api/v1` or `@services/*` (grep gate in CI).
2. Archive the exported v1 ledger (per Gate B outcome).
3. Delete `app/src/app/api/v1/**`, `app/src/server/gateway.ts`, the v1 halves of `lib/*.ts`, and the
   `services/*` modules the UI no longer imports.
4. Drop the as-is schemas (forward migration; applied migrations stay immutable).
5. Done when `grep -r "/api/v1\|@services" app/src` is empty and the seed checks still pass.

## 5. Recommended sequencing

1. **Gate A** (keystone viewer resolution) — ✅ DONE, merged to main @ 8e27834 (PR #180). *(architect/backend)*
2. **Gate B** decision — ✅ DONE 2026-09-27, **B2 fresh start** (LINA-310). *(S1–S7 now cleared to merge)*
3. Shared v2 client — ✅ DONE, `app/src/lib/v2/client.ts` (LINA-309). **S1** proves the path
   end-to-end through it (architect-led / frontend).
4. **S2–S7** fan out in parallel worktrees once S1 lands — one worktree per agent, off `origin/main`,
   `feature → dev → main`, delete the branch on merge. *(frontend + backend devs)*
5. **Phase 12** cutover + v1 drop — architect owns the last mile, only after every surface is on v2.

Do not big-bang the whole UI in one PR. Ship thin slices; keep v1 serving until the last surface flips.
