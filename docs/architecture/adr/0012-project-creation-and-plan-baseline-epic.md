# ADR-0012 — Project Creation (D1–D6) completion and the Plan / Baseline epic (D7–D16)

- **Status:** Accepted (Part A contracts) / Proposed (Part B slice sequencing)
- **Date:** 2026-09-07
- **Deciders:** Full-Stack Architect (Technical Lead)
- **Context issue:** LINA-196 — Project Creation. Design source: `cowork/pen/linkNMS.pen`
  screens D1–D16 and `cowork/pen/linkNMS-flows.pen` "Bootstrap Flow Board".

## Context

LINA-196 asks that, after onboarding, a user in their org can **create or join a
project** — with the pen's D1–D16 screens as the design detail — and that the
front/back-end work is delegated to the developers with deliverables merged by
the architect.

A gap analysis of the codebase (2026-09-07) found the D1–D16 pen conflates **two
distinct product surfaces**:

1. **Create & join a build (D1–D6)** — the literal "Project Creation" flow. This
   is the Band B work shipped by ADR-0011 / LINA-179 and is **~90% built and
   wired end to end** (draft-first wizard → operating model → invite → accept &
   join, all on real Postgres via the `identity` service). Three small polish
   gaps remain (below).
2. **Plan import → proposal → baseline → live record (D7–D16)** — a separate,
   much larger surface: the GC uploads an Excel plan, maps its columns, previews
   a WBS + timeline, proposes it; the owner accepts / requests changes / rejects;
   an accepted plan freezes as **baseline v1**; the live record then tracks
   deviations down to **materials and price movement**. This half is **almost
   entirely greenfield** — no import, no plan proposal/baseline lifecycle, and no
   materials/price concept exists in schema, services, or UI. (The `schedule`
   service has a flat `stage`/`stage_progress` store but no hierarchy,
   dependencies, versioning, proposal state, or import.)

Treating D7–D16 as part of a "medium" Project-Creation ticket would silently
absorb a multi-slice, multi-week epic. This ADR therefore splits the work:
**Part A** finishes the create/join flow now; **Part B** decomposes D7–D16 into
sequenced, delegable slices and is escalated to the CEO for prioritisation
(timeline/scope change — architect escalation duty).

## Part A — Create & join (D1–D6): the three remaining gaps

The spine is done. What is missing to make "create or join a project" fully
performable for a **returning** user (today only the empty state and the deep
links work):

### A1. `GET /api/v1/projects` — the portfolio list (D1)

Today `app/src/app/page.tsx` renders `<EmptyPortal/>` unconditionally because
there is no "list my projects" endpoint — a returning owner can only reach a
build by its URL. This is the one genuinely missing **API contract** and the
architect owns it. Contract (frozen here so FE and BE build in parallel):

```
GET /api/v1/projects            (auth: any seated party; no body)
200 → { projects: ProjectSummary[] }   // ordered most-recent-first
```

`ProjectSummary` (a projection, not the full `getProject` payload):

```jsonc
{
  "id": "uuid",
  "name": "string",
  "status": "draft | active",
  "role": "owner | counterparty",     // the ACTING party's role on this build
  "operatingModel": "turnkey | direct | hybrid | null",
  "baselineBudgetCents": 25000000,
  "currentBudgetCents": 25000000,     // baseline + Σ approved COs (from ledger)
  "members": [ { "role": "owner|counterparty", "name": "string" } ],
  "counts": { "changeOrders": 0, "decisions": 0 },  // cheap counts for the card
  "updatedAt": "ISO-8601"
}
```

Rules:
- **Membership-scoped.** Returns exactly the builds where the acting party is a
  member (owner or counterparty) — never all org projects. The acting party comes
  from the session (`ctx.actorPartyId`), never a query param.
- **Draft builds are included** and badged `draft`, so an abandoned wizard is
  resumable from the portfolio (consistent with ADR-0011 draft-first).
