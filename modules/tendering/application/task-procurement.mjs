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

/** operationId: listTaskProcurement — issuer's tenders on the project, per root task. */
export async function listTaskProcurement({ viewer, store, projectId }) {
  await requireParticipant({ viewer, store, projectId });
  const rows = await store.taskProcurementOfProject(projectId, viewer.orgId);
  return { status: 200, body: { items: taskProcurement(rows) } };
}
