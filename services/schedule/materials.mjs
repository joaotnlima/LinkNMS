// Slice B3 — materials, material movement, live record & budget movement
// (LINA-217; frozen contract docs/architecture/slice-b3-live-record-materials
// -contract.md §3–§4; anchors ADR-0014, ADR-0002 §4/§5, ADR-0004, ADR-0005,
// ADR-0006 §1).
//
// This is where the D14–D16 trust rules live:
//   - Materials are plan-version state: author/edit ONLY while the stage's plan
//     version is 'proposed' and ONLY for the proposer (PROPOSE_PLAN, contract
//     §4). The DB line_material_freeze_guard trigger is the backstop; the
//     service mirrors it in code (ADR-0014 §1).
//   - A SWAP records a post-baseline movement. valueDeltaCents is computed
//     SERVER-side (newExtended − priorExtended) — never client-supplied. The
//     ADR-0014 §3 invariant is enforced by the store's CHECK (mirrored in code):
//       scope_change   ↔ carries a change order, no price_cause (moves budget via CO)
//       price_movement ↔ carries a price_cause, no change order (NO budget move)
//   - A scope_change opens a change order via the EXISTING change_order service
//     (cost delta = valueDelta), then writes the linked material_movement and
//     appends material_movement_recorded. The CO follows its own two-sided
//     approval and moves the budget via the ledger's budget_event path — B3 adds
//     no new writer of budget (ADR-0014 §2).
//   - Line/record state is DERIVED on read (accepted | deviation), never a
//     mutable column (ADR-0005). `closed_and_verified` is DECLINED in v1 (it
//     needs the deferred `stage_verified` stamp) — the state degrades to
//     accepted/deviation only, per contract §7.
//   - currentBudgetCents is read from the ledger (ledger.currentBudget) — B3
//     never recomputes the budget.
//   - actor + time are server-authoritative (ADR-0002 §5): actorPartyId from the
//     session, occurredAt from the server clock — never the body.

import { randomUUID } from 'node:crypto';
import { ACTION, DomainError } from './ports.mjs';

const now = () => new Date().toISOString();

const KIND_SET = new Set(['material', 'labour']);
const PRICE_CAUSE_SET = new Set(['index', 'supplier_quote', 'correction']);
const MOVEMENT_KIND_SET = new Set(['scope_change', 'price_movement']);

// Per-field validation bounds (contract §7 finalised here):
//   - quantity: 0..1e6 (numeric(14,3)); price: 0..1e12 cents; name/unit ≤ 200;
//     source ≤ 500; position ≥ 0.
const MAX_QUANTITY = 1_000_000;
const MAX_PRICE_CENTS = 1_000_000_000_000;
const MAX_STRING = 200;
const MAX_SOURCE = 500;

function assertRange(cond, code, message) {
  if (!cond) throw new DomainError(400, code, message);
}

