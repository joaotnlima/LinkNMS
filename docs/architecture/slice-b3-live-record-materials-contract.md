# Slice B3 — Live record + materials + budget movement: frozen data model, ledger events, API & FE contract

- **Status:** Frozen (build against this) — 2026-09-09
- **Author:** Full-Stack Architect (Technical Lead)
- **Issue:** LINA-201 (Slice B3) · **Parent:** LINA-196 · **Depends on:** LINA-200/B2
  (baseline v1; merged @ b3dce66 / 3076e65) · **Largest slice.**
- **Anchors:** ADR-0014 (materials & price-movement money flow — the *why*),
  ADR-0012 §B (Slice B3), ADR-0002 (hash chain), ADR-0003/0006 §1 (service
  isolation + append seam), ADR-0004 (permissions), ADR-0005 (schedule service),
  `slice-b2-plan-baseline-contract.md` (the frozen baseline this measures against).
- **Pen screens:** D14 (the record, live), D15 (line detail — materials behind
  the price), D16 (budget — materials & price movement). `cowork/pen/linkNMS.pen`,
  Bootstrap Flow Board.

ADR-0014 fixes the *direction and the invariants*. This doc freezes the schema,
the ledger events, the API contract, the permissions, and the FE contract so the
delegated **BE** (LINA-201-BE) and **FE** (LINA-201-FE) children build in
parallel without schema churn. The architect owns the migration and merges both.

## 0. Non-negotiables (from ADR-0014, the pen, and the earlier slices)

- **The budget total moves through change orders and nothing else.** B3 adds no
  new writer of `ledger.budget_event`. A material change that moves contract
  value is a `change_order` (reused verbatim). (ADR-0014 §2.)
- **Two movement kinds, separated by a DB CHECK.** `scope_change` (→ a change
  order; moves the budget) vs `price_movement` (recorded, sourced, attributable;
  does **not** move the contract total). The screen cannot blur them because the
  database will not let a `price_movement` carry a CO nor a `scope_change` omit
  one. (ADR-0014 §3.)
- **Materials are plan-version state, frozen with the baseline.** Editable only
  while the version is `proposed`; immutable once frozen — the B2 freeze
  discipline extended to materials. (ADR-0014 §1.)
- **Every movement is one stamped ledger event** through `ledger.append_event`
  (ADR-0002 hash chain); actor + time are server-authoritative, never from the
  body (ADR-0002 §5). `chain-verify` stays green across the new types.
- **Line states and the schedule status stay derived**, never a mutable column
  (ADR-0005). (ADR-0014 §4.)

## 1. Schema — migration `services/schedule/migrations/0004_materials_and_movement.sql`

Owned by the schedule service (`schedule_app`, USAGE on `schedule` only — no
cross-schema writes; ADR-0006). `schedule_app` already holds `EXECUTE` on
`ledger.append_event` (ledger/0007) — **no new ledger grant.** Forward-only,
applied by the migrator role. Money is integer cents; quantities are
`numeric(14,3)` (fractional units — m², hours — are real in construction).

