# Slice B2 — Plan proposal → review → baseline v1: frozen data model, lifecycle, API contract

- **Status:** Frozen (build against this) — 2026-09-08
- **Author:** Full-Stack Architect (Technical Lead)
- **Issue:** LINA-200 (Slice B2) · **Parent:** LINA-196 · **Depends on:** LINA-199/B1
  (merged @ 64ee0fd) · **Blocks:** LINA-201/B3.
- **Anchors:** ADR-0012 §B (Slice B2), ADR-0002 (hash chain), ADR-0003/0006 §1
  (service isolation + append seam), ADR-0004 (permissions), ADR-0005 (schedule
  service).
- **Pen screens:** D11 (Proposed — awaiting the owner), D12 (Owner reviews —
  accept / request changes / reject), D12a (Request changes — edit the dates and
  the money), D13 (Accepted — baseline v1). `cowork/pen/linkNMS.pen`, Bootstrap
  Flow Board.

ADR-0012 set the *direction* for Slice B2 and explicitly left the
**baseline-versioning table shape** to be finalised in this issue. This doc
freezes the data model, the lifecycle state machine, the ledger events, and the
API contract so the delegated **BE** (LINA-200-BE) and **FE** (LINA-200-FE)
children build in parallel without schema churn. The architect owns the
migration and merges both.

## 0. Non-negotiables (from the pen and ADR-0012 §B)

- **A proposal you can't retract is a trap.** The GC can **withdraw** a proposal
  while it is still awaiting the owner. Withdraw is terminal for that version.
- **Disagreement stays inside the record.** The owner's three outcomes — accept,
  **request changes**, reject — are all recorded events. Request-changes does not
  edit the GC's proposal in place: it forks a new version the owner authors, and
  **the original stays visible underneath** (D12a).
- **Dual acceptance against a frozen version.** A plan becomes **baseline v1**
  only when *both* parties have stamped the *same* version — the proposer's
  authorship stamp and the reviewer's acceptance stamp, each attributed to an
  individual party and a server-authoritative time. On the second stamp the
  version **freezes**: from here nothing is edited — it is *changed*, and every
  later change (B3) is measured against this baseline.
- **Every transition is one stamped ledger event**, appended through the existing
  `ledger.append_event` seam (ADR-0002 hash chain). No transition is a silent
  projection write.
- **Freeze is DB-enforced, not just app-enforced** (ADR-0002 §4 defense in
  depth): once a version is frozen, its stages cannot be mutated by any code
  path — a trigger rejects the write.

## 1. Lifecycle state machine

A **plan version** is the unit that is proposed, reviewed, and (once dual-stamped)
frozen as a baseline. It groups the `schedule.stage` rows that make up one plan.

```
                         ┌──────────── withdraw (proposer) ─────────► withdrawn (terminal)
                         │
  (B1 import seeds v1) ──┴─► proposed ──── reject (reviewer) ────────► rejected  (terminal)
                                │
                                ├── accept (reviewer) ──► accepted / FROZEN = baseline vN
                                │
                                └── request-changes (reviewer, D12a)
                                         │  forks a new version the reviewer authors,
                                         │  original marked `superseded` (stays visible)
                                         ▼
                                    proposed  (roles swap: reviewer is now proposer)
```

States (`schedule.plan_version.status`):

| status | meaning | mutable stages? | terminal? |
|--------|---------|-----------------|-----------|
| `proposed`   | awaiting the counter-party's review (D11) | yes (only by the proposer, pre-review) | no |
| `withdrawn`  | proposer retracted before review closed | no | yes |
| `rejected`   | reviewer rejected (D12) | no | yes |
| `superseded` | forked by request-changes; kept visible underneath (D12a) | no | yes |
| `accepted`   | dual-stamped; **frozen**; is a baseline (D13) | no (DB-enforced) | yes |

**Who proposes to whom.** The proposer is the party who authored the version; the
reviewer is the *other* project party. B1's import seeds v1 authored by the GC
(counterparty) → awaiting the **owner**. A request-changes fork is authored by
the reviewer, so the roles swap and it awaits the original proposer. There is
**at most one non-terminal (`proposed`) version per project** at any time — the
state machine enforces a single open negotiation thread (see §3 guard).