export function createMaterialsService({ store, ledger, identity, changeOrder = null }) {
  if (!store || !ledger || !identity) {
    throw new Error('createMaterialsService requires { store, ledger, identity } ports');
  }
  // `changeOrder` is optional: only the scope_change swap path needs it. A
  // build that mounts only materials reading (record / budget-movement) can omit
  // it; a scope_change swap without it is a 500-free loud misconfig error.
  if (!changeOrder) {
    throw new Error('createMaterialsService requires { changeOrder } to open change orders on a scope_change');
  }
  // Internal alias so the SwapInput's `changeOrder` field (a `{ title }` ref) can
  // never shadow the change-order SERVICE this closure holds.
  const changeOrderService = changeOrder;

  // The DB line_material_freeze_guard trigger is the backstop; the store's
  // assertMaterialMutable mirrors it. This service additionally checks the plan
  // version status BEFORE the write so a misconfigured actor gets a friendly 409
  // rather than a raw DB exception. The freeze condition is that the version is
  // terminal (accepted/superseded/withdrawn/rejected); only 'proposed' is open.
  async function assertAuthorableVersion(stage) {
    const version = await store.getPlanVersion(stage.plan_version_id);
    if (!version) {
      throw new DomainError(409, 'not_proposed',
        'this stage has no plan version; materials can only be authored while proposed');
    }
    if (version.status !== 'proposed') {
      throw new DomainError(409, 'not_proposed',
        'materials are only authorable while the plan version is proposed (they freeze with the baseline)');
    }
    return version;
  }

  // Route 3 authorisation: authoring is the proposing party's own action on a
  // proposed version (PROPOSE_PLAN; contract §4). The proposer-vs-actor pairing
  // is resolved from the version row, never the request.
  async function authorizeProposer(stage, actorPartyId) {
    await identity.authorize({
      actorPartyId,
      action: ACTION.PROPOSE_PLAN,
      projectId: stage.project_id,
    });
    const version = await store.getPlanVersion(stage.plan_version_id);
    if (!version || actorPartyId !== version.proposed_by_party_id) {
      throw new DomainError(403, 'forbidden',
        'only the proposing party may author materials on a proposed version');
    }
    return version;
  }

  // Route 4 authorisation: RECORD_MOVEMENT (new B3 action, granted to the GC /
  // counterparty — contract §4). A scope_change additionally opens a change
  // order that carries its own two-sided approval.
  async function authorizeMovement(stage, actorPartyId) {
    await identity.authorize({
      actorPartyId,
      action: ACTION.RECORD_MOVEMENT,
      projectId: stage.project_id,
    });
  }

  // A swap is a POST-baseline record (contract §3b): the stage's plan version
  // must be frozen/terminal. Authoring covered the `proposed` phase.
  async function requireBaselinedVersion(stage) {
    const version = await store.getPlanVersion(stage.plan_version_id);
    if (!version || !['accepted', 'superseded', 'withdrawn', 'rejected'].includes(version.status)) {
      throw new DomainError(409, 'not_baselined',
        'a swap records a post-baseline movement — the stage plan version must be frozen');
    }
    return version;
  }

  async function getStageOr404(stageId) {
    const stage = await store.getStage(stageId);
    if (!stage) throw new DomainError(404, 'not_found', 'stage not found');
    return stage;
  }

  // ── Route 2: GET …/stages/{stageId}/materials (D15) ───────────────────────
  async function getLineMaterials(stageId, actorPartyId) {
    const stage = await getStageOr404(stageId);
    await identity.requireMember(actorPartyId, stage.project_id);
    const lineMaterials = await store.listLineMaterialsByStage(stageId);
    const movements = [];
    const byLine = new Map();
    for (const m of lineMaterials) {
      const mine = await store.listMovementsByLine(m.id);
      byLine.set(m.id, mine);
      movements.push(...mine);
    }
    movements.sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.seq - b.seq));
    // Materials render their CURRENT state (baseline overridden by the latest
    // movement); the movement rows that produced it are in `movements`.
    return {
      lineMaterials: lineMaterials.map((m) => shapeLiveMaterial(m, byLine.get(m.id) ?? [])),
      movements: movements.map(shapeMovement),
    };
  }

  // ── Route 3: POST …/stages/{stageId}/materials (D15 authoring) ────────────
  // Author/edit allowed ONLY while the plan version is proposed and only for the
  // proposer (PROPOSE_PLAN). The contract §2 ledger table names only
  // material_movement_recorded — authoring is plain INSERTs onto a still-proposed
  // version (accountability is carried by the version's own frozen/acceptance
