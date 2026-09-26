// Collaboration module on the /api/v2 router — route strings verbatim from
// cowork/documentation/api/v2/openapi.yaml (greppable, AGENT-INDEX §7).
// Phase 7 surface: the whole Collaboration tag — threads (notes + addressed
// questions), meeting minutes, the activity feed, notifications.
import {
  listComments, createComment, answerQuestion, resolveQuestion,
  listMyQuestions, createMinute, circulateMinute, acknowledgeMinute,
  listActivity, listNotifications, markNotificationsRead,
  putNotificationPreferences,
} from '../application/use-cases.mjs';

/**
 * @param {{ store: object }} deps
 */
export function registerCollaboration(router, { store }) {
  router.register('GET', '/threads/{objectType}/{objectId}/comments', 'listComments', ({ viewer, params, query }) =>
    listComments({ viewer, store, objectType: params.objectType, objectId: params.objectId, query }));

  router.register('POST', '/threads/{objectType}/{objectId}/comments', 'createComment', ({ viewer, params, body }) =>
    createComment({ viewer, store, objectType: params.objectType, objectId: params.objectId, body }));

  router.register('POST', '/comments/{commentId}:answer', 'answerQuestion', ({ viewer, params, body }) =>
    answerQuestion({ viewer, store, commentId: params.commentId, body }));

  router.register('POST', '/comments/{commentId}:resolve', 'resolveQuestion', ({ viewer, params }) =>
    resolveQuestion({ viewer, store, commentId: params.commentId }));

  router.register('GET', '/me/questions', 'listMyQuestions', ({ viewer, query }) =>
    listMyQuestions({ viewer, store, query }));

  router.register('POST', '/projects/{projectId}/minutes', 'createMinute', ({ viewer, params, body }) =>
    createMinute({ viewer, store, projectId: params.projectId, body }));

  router.register('POST', '/minutes/{minuteId}:circulate', 'circulateMinute', ({ viewer, params }) =>
    circulateMinute({ viewer, store, minuteId: params.minuteId }));

  router.register('POST', '/minutes/{minuteId}:acknowledge', 'acknowledgeMinute', ({ viewer, params }) =>
    acknowledgeMinute({ viewer, store, minuteId: params.minuteId }));

  router.register('GET', '/projects/{projectId}/activity', 'listActivity', ({ viewer, params, query }) =>
    listActivity({ viewer, store, projectId: params.projectId, query }));

  router.register('GET', '/me/notifications', 'listNotifications', ({ viewer, query }) =>
    listNotifications({ viewer, store, query }));

  router.register('POST', '/notifications:mark-read', 'markNotificationsRead', ({ viewer, body }) =>
    markNotificationsRead({ viewer, store, body }));

  router.register('PUT', '/me/notification-preferences', 'putNotificationPreferences', ({ viewer, body }) =>
    putNotificationPreferences({ viewer, store, body }));
}
