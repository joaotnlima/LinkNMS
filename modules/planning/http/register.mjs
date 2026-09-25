// Planning module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
import {
  getSchedule, getTask, getScheduleHealth,
  createTask, updateTask, recordActual, previewMove, applySchedule,
  createLink, updateLink, deleteLink,
} from '../application/use-cases.mjs';

/**
 * @param {{ store: object }} deps
 */
export function registerPlanning(router, { store }) {
  router.register('GET', '/projects/{projectId}/schedule', 'getSchedule', ({ viewer, params, query }) =>
    getSchedule({ viewer, store, projectId: params.projectId, query }));

  router.register('GET', '/projects/{projectId}/schedule/health', 'getScheduleHealth', ({ viewer, params, query }) =>
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
}