// events), so NO ledger append happens here. Inserts (or full-replaces) the
    // stage's materials.
    async function authorMaterials(stageId, actorPartyId, { materials } = {}) {
    const stage = await getStageOr404(stageId);
    const version = await authorizeProposer(stage, actorPartyId);
    await assertAuthorableVersion(stage);

    if (!Array.isArray(materials) || materials.length === 0) {
      throw new DomainError(400, 'invalid_materials', 'materials must be a non-empty array');
    }
    const clean = materials.map((m, i) => validateMaterialInput(m, i));

    const occurredAt = now();
    await store.transaction(async (tx) => {
      for (const m of clean) {
        await store.insertLineMaterial(tx, {
          id: randomUUID(),
          stage_id: stageId,
          project_id: stage.project_id,
          plan_version_id: version.id,
          kind: m.kind,
          name: m.name,
          unit: m.unit,
          quantity: m.quantity,
          unit_price_cents: m.unitPriceCents,
          position: m.position,
          created_at: occurredAt,
          updated_at: occurredAt,
        });
      }
    });

    const lineMaterials = await store.listLineMaterialsByStage(stageId);
    return { lineMaterials: lineMaterials.map(shapeLineMaterial) };
  }

  // ── Route 4: POST …/stages/{stageId}/materials:swap (D15/D16) ─────────────
  // Records a post-baseline movement. valueDeltaCents = newExtended − priorExtended,
  // computed server-side. scope_change → opens a CO (costDelta=valueDelta) via the
  // change_order service + movement + ledger event (the CO is what moves the
  // budget). price_movement → movement + ledger event only (no CO, no budget
  // move). The material row is FROZEN — it is never edited by a swap: the
  // movement row carries the resulting state (ADR-0014 §1, contract §1).
  async function swapMaterial(stageId, actorPartyId, input) {
    const stage = await getStageOr404(stageId);
    await authorizeMovement(stage, actorPartyId);
    await requireBaselinedVersion(stage);

    const { lineMaterialId, movementKind, priceCause, newQuantity, newUnitPriceCents, source, changeOrder } = input ?? {};

    if (!MOVEMENT_KIND_SET.has(movementKind)) {
      throw new DomainError(400, 'invalid_movement', "movementKind must be 'scope_change' or 'price_movement'");
    }
    if (source != null && (typeof source !== 'string' || source.length > MAX_SOURCE)) {
      throw new DomainError(400, 'invalid_source', `source must be a string ≤ ${MAX_SOURCE} chars or null`);
    }

    const material = await store.getLineMaterial(lineMaterialId);
    if (!material) throw new DomainError(404, 'not_found', 'line material not found');
    if (material.stage_id !== stageId) {
      throw new DomainError(400, 'mismatch', 'the line material does not belong to this stage');
    }

    // priorExtended is the material's CURRENT value (baseline overridden by any
    // earlier movements), so sequential swaps delta against what the line reads,
    // never a stale baseline row.
    const prior = currentMaterialState(material, await store.listMovementsByLine(material.id));

    if (movementKind === 'scope_change') {
      if (priceCause != null) {
        throw new DomainError(400, 'invalid_price_cause', 'a scope_change cannot carry a price_cause');
      }
      if (!Number.isFinite(newQuantity) || newQuantity < 0 || newQuantity > MAX_QUANTITY) {
        throw new DomainError(400, 'invalid_quantity', 'scope_change requires a newQuantity in 0..1e6');
      }
      const newPrice = (Number.isInteger(newUnitPriceCents) && newUnitPriceCents >= 0 && newUnitPriceCents <= MAX_PRICE_CENTS)
        ? newUnitPriceCents
        : prior.unitPriceCents;
      if (!changeOrder || typeof changeOrder.title !== 'string' || !changeOrder.title.trim()) {
        throw new DomainError(400, 'invalid_change_order', 'a scope_change requires changeOrder.title');
      }
      return performScopeChange(stage, material, actorPartyId, prior, {
        newQuantity, newUnitPriceCents: newPrice, source, changeOrder,
      });
    }

    // price_movement
    if (changeOrder != null) {
      throw new DomainError(400, 'invalid_change_order', 'a price_movement cannot carry a change order');
    }
    if (priceCause == null || !PRICE_CAUSE_SET.has(priceCause)) {
      throw new DomainError(400, 'invalid_price_cause',
        "price_movement requires priceCause of 'index' | 'supplier_quote' | 'correction'");
    }
    if (!Number.isInteger(newUnitPriceCents) || newUnitPriceCents < 0 || newUnitPriceCents > MAX_PRICE_CENTS) {
      throw new DomainError(400, 'invalid_price', 'price_movement requires newUnitPriceCents in 0..1e12');
    }
    const newQty = (Number.isFinite(newQuantity) && newQuantity >= 0 && newQuantity <= MAX_QUANTITY)
      ? newQuantity
      : prior.quantity;

    return performPriceMovement(stage, material, actorPartyId, prior, {
      priceCause, newQuantity: newQty, newUnitPriceCents, source,
    });
  }

  async function performScopeChange(stage, material, actorPartyId, prior, { newQuantity, newUnitPriceCents, source, changeOrder }) {
    const valueDeltaCents = (newQuantity * newUnitPriceCents) - prior.extended;
    const movementId = randomUUID();
    const occurredAt = now();

    // Realise the money through the EXISTING change_order service: open a CO with
    // the server-derived cost delta = valueDelta (never client-supplied). The CO
    // must open before the movement references it. It runs its own transaction
    // (documented seam) and appends its own change_order_proposed event.
    const co = await changeOrderService.propose(stage.project_id, actorPartyId, {
      title: changeOrder.title.trim(),
      costDeltaCents: valueDeltaCents,
    });

    let movementRow = null;
    await store.transaction(async (tx) => {
      // Append material_movement_recorded FIRST (its audit_event_id is needed by
      // the movement row — append-only, INSERT only); payload carries the movement
      // id (contract §2) generated up front.
      const event = await ledger.append(tx, {
        projectId: stage.project_id,
        type: 'material_movement_recorded',
        actorPartyId,
        occurredAt,
        payload: {
          movementId,
          lineMaterialId: material.id,
          stageId: stage.id,
          movementKind: 'scope_change',
          priceCause: null,
          newQuantity,
          newUnitPriceCents,
          valueDeltaCents,
          changeOrderId: co.id,
          source: source ?? null,
        },
      });
      // The material row stays frozen — the movement carries the resulting state.
      movementRow = await store.insertMaterialMovement(tx, {
        id: movementId,
        project_id: stage.project_id,
        line_material_id: material.id,
        stage_id: stage.id,
        movement_kind: 'scope_change',
        price_cause: null,
        new_quantity: newQuantity,
        new_unit_price_cents: newUnitPriceCents,
        value_delta_cents: valueDeltaCents,
        source: source ?? null,
        change_order_id: co.id,
        moved_by_party_id: actorPartyId,
        occurred_at: occurredAt,
        audit_event_id: event.id,
      });
    });

    return { movement: shapeMovement(movementRow), changeOrder: { id: co.id, status: co.status, title: co.title } };
  }

  async function performPriceMovement(stage, material, actorPartyId, prior, { priceCause, newQuantity, newUnitPriceCents, source }) {
    const valueDeltaCents = (newQuantity * newUnitPriceCents) - prior.extended;
    const movementId = randomUUID();
    const occurredAt = now();

    let movementRow = null;
    await store.transaction(async (tx) => {
      const event = await ledger.append(tx, {
        projectId: stage.project_id,
        type: 'material_movement_recorded',
        actorPartyId,
        occurredAt,
        payload: {
          movementId,
          lineMaterialId: material.id,
          stageId: stage.id,
          movementKind: 'price_movement',
          priceCause,
          newQuantity,
          newUnitPriceCents,
          valueDeltaCents,
          changeOrderId: null,
          source: source ?? null,
        },
      });
      movementRow = await store.insertMaterialMovement(tx, {
        id: movementId,
        project_id: stage.project_id,
        line_material_id: material.id,
        stage_id: stage.id,
        movement_kind: 'price_movement',
        price_cause: priceCause,
        new_quantity: newQuantity,
        new_unit_price_cents: newUnitPriceCents,
        value_delta_cents: valueDeltaCents,
        source: source ?? null,
        change_order_id: null,
        moved_by_party_id: actorPartyId,
        occurred_at: occurredAt,
        audit_event_id: event.id,
      });
    });

    return { movement: shapeMovement(movementRow) };
  }

  // ── Route 1: GET …/projects/{projectId}/record (D14) ──────────────────────
  // The 4-tab projection (plan/schedule/money/history) + derived line/record state
  // (accepted | deviation) + Compare fields. `closed_and_verified` is OFF in v1
  // (contract §7) — deferred with the `stage_verified` stamp.
  async function getRecord(projectId, actorPartyId) {
    await identity.requireMember(actorPartyId, projectId);

    const baseline = await store.getProjectBaseline(projectId);
    const baselineVersionId = baseline?.plan_version_id ?? null;
    const stages = baselineVersionId
      ? await store.listStagesByPlanVersion(baselineVersionId)
      : await store.listStages(projectId);
    const latestByStage = await store.latestProgressByProject(projectId);

    const baselineMaterials = new Map(); // stageId -> materials[]
    for (const m of await (baselineVersionId
      ? store.listLineMaterialsByVersion(baselineVersionId)
      : Promise.resolve([]))) {
      if (!baselineMaterials.has(m.stage_id)) baselineMaterials.set(m.stage_id, []);
      baselineMaterials.get(m.stage_id).push(m);
    }

    const movements = await store.listMovementsByProject(projectId);

    const planLines = stages.map((s) => {
      const materials = baselineMaterials.get(s.id) ?? [];
      const lineMovements = movements.filter((mv) => mv.stage_id === s.id);
      // currentValueCents derives from the baseline materials overridden by the
      // latest movement per line (a line may have a planned cost but no material
      // breakdown yet — then it falls back to that cost, contract §7 advisory).
      const currentValueCents = currentValueOfMaterials(materials, lineMovements)
        ?? (s.planned_cost_cents ?? 0);
      const state = deriveLineState({ hasMovements: lineMovements.length > 0 });
      return {
        stageId: s.id,
        name: s.name,
        trade: s.trade ?? null,
        position: s.position,
        state,
        plannedCostCents: s.planned_cost_cents ?? 0,
        currentValueCents,
        materials: materials.map((m) => shapeLiveMaterial(m, lineMovements.filter((mv) => mv.line_material_id === m.id))),
        compare: { plannedCostCents: s.planned_cost_cents ?? 0, currentValueCents },
      };
    });

    return {
      state: deriveRecordState(planLines),
      baseline: baseline
        ? { planVersionId: baseline.plan_version_id, versionNo: baseline.version_no, frozenAt: baseline.frozen_at }
        : null,
      tabs: {
        plan: { lines: planLines },
        schedule: { lines: stages.map((s) => shapeScheduleLine(s, latestByStage.get(s.id) ?? null)) },
        money: await buildMoneyView(projectId, movements),
        history: { events: await historyEvents(projectId) },
      },
    };
  }

  // ── Route 5: GET …/projects/{projectId}/budget-movement (D16) ─────────────
  // MoneyView: two structurally separate arrays scopeChanges vs priceMovements;
  // currentBudgetCents read from the ledger (never recomputed).
  async function getBudgetMovement(projectId, actorPartyId) {
    await identity.requireMember(actorPartyId, projectId);
    const movements = await store.listMovementsByProject(projectId);
    return buildMoneyView(projectId, movements);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  // Derive a single baseline line's state (ADR-0005; ADR-0014 §4; contract §3a).
  // A line deviates from the agreed baseline when a movement has touched it.
  // `closed_and_verified` is deferred in v1 (needs the `stage_verified` stamp) —
  // the state degrades per contract §7. A mismatch between Σ materials and a
  // line's planned cost is NOT a deviation — that reconciliation is advisory-only
  // (§7), surfaced as a soft compare indicator, not a state.
  function deriveLineState({ hasMovements }) {
    return hasMovements ? 'deviation' : 'accepted';
  }

  function deriveRecordState(lines) {
    return lines.some((l) => l.state === 'deviation') ? 'deviation' : 'accepted';
  }

  async function buildMoneyView(projectId, movements) {
    const budget = (await ledger.currentBudget(projectId))
      ?? { baselineCents: 0, currentCents: 0 };

    const scopeChanges = [];
    const priceMovements = [];

    for (const mv of movements) {
      const base = {
        movementId: mv.id,
        stageId: mv.stage_id,
        lineMaterialId: mv.line_material_id,
        valueDeltaCents: Number(mv.value_delta_cents),
        movedByPartyId: mv.moved_by_party_id,
        occurredAt: mv.occurred_at,
      };
      if (mv.movement_kind === 'scope_change') {
        scopeChanges.push({
          ...base,
          changeOrder: { id: mv.change_order_id },
        });
      } else {
        // Shown against the baseline unit price so an index rise reads as a
        // price delta, not a scope change (contract §3c/§5).
        const material = await store.getLineMaterial(mv.line_material_id);
        priceMovements.push({
          ...base,
          priceCause: mv.price_cause,
          source: mv.source ?? null,
          baselineUnitPriceCents: material ? Number(material.unit_price_cents) : null,
          newUnitPriceCents: Number(mv.new_unit_price_cents),
        });
      }
    }

    scopeChanges.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
    priceMovements.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

    return {
      baselineBudgetCents: budget.baselineCents,
      currentBudgetCents: budget.currentCents,
      scopeChanges,
      priceMovements,
    };
  }

  async function historyEvents(projectId) {
    try {
      const audit = await ledger.getAudit?.(projectId);
      return (audit?.events ?? []).map((e) => ({
        eventId: e.id,
        seq: e.seq,
        type: e.type,
        actorPartyId: e.actorPartyId,
        occurredAt: e.occurredAt,
        payload: e.payload ?? null,
      }));
    } catch {
      return [];
    }
  }

  return { getRecord, getLineMaterials, authorMaterials, swapMaterial, getBudgetMovement };
}