```sql
-- ── schedule.line_material — the materials/labour behind a plan line ──────────
-- Hangs off a schedule.stage (a plan LINE) and belongs to that stage's
-- plan_version, so it freezes with the baseline (B2 discipline). `kind` splits
-- material vs labour (pen D15 lists both); labour is a line with unit = 'hr'.
-- extended value of a line = quantity * unit_price_cents (bigint cents).
CREATE TABLE schedule.line_material (
  id                uuid PRIMARY KEY,
  stage_id          uuid NOT NULL REFERENCES schedule.stage (id),
  project_id        uuid NOT NULL,
  plan_version_id   uuid NOT NULL REFERENCES schedule.plan_version (id),
  kind              text NOT NULL DEFAULT 'material'
                      CHECK (kind IN ('material','labour')),
  name              text NOT NULL,
  unit              text NOT NULL,                 -- 'm2', 'each', 'hr', …
  quantity          numeric(14,3) NOT NULL CHECK (quantity >= 0),
  unit_price_cents  bigint NOT NULL CHECK (unit_price_cents >= 0),
  position          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX line_material_stage_idx   ON schedule.line_material (stage_id, position);
CREATE INDEX line_material_version_idx ON schedule.line_material (plan_version_id);

-- ── schedule.material_movement — the attributable movement ledger (D16) ───────
-- One row per post-baseline movement. Append-only projection (SELECT + INSERT
-- only; no UPDATE/DELETE grant): a movement is never edited, only superseded by
-- another movement. `value_delta_cents` = new extended value − prior extended
-- value (signed; a credit is negative). Each row mirrors ONE ledger event
-- (audit_event_id NOT NULL) appended in the SAME transaction.
CREATE TABLE schedule.material_movement (
  id                   uuid PRIMARY KEY,
  seq                  bigint GENERATED ALWAYS AS IDENTITY,
  project_id           uuid NOT NULL,
  line_material_id     uuid NOT NULL REFERENCES schedule.line_material (id),
  stage_id             uuid NOT NULL REFERENCES schedule.stage (id),
  movement_kind        text NOT NULL
                         CHECK (movement_kind IN ('scope_change','price_movement')),
  -- price_movement only: WHY the unit price moved. NULL for a scope_change.
  price_cause          text
                         CHECK (price_cause IN ('index','supplier_quote','correction')),
  -- The resulting current state after the movement (what the line now reads).
  new_quantity         numeric(14,3) CHECK (new_quantity IS NULL OR new_quantity >= 0),
  new_unit_price_cents bigint        CHECK (new_unit_price_cents IS NULL OR new_unit_price_cents >= 0),
  value_delta_cents    bigint NOT NULL,
  -- Provenance (the D16 promise: dated, sourced, attributable).
  source               text,                 -- 'ACME steel index 2026-09', 'quote #4471'
  -- A scope_change realises its money through a change order (cross-schema by
  -- interface, ADR-0006 §1 — NOT a hard FK across the split-DB seam).
  change_order_id      uuid,
  moved_by_party_id    uuid NOT NULL,
  occurred_at          timestamptz NOT NULL,  -- server-authoritative (ADR-0002 §5)
  audit_event_id       uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- THE load-bearing distinction (ADR-0014 §3): a scope_change MUST carry a CO
  -- and no price_cause; a price_movement MUST carry a price_cause and no CO. The
  -- screen cannot blur an index rise into a scope change because the DB will not.
  CONSTRAINT material_movement_kind_shape CHECK (
    (movement_kind = 'scope_change'
       AND change_order_id IS NOT NULL AND price_cause IS NULL)
    OR
    (movement_kind = 'price_movement'
       AND change_order_id IS NULL AND price_cause IS NOT NULL)
  )
);
CREATE INDEX material_movement_project_idx  ON schedule.material_movement (project_id, occurred_at, seq);
CREATE INDEX material_movement_line_idx     ON schedule.material_movement (line_material_id, occurred_at, seq);
CREATE INDEX material_movement_co_idx       ON schedule.material_movement (change_order_id)
  WHERE change_order_id IS NOT NULL;

-- ── Freeze is DB-enforced, extended to materials (ADR-0002 §4, ADR-0014 §1) ───
-- A line_material bound to a frozen/terminal plan version cannot be inserted or
-- updated — mirrors B2's stage_freeze_guard. Materials are authored WHILE the
-- version is 'proposed', then immutable. (Movements are how a frozen line
-- changes; they carry their own append-only trust, above.)
CREATE FUNCTION schedule.reject_frozen_material_write() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schedule.plan_version v
     WHERE v.id = NEW.plan_version_id
       AND v.status IN ('accepted','superseded','withdrawn','rejected')
  ) THEN
    RAISE EXCEPTION 'line_material % belongs to a frozen/terminal plan version — a baseline material is moved, never edited', NEW.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER line_material_freeze_guard
  BEFORE INSERT OR UPDATE ON schedule.line_material
  FOR EACH ROW EXECUTE FUNCTION schedule.reject_frozen_material_write();

-- ── Least-privilege grants ───────────────────────────────────────────────────
-- line_material: SELECT + INSERT + UPDATE (authored + edited WHILE proposed; the
--   freeze trigger stops writes once frozen). No DELETE.
-- material_movement: append-only projection — SELECT + INSERT only. No UPDATE/DELETE.
GRANT SELECT, INSERT, UPDATE ON TABLE schedule.line_material    TO schedule_app;
GRANT SELECT, INSERT         ON TABLE schedule.material_movement TO schedule_app;
```

**No backfill.** No prod plan version carries materials today, so there is
nothing to migrate; the tables start empty. (Verify in Neon that
`schedule.line_material` / `schedule.material_movement` are created and empty
after apply — architect duty.)

## 2. Ledger events (ADR-0002 hash chain)

New event type(s), each a single `ledger.append_event` in the SAME transaction as
its projection write. `payload_hash` is the shared canonical-JSON core; the BE
child extends the ledger fold + `chain-verify` fixtures so the chain stays green.
**None of these move the budget** — the budget still moves only through the
change-order path's existing `budget_moved` / `budget_event` (unchanged).

| type | when | payload (canonical) |
|------|------|---------------------|
| `material_movement_recorded` | a movement is recorded (scope or price) | `{ movementId, lineMaterialId, stageId, movementKind, priceCause, newQuantity, newUnitPriceCents, valueDeltaCents, changeOrderId, source }` |

