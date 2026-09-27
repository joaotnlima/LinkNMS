# 22 — UI cutover plan (v1 → v2) and v1 deprecation

**Status:** proposed by the Full-Stack Architect for LINA-309 ("Connect and deprecate").
This is the execution plan for AGENT-INDEX **phase 11** (rebuild the UI on `/api/v2`) and
**phase 12** (retire v1 routes and schemas). It does not re-open any Accepted decision; it
sequences the remaining work and names the two gates that must clear before a responsible cutover.

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
| S2 | Project dashboard + record (`getProject`, `lib/record.ts`) | Project, Contracting, Record | Pillars/counts re-derived from v2 reads |
| S3 | Plan grid + Gantt (`PlanGrid.tsx`, `lib/plan-baseline.ts`, `lib/plan-authoring.ts`) | Planning, Realtime | Largest; new delta/link/segment shapes (doc 05) |
| S4 | Change orders (`RaiseChangeOrderForm.tsx`, `CoDecisionButtons.tsx`) | Contracting (change orders) | Proposer-never-decides invariant (§6.1) |
| S5 | Tendering / RFP public form (`rfp/[token]/*`, `lib/rfp-proposal.ts`, `lib/procurement.ts`) | Tendering | Public-token lifecycle gap S1 in [21](./21-gap-review.md) must be closed first |
| S6 | Sign-off + phases (`SignOffPanel.tsx`) | Project (phases), Collaboration | |
| S7 | Task workspace (`lib/task-workspace.ts`) | Collaboration, Documents | R2 downloads gated by V6 |

**Build a shared v2 client first** (`app/src/lib/v2/client.ts`): the single place that talks to
`/api/v2` (or the in-process router), mirroring the two-transport design of today's `lib/api.ts`
(in-process default; HTTP when `LINKNMS_API_BASE` is set for E2E). Every slice imports from it.

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
3. Shared v2 client + **S1** — architect leads, proves the path.
4. **S2–S7** fan out in parallel worktrees once S1 lands. *(frontend + backend devs)*
5. **Phase 12** cutover + v1 drop — architect owns the last mile.

Do not big-bang the whole UI in one PR. Ship thin slices; keep v1 serving until the last surface flips.
