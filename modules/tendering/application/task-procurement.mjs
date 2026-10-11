// Tendering query: the per-task procurement projection of a project
// (operationId listTaskProcurement, PRD-01 G-2/G-3, LINA-413).
//
// The plan's Tender column and Gantt band read this ONE projection instead of
// composing it client-side from the RFP list plus a lanes read per tendered row.
//
// Authorization (doc 16 conjunction): no Clerk permission beyond a session (the
// same as the lanes read it replaces) ∧ relationship project.participant (a
// non-party gets 404 — existence hiding) ∧ staffing. The ITEMS are then scoped
// to RFPs the viewer's org issued — the store applies that in SQL (V8: a
// participant never reads another org's tender or lanes through this). No money
// is read or returned (D-06/D-07).
import { requireParticipant } from './use-cases.mjs';
import { taskProcurement } from '../domain/task-procurement.mjs';
import { withAwardedNames } from './project-rfps.mjs';
import { clampLimit, decodeKey, encodeKey, UUID } from './paging.mjs';

/** operationId: listTaskProcurement — issuer's tenders on the project, per root task. */
export async function listTaskProcurement({ viewer, store, orgs = null, projectId, query = {} }) {
  await requireParticipant({ viewer, store, projectId });
  // Keyset on the root task id: a page carries every tender of its tasks.
  const after = decodeKey(query?.cursor, (k) => UUID.test(k.task_id ?? ''));
  const { items, nextTaskId } = await store.taskProcurementOfProject(projectId, viewer.orgId, {
    afterTaskId: after?.task_id ?? null, limit: clampLimit(query?.limit, { fallback: 200 }),
  });
  const rows = await withAwardedNames(orgs, items);
  return {
    status: 200,
    body: { items: taskProcurement(rows), next_cursor: encodeKey(nextTaskId ? { task_id: nextTaskId } : null) },
  };
}