For a `scope_change`, the linked change order goes through the **existing**
`change_order` service, which appends its own `change_order_proposed` /
`change_order_approved` and moves the budget via `budget_event` — B3 does **not**
re-implement any of that. The `material_movement_recorded` event references the
CO by id (`changeOrderId`); it does not duplicate the money move.

`actor_party_id` and `occurred_at` are server-authoritative (session + server
clock), never from the body (ADR-0002 §5).

## 3. API contract — build FE in parallel against this

All routes are project-scoped, live in the `schedule` service, and derive the
actor from the session (`ctx.actorPartyId`, ADR-0004) — never the body.

### 3a. The live record (D14)

| # | Screen | Route | Returns |
|---|--------|-------|---------|
| 1 | D14 | `GET /api/v1/projects/{projectId}/record` | `{ state, baseline, tabs: { plan, schedule, money, history } }` |

`RecordView` shape (a projection over baseline plan + materials + movements +
budget + audit read):

```jsonc
{
  "state": "accepted | deviation | closed_and_verified",  // whole-record rollup of line states
  "baseline": { "planVersionId": "uuid", "versionNo": 1, "frozenAt": "ISO-8601" } , // null if no baseline yet
  "tabs": {
    "plan":     { "lines": RecordLine[] },      // baseline WBS + materials + line state
    "schedule": { "lines": ScheduleLine[] },    // planned vs executed dates/status (stage_progress)
    "money":    MoneyView,                       // see 3c (the D16 breakdown, embedded)
    "history":  { "events": AuditEvent[] }       // the project's hash-chained ledger, read-only
  }
}
```

`RecordLine` = `{ stageId, name, trade, position, state, plannedCostCents,
currentValueCents, materials: LineMaterial[], compare: { plannedCostCents,
currentValueCents } }`. `state` is derived per ADR-0014 §4. `compare` is always
present (Compare stays available on a closed line).

### 3b. Line detail — materials behind the price (D15)

| # | Screen | Route | Body | Returns |
|---|--------|-------|------|---------|
| 2 | D15 | `GET …/stages/{stageId}/materials` | — | `{ lineMaterials: LineMaterial[], movements: MovementView[] }` |
| 3 | D15 (authoring, proposed only) | `POST …/stages/{stageId}/materials` | `{ materials: MaterialInput[] }` | `{ lineMaterials: LineMaterial[] }` |
| 4 | D15 (swap that moves value) | `POST …/stages/{stageId}/materials:swap` | `SwapInput` (see below) | `{ movement: MovementView, changeOrder?: ChangeOrderRef }` |

- Route 3 (**author materials**) is allowed only while the stage's plan version
  is `proposed` and only for the proposer (PROPOSE_PLAN, §4); the freeze trigger
  is the backstop. `MaterialInput` = `{ kind, name, unit, quantity,
  unitPriceCents, position? }`.
