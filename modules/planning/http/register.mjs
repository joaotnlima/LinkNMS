// Planning module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
import {
  getSchedule, getTask, getScheduleHealth, listAssignableParties,
  createTask, updateTask, recordActual, previewMove, applySchedule,
  createLink, updateLink, deleteLink,
  listCostLines, createCostLine, updateCostLine, deleteCostLine,
  listVariations, getVariation, acknowledgeVariation, questionVariation,
  reportProgress, listProgress,
  listSpecialtyLabels, createSpecialtyLabel,
  resolvePlanTemplate, savePlanTemplate,
} from '../application/use-cases.mjs';
import { acknowledgeVariations } from '../application/baseline-changes.mjs';
import { getTenderWindow, getPlanningSettings, putPlanningSettings } from '../application/tender-window.mjs';
import {
  listTaskDeliverables, listProjectDeliverables, createDeliverable, updateDeliverable, deleteDeliverable,
  submitDeliverable, approveDeliverable, requestDeliverableChanges,
} from '../application/deliverables.mjs';
import {
  uploadScheduleImport, getScheduleImport, mapScheduleImport, previewScheduleImport, confirmScheduleImport,
} from '../application/schedule-import.mjs';

/**
 * @param {{ store: object, documents?: { versionFacts: Function },
 *           specialties?: { exists: Function, list?: Function },
 *           workbooks?: { read: Function } }} deps
 *   `documents` — the documents query port: a deliverable submission binds a
 *   proven document version without planning reading documents.* (PRD-05).
 *   `specialties` — the directory's taxonomy port: a row's `specialty_code` is
 *   checked through it (PRD-03 R-2); without it a code is refused (422).
 *   `workbooks` — the .xlsx reader (infra/xlsx-reader.mjs) behind the Excel
 *   import (PRD-09); without it an upload answers 422 (unreadable).
 */