## 2. Dual acceptance — the two stamps

"Dual acceptance" is two `plan_acceptance` rows against the **same** version:

1. **The proposer's stamp** (`kind = 'proposed'`) — written when the version is
   created (import-seed or request-changes fork). It is the authorship stamp:
   *this party put this plan forward, at this time.*
2. **The reviewer's stamp** (`kind = 'accepted'`) — written when the reviewer
   accepts (D12 accept). This is the second stamp; **it triggers the freeze.**

On the reviewer's accept, in one transaction: append `plan_accepted` → insert the
reviewer's `plan_acceptance` row → set `plan_version.status = 'accepted'`,
`frozen_at = now()` → append `baseline_frozen` → upsert
`schedule.project_baseline`. Both stamps now reference a version that can never
change, so the pair is provable forever.

Each party stamps a given version **at most once** (unique `(plan_version_id,
party_id)`). Reject and withdraw write their own ledger event but **no**
`plan_acceptance` row (they are not acceptances).

## 3. Schema — migration `services/schedule/migrations/0003_plan_versioning.sql`

Owned by the schedule service (`schedule_app`, USAGE on `schedule` only — no
cross-schema writes; ADR-0006). schedule_app already holds `EXECUTE` on
`ledger.append_event` (ledger/0007) — **no new ledger grant.** Forward-only.

```sql
-- ── schedule.plan_version — the proposal/version envelope ──────────────────
CREATE TABLE schedule.plan_version (
  id                    uuid PRIMARY KEY,
  project_id            uuid NOT NULL,
  -- Monotonic per project: v1, v2, … Assigned server-side inside the append txn
  -- under the same per-project serialization as the ledger (advisory lock).
  version_no            integer NOT NULL,
  status                text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed','withdrawn','rejected','superseded','accepted')),
  -- The B1 import batch that seeded this version (NULL for a request-changes fork
  -- and for any future hand-built version).
  source_import_id      uuid REFERENCES schedule.plan_import (id),
  -- Request-changes chain (D12a): the version this one forked from. NULL for v1.
  supersedes_version_id uuid REFERENCES schedule.plan_version (id),
  proposed_by_party_id  uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Set exactly when the version freezes (status → accepted). Immutable after.
  frozen_at             timestamptz,
  CONSTRAINT plan_version_project_no_uq UNIQUE (project_id, version_no),
  CONSTRAINT plan_version_frozen_iff_accepted
    CHECK ((status = 'accepted') = (frozen_at IS NOT NULL))
);

-- At most ONE open (proposed) version per project — a single negotiation thread.
CREATE UNIQUE INDEX plan_version_one_open_per_project
  ON schedule.plan_version (project_id) WHERE status = 'proposed';

-- ── schedule.stage: bind stages to their version ──────────────────────────
-- B1 created stages with import_id but no version. Add plan_version_id; the
-- migration backfills existing import-seeded stages into a v1 per project.
ALTER TABLE schedule.stage ADD COLUMN plan_version_id uuid REFERENCES schedule.plan_version (id);
CREATE INDEX stage_plan_version_idx ON schedule.stage (plan_version_id);

-- ── schedule.plan_acceptance — per-party stamps (append-only) ──────────────
CREATE TABLE schedule.plan_acceptance (
  id                uuid PRIMARY KEY,
  plan_version_id   uuid NOT NULL REFERENCES schedule.plan_version (id),
  project_id        uuid NOT NULL,
  party_id          uuid NOT NULL,
  -- 'proposed' = authorship stamp (proposer); 'accepted' = reviewer's stamp.
  kind              text NOT NULL CHECK (kind IN ('proposed','accepted')),
  stamped_at        timestamptz NOT NULL DEFAULT now(),
  audit_event_id    uuid NOT NULL,
  CONSTRAINT plan_acceptance_once UNIQUE (plan_version_id, party_id)
);
CREATE INDEX plan_acceptance_version_idx ON schedule.plan_acceptance (plan_version_id);

-- ── schedule.project_baseline — the frozen baseline pointer (schedule-owned) ─
-- The "frozen baseline reference on the project" (ADR-0012). Kept in the schedule
-- schema, NOT written into identity.project, so the schedule service never writes
-- another service's tables (ADR-0003/0006). identity/API read it via the schedule
-- API. One row per project; the pointer only ever advances (v1 today; a re-baseline
-- is a future, ledgered event, not an in-place overwrite).
CREATE TABLE schedule.project_baseline (
  project_id             uuid PRIMARY KEY,
  plan_version_id        uuid NOT NULL REFERENCES schedule.plan_version (id),
  version_no             integer NOT NULL,
  frozen_at              timestamptz NOT NULL DEFAULT now(),
  baseline_audit_event_id uuid NOT NULL
);

-- ── Freeze is DB-enforced (ADR-0002 §4) ────────────────────────────────────
-- A stage whose version is frozen (accepted) — or otherwise terminal — cannot be
-- inserted or updated. schedule.stage keeps its UPDATE grant (stages are mutable
-- WHILE proposed, edited by the proposer pre-review), so the immutability of a
-- baseline is guarded here rather than by removing the grant.
CREATE FUNCTION schedule.reject_frozen_stage_write() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schedule.plan_version v
     WHERE v.id = NEW.plan_version_id
       AND v.status IN ('accepted','superseded','withdrawn','rejected')
  ) THEN
    RAISE EXCEPTION 'stage % belongs to a frozen/terminal plan version — a baseline is changed, never edited', NEW.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stage_freeze_guard
  BEFORE INSERT OR UPDATE ON schedule.stage
  FOR EACH ROW EXECUTE FUNCTION schedule.reject_frozen_stage_write();

-- ── Least-privilege grants ─────────────────────────────────────────────────
-- plan_version: SELECT + INSERT + UPDATE (status transitions + frozen_at are the
--   only mutations, all mirrored by ledger events). No DELETE.
-- plan_acceptance, project_baseline: append-only projections — plan_acceptance is
--   SELECT+INSERT only; project_baseline is SELECT+INSERT+UPDATE (the pointer
--   advances on a re-baseline, never deletes).
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.plan_version     TO schedule_app;
GRANT SELECT, INSERT         ON TABLE schedule.plan_acceptance  TO schedule_app;
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.project_baseline TO schedule_app;
```

