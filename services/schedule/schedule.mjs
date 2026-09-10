// Schedule & Progress service — the GC-owned construction plan, stage progress,
// and the derived rollup (LINA-69; spec r0-plan-progress-functional-spec §8;
// ADR-0005; FR-P1, FR-P3, FR-P4, FR-P5, FR-P6).
//
// This is where the plan/progress trust rules live:
//   - A stage's CURRENT status is DERIVED, never stored: it is the status of the
//     latest append-only stage_progress row, ordered by (reported_at, seq) — a
//     total, deterministic order (spec §8.1). A stage with no reports is
//     `not_started`.
//   - Every transition is allowed (construction goes backwards; the record tells
//     the truth either way). The ONE conditional is a correction back to
//     `not_started` from any other status, which requires a note (spec §8.1).
//     `done` is NOT terminal.
//   - Nothing advances a stage except a GC report — no date, no cascade, no CO
//     approval, no system actor (spec §8.1). Writes are GC-only; the homeowner
//     reads everything and is DENIED (not 500'd) on every write (spec §8.2).
//   - The rollup (headline · percent · current-stage pointer) is DERIVED ON READ,
//     never stored, never a ledgered event, equally weighted — never cost- or
//     duration-weighted (spec §8.3).
//   - Stage planned cost is free-form and can NEVER move the authoritative budget:
//     this service holds no budget-move path at all (spec §2 Q2, AC-P5/P12).
//
// Persistence maths it owns none of: the audit append is the Ledger service's,
// authorization is Identity's (the sole authorizer, ADR-0004). This module is
// orchestration over the three ports (see ports.mjs).

import { randomUUID } from 'node:crypto';
import { DomainError, ACTION } from './ports.mjs';

const now = () => new Date().toISOString();

export const STATUSES = Object.freeze(['not_started', 'in_progress', 'blocked', 'done']);
const STATUS_SET = new Set(STATUSES);

// Headline the homeowner reads for the whole build (spec §8.3 R1). Values are
// stable machine tokens; the frontend maps them to copy ("Attention needed", …).
export const HEADLINE = Object.freeze({
  ATTENTION: 'attention_needed',
  COMPLETE: 'complete',
  IN_PROGRESS: 'in_progress',
  NOT_STARTED: 'not_started',
  EMPTY: null, // zero stages → the §5 empty state, NOT "0% complete"
});

// The current status carried by a stage's latest progress row. Zero rows ⇒
// not_started (spec §8.1). `latest` is chosen by the store under (reported_at,
// seq); this function only reads the status off it.
function currentStatusOf(latestRow) {
  return latestRow ? latestRow.status : 'not_started';
}

// Derive the plan rollup from the ordered stages + their current statuses (spec
// §8.3). Pure: no store, no ledger, no cache — recomputed every read (R4).
export function rollup(stagesInOrder, statusByStageId) {
  if (stagesInOrder.length === 0) {
    // R1.5 — zero stages: no headline at all, the empty state. Never "0%".
    return { headline: HEADLINE.EMPTY, percentComplete: null, currentStageId: null, totalStages: 0, doneStages: 0 };
  }

  const statuses = stagesInOrder.map((s) => statusByStageId.get(s.id) ?? 'not_started');
  const doneStages = statuses.filter((s) => s === 'done').length;
  const total = stagesInOrder.length;

  // R1 — headline precedence; first match wins. `blocked` outranks a plan that is
  // otherwise finished — it is the homeowner's intervention signal and must never
  // be averaged away.
  let headline;
  if (statuses.some((s) => s === 'blocked')) headline = HEADLINE.ATTENTION;
  else if (statuses.every((s) => s === 'done')) headline = HEADLINE.COMPLETE;
  else if (statuses.some((s) => s === 'in_progress' || s === 'done')) headline = HEADLINE.IN_PROGRESS;
  else headline = HEADLINE.NOT_STARTED; // all not_started

  // R2 — equal-weighted done/total, floored. 100% is reachable ONLY when every
  // stage is literally `done`: since done < total whenever any stage is not done,
  // floor(done/total*100) is at most 99 in that case — no rounding to 100.
  const percentComplete = Math.floor((doneStages / total) * 100);

  // R3 — current stage pointer, in PLAN ORDER (not dates): first in_progress or
  // blocked; else first not_started; else none (plan complete).
  let current = stagesInOrder.find((s, i) => statuses[i] === 'in_progress' || statuses[i] === 'blocked');
  if (!current) current = stagesInOrder.find((s, i) => statuses[i] === 'not_started');

  return {
    headline,
    percentComplete,
    currentStageId: current ? current.id : null,
    totalStages: total,
    doneStages,
  };
}

