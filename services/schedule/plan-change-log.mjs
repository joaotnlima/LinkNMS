// Change-order guard + plan_change_log capture (LINA-280; ADR-0023 §8).
//
// Once the execution phase is `signed_off` the plan is locked: every
// task/stage/dependency mutation is routed through change orders instead
// (ADR-0014). This module owns that gate and the append-only audit trail of
// the mutations that happened while the plan was still freely editable.
//
// Both helpers run INSIDE the mutation's own `store.transaction` (same unit of
// work that writes the mutation), so the guard's phase re-read and the write it
// protects cannot interleave with a concurrent select-constructor that signs the
// phase off:
//   - the guard takes a row lock on the execution phase (SELECT ... FOR UPDATE
//     via store.getExecutionPhase(tx)) when a tx is provided;
//   - the select-constructor's status flip takes the same row lock; Postgres
//     serialises them, so a mutation sees either `active` (writes + audits) or
//     `signed_off` (409 PLAN_LOCKED) — never a torn decision.
//
// Back-compat (ADR-0023 §9 decision): a project with NO phase rows yet
// (legacy) mutates exactly as it does today — the guard passes and the capture
// is a no-op, because there is no execution phase to anchor an audit row to.

import { randomUUID } from 'node:crypto';
import { DomainError } from './ports.mjs';

const now = () => new Date().toISOString();

/**
 * Re-read the execution phase under `tx` and refuse the mutation once it is
 * `signed_off`. Returns { phaseId, allowed } — always `allowed: true` unless it
 * throws the 409; `phaseId` is null on legacy projects without phase rows.
 *
 * @param {object} store schedule store (getExecutionPhase)
 * @param {object} tx    the mutation's transaction (optional)
 * @param {string} projectId
 */
export async function assertExecutionEditable(store, tx, projectId) {
  const execution = await store.getExecutionPhase(projectId, tx);
  if (!execution) return { phaseId: null, allowed: true };
  if (execution.status === 'signed_off') {
    throw new DomainError(
      409,
      'PLAN_LOCKED',
      'the plan is locked — the execution phase has been signed off; further changes go through a change order',
    );
  }
  return { phaseId: execution.id, allowed: true };
}

/**
 * Append one plan_change_log row per change entry, in the SAME transaction as
 * the mutation. No-op when there is no execution phase (legacy projects) —
 * there is nowhere to anchor the audit row and nothing to gate.
 *
 * @param {object} store schedule store (insertPlanChangeLog)
 * @param {object} tx    the mutation's transaction (required)
 * @param {object} args  { projectId, phaseId, actorPartyId, changes }
 *   changes: [{ entityType: 'task'|'stage'|'dependency', entityId, fieldName,
 *               oldValue?, newValue? }]
 */
export async function capturePlanChangeLog(store, tx, { projectId, phaseId, actorPartyId, changes }) {
  if (!phaseId || !changes?.length) return;
  const occurredAt = now();
  for (const c of changes) {
    if (!c.entityType || !c.entityId || !c.fieldName) continue;
    await store.insertPlanChangeLog(tx, {
      id: randomUUID(),
      phase_id: phaseId,
      entity_type: c.entityType,
      entity_id: c.entityId,
      field_name: c.fieldName,
      old_value: c.oldValue === undefined ? null : c.oldValue,
      new_value: c.newValue === undefined ? null : c.newValue,
      actor_party_id: actorPartyId ?? null,
      occurred_at: occurredAt,
    });
  }
}