// ── pure shapers (snake_case row → camelCase API) ─────────────────────────────

// The CURRENT state of a line material = baseline row overridden by the latest
// movement's resulting fields (contract §1: a movement carries what the line now
// reads; NULL falls back to the baseline). `lineMovements` must be ordered by
// (occurred_at, seq).
function currentMaterialState(material, lineMovements) {
  const last = lineMovements[lineMovements.length - 1];
  const quantity = last && last.new_quantity != null ? Number(last.new_quantity) : Number(material.quantity);
  const unitPriceCents = last && last.new_unit_price_cents != null ? Number(last.new_unit_price_cents) : Number(material.unit_price_cents);
  return { quantity, unitPriceCents, extended: Math.round(quantity * unitPriceCents) };
}

// Σ current extended values of a stage's baseline materials (each overridden by
// its own latest movement). null when the line has no material breakdown.
function currentValueOfMaterials(materials, lineMovements) {
  if (materials.length === 0) return null;
  let total = 0;
  for (const m of materials) {
    const mine = lineMovements.filter((mv) => mv.line_material_id === m.id);
    total += currentMaterialState(m, mine).extended;
  }
  return Math.round(total);
}

// LineMaterial row → camelCase API shape with CURRENT (movement-adjusted) fields.
function shapeLiveMaterial(material, lineMovements) {
  const state = currentMaterialState(material, lineMovements);
  return { ...shapeLineMaterial(material), quantity: state.quantity, unitPriceCents: state.unitPriceCents };
}