export function createScheduleService({ store, ledger, identity }) {
  if (!store || !ledger || !identity) {
    throw new Error('createScheduleService requires { store, ledger, identity } ports');
  }

  // ---- add a stage — FR-P1 --------------------------------------------------
  // POST /projects/:projectId/stages
  async function addStage(projectId, actorPartyId, input) {
    // GC-only (spec §8.2). The homeowner is a member but lacks add_stage → 403.
    const { role } = await identity.authorize({ actorPartyId, action: ACTION.ADD_STAGE, projectId });

    const { name } = input ?? {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new DomainError(400, 'invalid_name', 'stage name is required');
    }
    if (!Number.isInteger(input.position)) {
      throw new DomainError(400, 'invalid_position', 'position must be an integer');
    }
    const plannedCostCents = normalizeCents(input.plannedCostCents);

    const id = randomUUID();
    const createdAt = now();
    const row = {
      id,
      project_id: projectId,
      name: name.trim(),
      position: input.position,
      scope_note: input.scopeNote ?? null,
      description: input.description ?? null,
      planned_start_date: input.plannedStartDate ?? null,
      planned_end_date: input.plannedEndDate ?? null,
      planned_cost_cents: plannedCostCents,
      created_at: createdAt,
      updated_at: createdAt,
    };

    await store.transaction(async (tx) => {
      await store.insertStage(tx, row);
      await ledger.append(tx, {
        projectId,
        type: 'stage_added',
        actorPartyId,
        occurredAt: createdAt,
        payload: {
          stageId: id,
          name: row.name,
          position: row.position,
          plannedCostCents: row.planned_cost_cents,
          plannedStartDate: row.planned_start_date,
          plannedEndDate: row.planned_end_date,
        },
      });
    });

    void role; // role is available for a future analytics event (§6 follow-up)
    return stageView(id);
  }

  // ---- edit / reorder a stage — FR-P1 --------------------------------------
  // PATCH /stages/:stageId
  async function updateStage(stageId, actorPartyId, patch) {
    const existing = await store.getStage(stageId);
    if (!existing) throw new DomainError(404, 'not_found', 'stage not found');
    await identity.authorize({ actorPartyId, action: ACTION.UPDATE_STAGE, projectId: existing.project_id });

    const set = {};
    if (patch?.name !== undefined) {
      if (!patch.name || typeof patch.name !== 'string' || !patch.name.trim()) {
        throw new DomainError(400, 'invalid_name', 'stage name must be a non-empty string');
      }
      set.name = patch.name.trim();
    }
    if (patch?.position !== undefined) {
      if (!Number.isInteger(patch.position)) {
        throw new DomainError(400, 'invalid_position', 'position must be an integer');
      }
      set.position = patch.position;
    }
    if (patch?.scopeNote !== undefined) set.scope_note = patch.scopeNote ?? null;
    if (patch?.description !== undefined) set.description = patch.description ?? null;
    if (patch?.plannedStartDate !== undefined) set.planned_start_date = patch.plannedStartDate ?? null;
    if (patch?.plannedEndDate !== undefined) set.planned_end_date = patch.plannedEndDate ?? null;
    if (patch?.plannedCostCents !== undefined) set.planned_cost_cents = normalizeCents(patch.plannedCostCents);

    if (Object.keys(set).length === 0) {
      throw new DomainError(400, 'nothing_to_update', 'no updatable fields supplied');
    }
    set.updated_at = now();

    await store.transaction(async (tx) => {
      const updated = await store.updateStage(tx, stageId, set);
      if (!updated) throw new DomainError(404, 'not_found', 'stage not found');
      await ledger.append(tx, {
        projectId: existing.project_id,
        type: 'stage_updated',
        actorPartyId,
        occurredAt: set.updated_at,
        payload: { stageId, changed: Object.keys(set).filter((k) => k !== 'updated_at') },
      });
    });

    return stageView(stageId);
  }

  // ---- report progress, append-only — FR-P3, spec §8.1 --------------------
  // POST /stages/:stageId/progress
  async function reportProgress(stageId, actorPartyId, input) {
    const stage = await store.getStage(stageId);
    if (!stage) throw new DomainError(404, 'not_found', 'stage not found');
    // GC-only (spec §8.2). A homeowner attempting this is a 403 denial, never a 500.
    await identity.authorize({ actorPartyId, action: ACTION.REPORT_PROGRESS, projectId: stage.project_id });

    const status = input?.status;
    if (!STATUS_SET.has(status)) {
      throw new DomainError(400, 'invalid_status',
        `status must be one of ${STATUSES.join(', ')}`);
    }

    // The state machine (spec §8.1). Every transition is allowed; the ONLY
    // conditional is a correction back to not_started FROM a status that is not
    // already not_started — that requires a note. Reporting not_started when the
    // stage is already not_started is a re-report (●) and needs no note.
    const currentLatest = await latestFor(stageId);
    const currentStatus = currentStatusOf(currentLatest);
    const noteProvided = input?.note != null && String(input.note).trim() !== '';
    if (status === 'not_started' && currentStatus !== 'not_started' && !noteProvided) {
      throw new DomainError(400, 'note_required',
        'walking a stage back to not_started requires a note (spec §8.1)');
    }

    // Percent is advisory and ONLY meaningful while in_progress (spec §2 Q1, §5):
    // outside in_progress it is ignored (set null), so a report can never read
    // "done · 70%". Inside in_progress it must be a 0..100 integer if supplied.
    let percent = null;
    if (status === 'in_progress' && input?.percent != null) {
      if (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) {
        throw new DomainError(400, 'invalid_percent', 'percent must be an integer 0..100');
      }
      percent = input.percent;
    }

    const id = randomUUID();
    const reportedAt = now();
    const row = {
      id,
      stage_id: stageId,
      project_id: stage.project_id,
      status,
      percent,
      note: input?.note ?? null,
      reported_by_party_id: actorPartyId,
      reported_at: reportedAt,
    };

    await store.transaction(async (tx) => {
      await store.insertProgress(tx, row);
      // Every progress write is ledgered in the SAME transaction as its projection
      // (spec §8.2): if the audit event doesn't land, the status change didn't
      // happen. The status transition rides the payload for the §6 analytics
      // follow-up (esp. → blocked / → done).
      await ledger.append(tx, {
        projectId: stage.project_id,
        type: 'progress_reported',
        actorPartyId,
        occurredAt: reportedAt,
        payload: {
          stageId,
          fromStatus: currentStatus,
          toStatus: status,
          percent,
          hasNote: row.note != null,
        },
      });
    });

    return stageView(stageId);
  }

  // ---- the plan timeline + rollup — FR-P4, FR-P6, spec §8.3 ----------------
  // GET /projects/:projectId/plan  (both parties read; spec §8.2)
  async function getPlan(projectId, actorPartyId) {
    await identity.requireMember(actorPartyId, projectId);

    const stages = await store.listStages(projectId);
    const latestByStage = await store.latestProgressByProject(projectId);

    const statusByStageId = new Map();
    for (const s of stages) statusByStageId.set(s.id, currentStatusOf(latestByStage.get(s.id)));

    const timeline = stages.map((s) => shapeStage(s, latestByStage.get(s.id) ?? null));
    const roll = rollup(stages, statusByStageId);

    // The read-only "allocated vs baseline" hint (FR-P6, spec §2 Q2). The baseline
    // is the ledger's authoritative number, read through the Ledger port — Schedule
    // never re-sums it and nothing here can change it. `allocatedCents` is a plain
    // sum of planned stage costs, explicitly labelled as an allocation, NOT budget.
    const budget = (await ledger.currentBudget(projectId)) ?? { baselineCents: 0, currentCents: 0 };
    const allocatedCents = stages.reduce((acc, s) => acc + (s.planned_cost_cents ?? 0), 0);

    return {
      projectId,
      headline: roll.headline,
      percentComplete: roll.percentComplete,
      currentStageId: roll.currentStageId,
      totalStages: roll.totalStages,
      doneStages: roll.doneStages,
      stages: timeline,
      allocation: {
        allocatedCents,
        baselineCents: budget.baselineCents,
        // Informational delta only (FR-P6). Over/under-allocation is shown as
        // information; it is NOT the budget and can never move it.
        deltaCents: allocatedCents - budget.baselineCents,
      },
    };
  }

  // ---- one stage with its full attributed history — FR-P3, AC-P3 ----------
  // GET /stages/:stageId  (both parties read)
  async function viewStage(stageId, actorPartyId) {
    const stage = await store.getStage(stageId);
    if (!stage) throw new DomainError(404, 'not_found', 'stage not found');
    await identity.requireMember(actorPartyId, stage.project_id);
    return stageView(stageId);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async function latestFor(stageId) {
    const history = await store.listProgressByStage(stageId);
    return history.length ? history[history.length - 1] : null;
  }

  // The single-stage read shape, including the full ordered, attributed history
  // (AC-P3: the whole progression is retrievable, no earlier report overwritten).
  async function stageView(stageId) {
    const stage = await store.getStage(stageId);
    if (!stage) throw new DomainError(404, 'not_found', 'stage not found');
    const history = await store.listProgressByStage(stageId);
    const latest = history.length ? history[history.length - 1] : null;
    return {
      ...shapeStage(stage, latest),
      history: history.map(shapeProgress),
    };
  }

  return { addStage, updateStage, reportProgress, getPlan, viewStage, rollup };
}

// ── pure shapers (snake_case row → camelCase API) ─────────────────────────────

function shapeStage(s, latest) {
  const currentStatus = latest ? latest.status : 'not_started';
  return {
    id: s.id,
    projectId: s.project_id,
    name: s.name,
    position: s.position,
    scopeNote: s.scope_note ?? null,
    description: s.description ?? null,
    plannedStartDate: s.planned_start_date ?? null,
    plannedEndDate: s.planned_end_date ?? null,
    plannedCostCents: s.planned_cost_cents ?? null,
    currentStatus,
    // Advisory percent surfaces ONLY while in_progress (spec §2 Q1, §5).
    currentPercent: currentStatus === 'in_progress' ? (latest?.percent ?? null) : null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function shapeProgress(p) {
  return {
    id: p.id,
    stageId: p.stage_id,
    status: p.status,
    percent: p.percent ?? null,
    note: p.note ?? null,
    reportedBy: p.reported_by_party_id,
    reportedAt: p.reported_at,
  };
}

function normalizeCents(v) {
  if (v == null) return null;
  if (!Number.isInteger(v)) {
    throw new DomainError(400, 'invalid_cost', 'plannedCostCents must be an integer (cents)');
  }
  return v;
}

export { DomainError };
