// Baselines in the plan header (PRD-10 E-1): the list the selector shows and
// the snapshot getSchedule draws against a chosen one. D-24 — a baseline is a
// label on a branch (one per contract version), never a page of its own.
import { ProblemError } from '../../../platform/errors.mjs';
import { baselineList, rebaseOn } from '../domain/baselines.mjs';
import { requireParticipant } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The contract chain a row sits in: its branch and every branch above it. */
function branchChain(snapshot, task) {
  const out = new Set();
  let id = task.branchContractId ?? task.contractId ?? null;
  while (id && !out.has(id)) {
    out.add(id);
    id = snapshot.contracts.get(id)?.parentContractId ?? null;
  }
  return out;
}

/** operationId: listBaselines */
export async function listBaselines({ viewer, store, projectId, query }) {
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId });
  let rows = await store.listBaselines(projectId);
  const snapshot = await store.loadPlan(projectId);
  if (query?.root) {
    const task = snapshot.tasks.get(query.root);
    if (!task) throw new ProblemError('not_found', 'no such row in this plan');
    const chain = branchChain(snapshot, task);
    rows = rows.filter((b) => chain.has(b.contract_id));
  }
  return { status: 200, body: { items: baselineList(rows, snapshot.orgNames), next_cursor: null } };
}

/**
 * The plan snapshot drawn against `baselineId` (getSchedule ?baseline=), or the
 * snapshot unchanged without one. 404 for an id that is not a baseline of this
 * project — the viewer learns nothing about other builds.
 */
export async function comparedSnapshot({ store, projectId, snapshot, baselineId }) {
  if (!baselineId) return { snapshot, comparedTo: null };
  if (!UUID.test(baselineId) || !store.getBaselineSnapshot) throw new ProblemError('not_found', 'no such baseline on this build');
  const chosen = await store.getBaselineSnapshot(projectId, baselineId);
  if (!chosen) throw new ProblemError('not_found', 'no such baseline on this build');
  return {
    snapshot: { ...snapshot, tasks: rebaseOn(snapshot.tasks, chosen) },
    comparedTo: {
      baseline_id: chosen.id,
      contract_id: chosen.contract_id,
      version: chosen.version,
      reason: chosen.reason,
      taken_at: chosen.taken_at_iso,
    },
  };
}