function shapeLineMaterial(m) {
  return {
    id: m.id,
    stageId: m.stage_id,
    projectId: m.project_id,
    planVersionId: m.plan_version_id,
    kind: m.kind,
    name: m.name,
    unit: m.unit,
    quantity: Number(m.quantity),
    unitPriceCents: Number(m.unit_price_cents),
    position: m.position,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

function shapeMovement(mv) {
  return {
    id: mv.id,
    seq: mv.seq ?? null,
    projectId: mv.project_id,
    lineMaterialId: mv.line_material_id,
    stageId: mv.stage_id,
    movementKind: mv.movement_kind,
    priceCause: mv.price_cause ?? null,
    newQuantity: mv.new_quantity == null ? null : Number(mv.new_quantity),
    newUnitPriceCents: mv.new_unit_price_cents == null ? null : Number(mv.new_unit_price_cents),
    valueDeltaCents: Number(mv.value_delta_cents),
    source: mv.source ?? null,
    changeOrderId: mv.change_order_id ?? null,
    movedByPartyId: mv.moved_by_party_id,
    occurredAt: mv.occurred_at,
    auditEventId: mv.audit_event_id,
    createdAt: mv.created_at,
  };
}

function shapeScheduleLine(s, latest) {
  return {
    stageId: s.id,
    name: s.name,
    position: s.position,
    plannedStartDate: s.planned_start_date ?? null,
    plannedEndDate: s.planned_end_date ?? null,
    status: latest ? latest.status : 'not_started',
    percent: latest ? (latest.status === 'in_progress' ? latest.percent : null) : null,
  };
}

function validateMaterialInput(m, idx) {
  if (!m || typeof m !== 'object') {
    throw new DomainError(400, 'invalid_materials', `material ${idx} must be an object`);
  }
  const kind = m.kind ?? 'material';
  if (!KIND_SET.has(kind)) {
    throw new DomainError(400, 'invalid_material_kind', "kind must be 'material' or 'labour'");
  }
  if (!m.name || typeof m.name !== 'string' || m.name.trim().length === 0) {
    throw new DomainError(400, 'invalid_material_name', 'name is required');
  }
  if (m.name.trim().length > MAX_STRING) {
    throw new DomainError(400, 'invalid_material_name', `name must be ≤ ${MAX_STRING} chars`);
  }
  if (!m.unit || typeof m.unit !== 'string' || m.unit.trim().length === 0 || m.unit.trim().length > MAX_STRING) {
    throw new DomainError(400, 'invalid_material_unit', `unit is required, ≤ ${MAX_STRING} chars`);
  }
  assertRange(Number.isFinite(m.quantity) && m.quantity >= 0 && m.quantity <= MAX_QUANTITY,
    'invalid_quantity', `quantity must be in 0..${MAX_QUANTITY}`);
  assertRange(Number.isInteger(m.unitPriceCents) && m.unitPriceCents >= 0 && m.unitPriceCents <= MAX_PRICE_CENTS,
    'invalid_price', `unitPriceCents must be an integer in 0..${MAX_PRICE_CENTS}`);
  const position = m.position == null ? 0 : m.position;
  assertRange(Number.isInteger(position) && position >= 0, 'invalid_position', 'position must be an integer ≥ 0');
  return {
    kind,
    name: m.name.trim(),
    unit: m.unit.trim(),
    quantity: m.quantity,
    unitPriceCents: m.unitPriceCents,
    position,
  };
}

export { DomainError };