export function registerPlanning(router, { store, documents, specialties, workbooks = NO_WORKBOOKS }) {
  router.register('GET', '/projects/{projectId}/schedule', 'getSchedule', ({ viewer, params, query }) =>
    getSchedule({ viewer, store, projectId: params.projectId, query }));

  router.register('GET', '/projects/{projectId}/schedule/health', 'getPlanHealth', ({ viewer, params, query }) =>
    getScheduleHealth({ viewer, store, projectId: params.projectId, query }));

  // PRD-02: the plan side of a tender (coverage, work window, critical path,
  // award-by) and the mobilisation lead it is computed with.
  router.register('GET', '/projects/{projectId}/schedule/tender-window', 'getTenderWindow', ({ viewer, params, query }) =>
    getTenderWindow({ viewer, store, projectId: params.projectId, query }));

  router.register('GET', '/projects/{projectId}/planning-settings', 'getPlanningSettings', ({ viewer, params }) =>
    getPlanningSettings({ viewer, store, projectId: params.projectId }));

  router.register('PUT', '/projects/{projectId}/planning-settings', 'putPlanningSettings', ({ viewer, params, body }) =>
    putPlanningSettings({ viewer, store, projectId: params.projectId, body }));

  router.register('GET', '/projects/{projectId}/assignable-parties', 'listAssignableParties', ({ viewer, params }) =>
    listAssignableParties({ viewer, store, projectId: params.projectId }));

  router.register('POST', '/projects/{projectId}/tasks', 'createTask', ({ viewer, params, body, headers }) =>
    createTask({ viewer, store, specialties, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/tasks/{taskId}', 'getTask', ({ viewer, params }) =>
    getTask({ viewer, store, taskId: params.taskId }));

  router.register('PATCH', '/tasks/{taskId}', 'updateTask', ({ viewer, params, body }) =>
    updateTask({ viewer, store, specialties, taskId: params.taskId, body }));

  router.register('POST', '/tasks/{taskId}:preview-move', 'previewMove', ({ viewer, params, body }) =>
    previewMove({ viewer, store, taskId: params.taskId, body }));

  router.register('POST', '/tasks/{taskId}:record-actual', 'recordActual', ({ viewer, params, body }) =>
    recordActual({ viewer, store, taskId: params.taskId, body }));

  router.register('POST', '/projects/{projectId}/schedule:apply', 'applySchedule', ({ viewer, params, body, headers }) =>
    applySchedule({ viewer, store, specialties, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('POST', '/tasks/{taskId}/links', 'createLink', ({ viewer, params, body }) =>
    createLink({ viewer, store, taskId: params.taskId, body }));

  router.register('PATCH', '/links/{linkId}', 'updateLink', ({ viewer, params, body }) =>
    updateLink({ viewer, store, linkId: params.linkId, body }));

  router.register('DELETE', '/links/{linkId}', 'deleteLink', ({ viewer, params }) =>
    deleteLink({ viewer, store, linkId: params.linkId }));

  // ── phase 5: cost lines / variations / progress ───────────────────────────
  router.register('GET', '/tasks/{taskId}/cost-lines', 'listCostLines', ({ viewer, params }) =>
    listCostLines({ viewer, store, taskId: params.taskId }));

  router.register('POST', '/tasks/{taskId}/cost-lines', 'createCostLine', ({ viewer, params, body }) =>
    createCostLine({ viewer, store, taskId: params.taskId, body }));

  router.register('PATCH', '/cost-lines/{costLineId}', 'updateCostLine', ({ viewer, params, body }) =>
    updateCostLine({ viewer, store, costLineId: params.costLineId, body }));

  router.register('DELETE', '/cost-lines/{costLineId}', 'deleteCostLine', ({ viewer, params }) =>
    deleteCostLine({ viewer, store, costLineId: params.costLineId }));

  router.register('GET', '/projects/{projectId}/variations', 'listVariations', ({ viewer, params, query }) =>
    listVariations({ viewer, store, projectId: params.projectId, query }));

  router.register('GET', '/variations/{variationId}', 'getVariation', ({ viewer, params }) =>
    getVariation({ viewer, store, variationId: params.variationId }));

  router.register('POST', '/variations/{variationId}:acknowledge', 'acknowledgeVariation', ({ viewer, params }) =>
    acknowledgeVariation({ viewer, store, variationId: params.variationId }));

  router.register('POST', '/projects/{projectId}/variations:acknowledge', 'acknowledgeVariations', ({ viewer, params, body, headers }) =>
    store.idempotent(
      { key: headers['idempotency-key'] ?? null, caller: viewer.clerkUserId, operationId: 'acknowledgeVariations', body },
      () => acknowledgeVariations({ viewer, store, projectId: params.projectId, body }),
    ));

  router.register('POST', '/variations/{variationId}:question', 'questionVariation', ({ viewer, params, body }) =>
    questionVariation({ viewer, store, variationId: params.variationId, body }));

  router.register('POST', '/tasks/{taskId}/progress', 'reportProgress', ({ viewer, params, body }) =>
    reportProgress({ viewer, store, taskId: params.taskId, body }));

  router.register('GET', '/tasks/{taskId}/progress', 'listProgress', ({ viewer, params }) =>
    listProgress({ viewer, store, taskId: params.taskId }));

  // ── PRD-05: deliverables of a task and their review (D-48 gate) ───────────
  router.register('GET', '/tasks/{taskId}/deliverables', 'listTaskDeliverables', ({ viewer, params }) =>
    listTaskDeliverables({ viewer, store, taskId: params.taskId }));

  router.register('POST', '/tasks/{taskId}/deliverables', 'createDeliverable', ({ viewer, params, body }) =>
    createDeliverable({ viewer, store, taskId: params.taskId, body }));

  router.register('GET', '/projects/{projectId}/deliverables', 'listProjectDeliverables', ({ viewer, params }) =>
    listProjectDeliverables({ viewer, store, projectId: params.projectId }));

  router.register('PATCH', '/deliverables/{deliverableId}', 'updateDeliverable', ({ viewer, params, body }) =>
    updateDeliverable({ viewer, store, deliverableId: params.deliverableId, body }));

  router.register('DELETE', '/deliverables/{deliverableId}', 'deleteDeliverable', ({ viewer, params }) =>
    deleteDeliverable({ viewer, store, deliverableId: params.deliverableId }));

  router.register('POST', '/deliverables/{deliverableId}:submit', 'submitDeliverable', ({ viewer, params, body }) =>
    submitDeliverable({ viewer, store, documents, deliverableId: params.deliverableId, body }));

  router.register('POST', '/deliverables/{deliverableId}:approve', 'approveDeliverable', ({ viewer, params, body }) =>
    approveDeliverable({ viewer, store, deliverableId: params.deliverableId, body }));

  router.register('POST', '/deliverables/{deliverableId}:request-changes', 'requestDeliverableChanges', ({ viewer, params, body }) =>
    requestDeliverableChanges({ viewer, store, deliverableId: params.deliverableId, body }));

  // ── PRD-09: the Excel plan import (O-6..O-12) ────────────────────────────
  router.register('POST', '/projects/{projectId}/schedule-imports', 'uploadScheduleImport', ({ viewer, params, body }) =>
    uploadScheduleImport({ viewer, store, workbooks, projectId: params.projectId, body }));

  router.register('GET', '/schedule-imports/{importId}', 'getScheduleImport', ({ viewer, params }) =>
    getScheduleImport({ viewer, store, specialties, importId: params.importId }));

  router.register('POST', '/schedule-imports/{importId}:map', 'mapScheduleImport', ({ viewer, params, body }) =>
    mapScheduleImport({ viewer, store, specialties, importId: params.importId, body }));

  router.register('POST', '/schedule-imports/{importId}:preview', 'previewScheduleImport', ({ viewer, params }) =>
    previewScheduleImport({ viewer, store, specialties, importId: params.importId }));

  router.register('POST', '/schedule-imports/{importId}:confirm', 'confirmScheduleImport', ({ viewer, params, headers }) =>
    confirmScheduleImport({ viewer, store, specialties, importId: params.importId, idempotencyKey: headers['idempotency-key'] ?? null }));

  // ── Specialty labels (LINA-380) — the plan's free-text picker. /specialties
  // is the directory taxonomy (PRD-03); the labels moved here.
  router.register('GET', '/specialty-labels', 'listSpecialtyLabels', ({ viewer }) =>
    listSpecialtyLabels({ viewer, store }));

  router.register('POST', '/specialty-labels', 'createSpecialtyLabel', ({ viewer, body }) =>
    createSpecialtyLabel({ viewer, store, body }));

  // Plan template "my default" (LINA-383) — per-person, project-independent,
  // names-only (LINA-241, ADR-0018). Gated on the identity mirror only (no org),
  // so it resolves the same whether or not an org is active.
  router.register('GET', '/me/plan-template', 'getPlanTemplate', ({ viewer }) =>
    resolvePlanTemplate({ viewer, store }));

  router.register('PUT', '/me/plan-template', 'savePlanTemplate', ({ viewer, body }) =>
    savePlanTemplate({ viewer, store, body }));
}

const NO_WORKBOOKS = Object.freeze({
  async read() { throw new Error('no workbook reader wired'); },
});
