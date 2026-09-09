-- Schedule & Progress service — materials + material movement (Slice B3, LINA-217;
-- frozen contract docs/architecture/slice-b3-live-record-materials-contract.md §1;
-- anchors ADR-0014, ADR-0002, ADR-0004, ADR-0005).
--
-- Adds the materials/labour breakdown behind each plan line (line_material) and
-- the append-only movement ledger (material_movement) that records every
-- post-baseline change. Materials are plan-version state — editable only while
-- proposed, frozen with the baseline (ADR-0014 §1). Movements are how a frozen
-- line changes; they carry their own append-only trust.
--
-- TRUST DISCIPLINE:
--   - line_material: SELECT + INSERT + UPDATE (authored + edited WHILE proposed;
--     the freeze trigger stops writes once frozen). No DELETE.
--   - material_movement: append-only projection — SELECT + INSERT only. No
--     UPDATE/DELETE. A movement is never edited, only superseded by another.
--   - The load-bearing CHECK on material_movement enforces the ADR-0014 §3
--     invariant: scope_change MUST carry a CO and no price_cause;
--     price_movement MUST carry a price_cause and no CO.
--   - schedule_app already holds EXECUTE on ledger.append_event (ledger/0007) —
--     NO new ledger grant.
--
-- Forward-only. Applied by the migrator role. Owned + finalised by the
-- Full-Stack Architect (the BE drafts; the Architect reviews & applies to Neon).

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