- Route 4 (**swap**) records a post-baseline movement. `SwapInput`:

  ```jsonc
  {
    "lineMaterialId": "uuid",
    "movementKind": "scope_change | price_movement",
    "priceCause": "index | supplier_quote | correction",   // required iff price_movement
    "newQuantity": 12.5,           // for a scope_change (qty changed)
    "newUnitPriceCents": 4200,     // for a price_movement (unit price changed) or a scope re-spec
    "source": "ACME steel index 2026-09",
    // scope_change only: how the change order is opened (reuses change_order svc)
    "changeOrder": { "title": "string" }   // costDelta is DERIVED server-side = valueDelta; NOT client-supplied
  }
  ```

  Server computes `valueDeltaCents = newExtended − priorExtended`. For a
  `scope_change` the server **opens a change order** via the change_order service
  (`propose`, cost delta = `valueDeltaCents`), then writes the
  `material_movement` row linked to that CO and appends
  `material_movement_recorded` — all in one transaction. The CO then follows its
  own two-sided approval to actually move the budget (D15 "opens a change order —
  not a silent edit"). For a `price_movement` the server writes the movement +
  ledger event only; **no CO, no budget move** (the CHECK enforces `changeOrderId
  IS NULL`).

### 3c. Budget — materials & price movement (D16)

| # | Screen | Route | Returns |
|---|--------|-------|---------|
| 5 | D16 | `GET …/budget-movement` | `MoneyView` |

`MoneyView` — the decomposition the screen must render *without blurring*:

```jsonc
{
  "baselineBudgetCents": 25000000,     // Σ frozen baseline line values (planned)
  "currentBudgetCents":  25750000,     // baseline + Σ approved CO deltas (from ledger — UNCHANGED invariant)
  "scopeChanges": [                     // moved the CONTRACT total; each is an approved/pending CO
    { "movementId", "stageId", "lineMaterialId", "valueDeltaCents",
      "changeOrder": ChangeOrderRef, "movedByPartyId", "occurredAt" }
  ],
  "priceMovements": [                   // did NOT move the contract total — shown vs baseline unit price
    { "movementId", "stageId", "lineMaterialId", "priceCause", "source",
      "baselineUnitPriceCents", "newUnitPriceCents", "valueDeltaCents",
      "movedByPartyId", "occurredAt" }
  ]
}
```

`currentBudgetCents` is read from the ledger exactly as `change_order.view` does
today (`ledger.currentBudget`) — B3 does not recompute the budget. `scopeChanges`
and `priceMovements` are the two structurally separate arrays; the FE renders
them as two distinct sections, never summed together.

## 4. Permissions (ADR-0004)

Reads (`GET record` / materials / budget-movement) require project membership
(`requireMember`, any seated party). Writes reuse and add:

- **Author materials** (route 3) — the **proposer** of the (proposed) version:
  reuse `PROPOSE_PLAN` (already added in B2). No new action.
- **Record a movement / swap** (route 4) — a new project-scoped action
  `RECORD_MOVEMENT`, granted to the party who owns the executing side of the work
  (the GC/counterparty). For a `scope_change` the opened **change order carries
  its own two-sided approval** (the proposer cannot decide it — existing
  change_order FR4), so the budget still needs the counter-party's approval; the
  movement record itself is the proposing act.

The acting party is derived from the session; proposer-vs-reviewer for the CO is
resolved by the change_order service as it does today.

## 5. FE contract (D14–D16)

- **D14 The record, live.** Four tabs off route 1. **Plan**: the baseline WBS
  (reuse the B1/B2 stage-tree components) with each line's materials summary and
  its derived `state` badge (accepted / deviation / closed-and-verified).
  **Schedule**: planned vs executed (reuse `stage_progress`). **Money**: embed the
  D16 `MoneyView`. **History**: the project's ledger events, read-only (reuse the
  existing audit read). **Compare** toggles planned-vs-executed on any line,
  including closed ones (a settled line stays auditable).
- **D15 Line detail.** Route 2 renders each material/labour: name, unit, quantity,
  unit price, extended value. While the version is `proposed` the proposer can
  author/edit (route 3). Post-baseline, a **swap** (route 4) is the only way to
  change a line: the UI makes the `scope_change` vs `price_movement` choice
  explicit (it drives which fields show and whether a change-order title is
  required) — this is the exact point the pen insists must not be a silent edit.
- **D16 Budget movement.** Route 5. Render `scopeChanges` and `priceMovements` as
  **two separate sections**; never sum a price movement into the contract total.
  Each row shows date, source (or the CO), and the acting party (dated, sourced,
  attributable). Price movements are shown against the **baseline unit price** so
  an index rise reads as a price delta, not a scope change.

## 6. Decomposition (children I own the migration for and merge)

B3 is the largest slice. Decomposed, sequenced:

- **LINA-201-BE** — migration `0004_materials_and_movement.sql`; `line_material`
  authoring on proposed versions; the record read projection (route 1); line
  detail (routes 2–3); the swap → movement/CO path (route 4); the budget-movement
  projection (route 5); `material_movement_recorded` in the ledger fold +
  `chain-verify` fixtures. In-memory ports first (provable in isolation), then the
  pg adapters — same discipline as B1/B2. **Blocks the FE child.**
- **LINA-201-FE** — D14 record (4 tabs + states + Compare), D15 line detail
  (materials + explicit swap), D16 budget movement (two-section view). Blocked by
  LINA-201-BE. If the three screens prove too large together, **D16 splits into a
  follow-up** — the frozen route 5 above makes that churn-free.

Each ships thin and vertical, is reviewed and merged by the architect, applied to
Neon, and QA-verified before the next.

## 7. Open items (finalised in the child issues, not here)

- **`closed_and_verified` verification stamp.** D14's third state needs a
  "verified" signal beyond `stage_progress = done`. v1 candidate: a
  `stage_verified` ledger event + a derived read (no new mutable column, ADR-0005).
  The BE child finalises the stamp; if it is deferred, the state degrades to
  `accepted`/`deviation` only and D14 hides the third badge — **stated, not
  silently dropped.**
- **Line-value reconciliation.** Whether Σ baseline material extended values must
  equal a line's `planned_cost_cents` — **v1: advisory**, surfaced as a soft
  mismatch indicator, not a hard constraint (a line may have a planned cost with
  no material breakdown yet).
- **Re-baseline** (a second accepted version after v1) remains out of scope; the
  `project_baseline` pointer (B2) is shaped for it. Movements are measured against
  the *current* baseline pointer.
- Exact per-field validation bounds (quantity/price ceilings, `source` length)
  are the BE child's; the FE echoes them.
</content>