- Backed by a new `store.listProjectsForParty(partyId)` on
  `services/identity/pg-store.mjs` joining `identity.membership` → `project`;
  budget/counts are read the same way `getProject` already does. Keep it to **one
  round of queries** (batch the per-project rollups), not N+1 per card.
- Read-only; **no new ledger event** (listing is not a recorded decision).

### A2. Wire `previewInvitation` into the invite landing (D6)

`GET /api/v1/invitations/[token]` (`identity.previewInvitation`) already exists
and returns the build name / owner / role, but
`app/src/app/invitations/[token]/accept/page.tsx` never calls it (its comment is
stale — it predates the endpoint). D6 must show **what you are joining** (build
name, owner, role) before "Accept & join". No backend change; wire the existing
preview and render it. Decline routes back to `/` (no server state for V1;
declining is simply not accepting — matches ADR-0011 OQ-1 deferral of
resend/cancel).

### A3. Fix the `maple-street` demo hardcode (bug)

`app/src/app/change-orders/[id]/page.tsx` still calls `getProject('maple-street')`
and links to `/projects/maple-street/...` — a leftover demo id that 404s / shows
the wrong project. It must resolve the change order's real `projectId`.

**Out of scope for Part A (deferred, consistent with ADR-0011 OQ-1):** invite
resend/cancel controls (D5) and a nav rail on D1. Stated, not silently dropped.

## Part B — Plan / Baseline / Materials (D7–D16): slice sequencing

Greenfield. Decomposed into three vertical slices, each a delegated BE+FE pair,
strictly sequenced (each depends on the prior slice's data model). Data-model
direction is set here so the slices don't churn schema; the owning issue for each
slice finalises the migration.

- **Slice B1 — Plan import (D7–D10).** GC-only. Server-side `.xlsx` parse (choose
  a parser: `exceljs` or `xlsx`; parse in the `schedule` service, never trust the
  client), explicit **sheet selection** (multi-sheet is the norm — no guessing),
  explicit **column mapping** (Action / Sub-action / Start / End / Trade /
  Dependency — nothing inferred), a **preview** of the parsed WBS + mini-gantt,
  and **Confirm = one stamped ledger event** (not N silent inserts). Schema:
  extend `schedule.stage` with `parent_id` (WBS hierarchy) and a `dependency`
  reference; add a `plan_import` event to the ledger. **Blocks B2, B3.**
- **Slice B2 — Proposal → review → baseline v1 (D11–D13).** Plan **versioning** +
  a `proposed | accepted | withdrawn` lifecycle; GC **withdraw**; owner
  **accept / request-changes (D12a) / reject**; **dual stamped acceptance** (each
  party's acceptance stamped by individual + time against a **frozen** version).
  This is the product's core promise (the auditable baseline) — every later change
  is measured against it, so it inherits ADR-0002's hash-chain discipline.
  Depends on B1. **Blocks B3.**
- **Slice B3 — Live record + materials + budget movement (D14–D16).** Plan /
  Schedule / Money / History tabs on the record; **line detail with materials**
  (quantity, unit price, labour); a **budget-materials movement** view where each
  movement is dated, sourced, and attributable (an index rise ≠ a scope change —
  the screen must not blur them). New **materials** data model; a swap that moves
  contract value opens a change order (reuses the existing change_order service).
  Depends on B2. Largest slice.

Each slice ships thin and vertical, is reviewed and merged by the architect, and
is QA-verified before the next starts. B3's materials model is the biggest new
domain and may itself split further when B2 lands.

## Consequences

- The create/join flow (the issue's literal title) becomes fully usable for
  returning users after Part A (two small delegated PRs). LINA-196 stays the
  tracking parent, blocked by its Part A children, and — per the escalation — by
  the Part B slice epics once the CEO confirms sequencing.
- D7–D16 is honestly surfaced as a multi-slice epic, not smuggled in. The one
  frozen contract other work builds against (`GET /projects`) is settled here.
- Tech debt / open questions carried forward: Excel parser choice (B1),
  baseline-versioning table shape (B2), and the materials schema (B3) are each
  finalised in their slice's issue, anchored to this ADR.