**Backfill.** B1 already shipped import-seeded stages with no version. The
migration creates one `plan_version` (v1, `status = 'proposed'`,
`source_import_id` = the stage's import) per distinct `(project_id, import_id)`
and sets `stage.plan_version_id`. Any project with an existing import gets a
resumable proposal — no orphan stages. Verify the backfill count in Neon before
merge (architect duty).

## 4. Ledger events (ADR-0002 hash chain)

New event types, each a single `ledger.append_event` in the SAME transaction as
its projection write. `payload_hash` is the shared canonical-JSON core; the BE
child adds each type to the ledger fold only where it must affect a projection
(none of these move the budget — B3 does).

| type | when | payload (canonical) |
|------|------|---------------------|
| `plan_proposed`         | version created (import-seed / fork) | `{ planVersionId, versionNo, sourceImportId, supersedesVersionId, stageCount }` |
| `plan_withdrawn`        | proposer withdraws (D11) | `{ planVersionId, versionNo }` |
| `plan_change_requested` | reviewer requests changes (D12a) | `{ fromVersionId, fromVersionNo, newVersionId, newVersionNo }` |
| `plan_rejected`         | reviewer rejects (D12) | `{ planVersionId, versionNo, reason? }` |
| `plan_accepted`         | a party's acceptance stamp (D12 accept / D13) | `{ planVersionId, versionNo, kind }` |
| `baseline_frozen`       | second stamp → freeze (D13) | `{ planVersionId, versionNo, proposedByPartyId, acceptedByPartyId }` |

`actor_party_id` and `occurred_at` are server-authoritative (session + server
clock), never from the body (ADR-0002 §5). `plan_change_requested` and the fork's
`plan_proposed` are two events in one transaction (the reviewer's request creates
the new version). `chain-verify` must stay green across all new types — the BE
child extends the ledger fixtures.

## 5. API contract (D11–D13) — build FE in parallel against this

All routes are project-scoped, live in the `schedule` service, and derive the
actor from the session (`ctx.actorPartyId`, ADR-0004) — never the body.

| # | Screen | Route | Body | Returns |
|---|--------|-------|------|---------|
| 1 | D11–D13 | `GET /api/v1/projects/{projectId}/plan` | — | `{ baseline: BaselineRef\|null, current: PlanVersionView\|null, history: PlanVersionSummary[] }` |
| 2 | D11 | `POST …/plan-versions/{versionId}:withdraw` | — | `{ status: 'withdrawn' }` |
| 3 | D12 | `POST …/plan-versions/{versionId}:accept` | — | `{ status, baseline?: BaselineRef }` |
| 4 | D12 | `POST …/plan-versions/{versionId}:reject` | `{ reason? }` | `{ status: 'rejected' }` |
| 5 | D12a | `POST …/plan-versions/{versionId}:request-changes` | `{ stages: StageEdit[] }` | `{ newVersionId, versionNo, status: 'proposed' }` |

`PlanVersionView` carries the version envelope + its WBS stage tree (reusing B1's
`WBSNode` shape) + `acceptances: [{ partyId, role, kind, stampedAt }]` so D11/D13
can render *who has stamped and who is awaited*. `BaselineRef` =
`{ planVersionId, versionNo, frozenAt }`. `StageEdit` is a narrow patch — **dates
and money only** (`{ stageId, plannedStartDate?, plannedEndDate?,
plannedCostCents? }`); D12a cannot restructure the WBS, only edit the dates and
the values, and the server forks a new version applying the patch (the original
version's stages are untouched → "original stays visible underneath").

`:accept` is **idempotent by state**: a party accepting a version it already
stamped returns the current state, writes nothing. If the accepting party is the
second stamp, the response includes the new `baseline`.

## 6. Permissions (ADR-0004)

Two new actions, project-scoped, authorized via the identity port:

- `PROPOSE_PLAN` / withdraw — the **proposer** party of the version (the GC for an
  import-seeded v1). `:withdraw` is allowed only by `proposed_by_party_id`.
- `REVIEW_PLAN` — the **reviewer** party (the *other* party): `:accept`,
  `:reject`, `:request-changes`. A party may not review its own proposal (the
  server rejects a reviewer action by `proposed_by_party_id` with 403).

Both derive the acting party from the session. The owner↔GC pairing comes from
`identity.membership`; the BE child resolves reviewer-vs-proposer from the version
row, not the request.

## 7. FE contract (D11–D13)

- **D11 Proposed — awaiting the owner.** Render `current` when
  `status = 'proposed'`: the WBS + mini-gantt (reuse the B1 preview components),
  a "who's awaited" banner from `acceptances`, and — for the proposer only — a
  **Withdraw** control (calls route 2). The reviewer sees Accept / Request changes
  / Reject (routes 3–5).
- **D12a Request changes.** An editable overlay of the current version limited to
  **dates and money** per stage; the original stays visible underneath (render the
  pre-edit version read-only behind the editor). Submit → route 5 → the new
  version becomes `current` and the old drops into `history` as `superseded`.
- **D13 Accepted — baseline v1.** When `baseline` is non-null, show the frozen
  banner with **both** stamps (individual + time from `acceptances`) and the
  version number. No edit affordances — the record is now changed, not edited
  (B3 owns the change surface).
- History strip lists `superseded/withdrawn/rejected` versions so the whole
  negotiation is visible (disagreement stays inside the record).

## 8. Open items (finalised in the child issues, not here)

- Exact file-size/edit validation numbers for `StageEdit` and any per-stage
  bounds (BE child; FE echoes).
- Whether `:request-changes` may also *add/remove* stages later — **v1 is
  dates-and-money only** (frozen above); structural edits are a deliberate B3+
  follow-up, noted not dropped.
- Re-baseline (a second accepted version after v1) is out of scope for B2; the
  `project_baseline` pointer and `baseline_frozen` event are shaped to allow it,
  but the flow is not built here.
- Budget-baseline reconciliation (does Σ frozen `planned_cost_cents` set the
  project's budget baseline?) belongs to **B3** (money movement), not B2. B2
  freezes the *plan*; B3 owns the *money*.

## 9. What this unblocks

Slice B3 (LINA-201) — the live record measures every change against the frozen
baseline this slice produces. B3 reads `schedule.project_baseline` and the frozen
`plan_version` as its zero point.
