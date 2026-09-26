// Planning module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
import {
  getSchedule, getTask, getScheduleHealth,
  createTask, updateTask, recordActual, previewMove, applySchedule,
  createLink, updateLink, deleteLink,
  listCostLines, createCostLine, updateCostLine, deleteCostLine,
  listVariations, getVariation, acknowledgeVariation, questionVariation,
  reportProgress, listProgress,
} from '../application/use-cases.mjs';

/**
 * @param {{ store: object }} deps
 */
export function registerPlanning(router, { store }) {
  router.register('GET', '/projects/{projectId}/schedule', 'getSchedule', ({ viewer, params, query }) =>
    getSchedule({ viewer, store, projectId: params.projectId, query }));

  router.register('GET', '/projects/{projectId}/schedule/health', 'getPlanHealth', ({ viewer, params, query }) =>
    getScheduleHealth({ viewer, store, projectId: params.projectId, query }));

  router.register('POST', '/projects/{projectId}/tasks', 'createTask', ({ viewer, params, body, headers }) =>
    createTask({ viewer, store, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

  router.register('GET', '/tasks/{taskId}', 'getTask', ({ viewer, params }) =>
    getTask({ viewer, store, taskId: params.taskId }));

  router.register('PATCH', '/tasks/{taskId}', 'updateTask', ({ viewer, params, body }) =>
    updateTask({ viewer, store, taskId: params.taskId, body }));

  router.register('POST', '/tasks/{taskId}:preview-move', 'previewMove', ({ viewer, params, body }) =>
    previewMove({ viewer, store, taskId: params.taskId, body }));

  router.register('POST', '/tasks/{taskId}:record-actual', 'recordActual', ({ viewer, params, body }) =>
    recordActual({ viewer, store, taskId: params.taskId, body }));

  router.register('POST', '/projects/{projectId}/schedule:apply', 'applySchedule', ({ viewer, params, body, headers }) =>
    applySchedule({ viewer, store, projectId: params.projectId, body, idempotencyKey: headers['idempotency-key'] ?? null }));

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

  router.register('POST', '/variations/{variationId}:question', 'questionVariation', ({ viewer, params, body }) =>
    questionVariation({ viewer, store, variationId: params.variationId, body }));

  router.register('POST', '/tasks/{taskId}/progress', 'reportProgress', ({ viewer, params, body }) =>
    reportProgress({ viewer, store, taskId: params.taskId, body }));

  router.register('GET', '/tasks/{taskId}/progress', 'listProgress', ({ viewer, params }) =>
    listProgress({ viewer, store, taskId: params.taskId }));
}
