// Collaboration module use cases (phase 7) — one function per operationId:
//   listComments, createComment, answerQuestion, resolveQuestion,
//   listMyQuestions, createMinute, circulateMinute, acknowledgeMinute,
//   listActivity, listNotifications, markNotificationsRead,
//   putNotificationPreferences.
//
// The contract asks for no Clerk permission beyond a session; authorization
// is relationships: a thread's visibility IS its object's (doc 08 — "anyone
// who can read the object" comments, doc 04 §3), questions belong to their
// addressee (answer) and their asker (resolve), minutes to the project's
// participants with circulate author-only and one ack per attending org.
// Existence hiding throughout: an object the viewer cannot read answers 404.
//
// The store owns transactions AND writes ledger + outbox inside them where
// doc 10 lists an event; a use case never half-commits.
import { ProblemError } from '../../../platform/errors.mjs';
import {
  THREAD_OBJECT_TYPES, questionTransition, minuteTransition,
  commentBody, minuteBody, notificationBody, activityItem,
} from '../domain/lifecycle.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const QUESTION_STATUSES = new Set(['open', 'answered', 'resolved']);
const CHANNELS = new Set(['in_app', 'email']);
const MAX_BODY = 8000;

/** operationId: listComments — the object's thread, tombstones included. */
export async function listComments({ viewer, store, objectType, objectId, query }) {
  requireActiveOrg(viewer);
  await requireReadableObject({ viewer, store, objectType, objectId });
  const { items, nextCursor } = await store.listComments({
    objectType,
    objectId,
    cursor: uuidOrNull(query?.cursor),
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(commentBody), next_cursor: nextCursor } };
}

/** operationId: createComment — note, or question with an addressee (D-13). */
export async function createComment({ viewer, store, objectType, objectId, body }) {
  requireActiveOrg(viewer);
  const { projectId } = await requireReadableObject({ viewer, store, objectType, objectId });

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (body?.kind !== 'note' && body?.kind !== 'question') errors.kind = 'note or question';
  if (typeof body?.body !== 'string' || !body.body.trim()) errors.body = 'required';
  else if (body.body.length > MAX_BODY) errors.body = `at most ${MAX_BODY} characters`;
  const mentions = body?.mentions ?? [];
  if (!Array.isArray(mentions) || mentions.some((m) => !UUID.test(m ?? ''))) errors.mentions = 'a list of person ids';
  const attachments = body?.attachment_ids ?? [];
  if (!Array.isArray(attachments) || attachments.some((a) => !UUID.test(a ?? ''))) errors.attachment_ids = 'a list of document ids';
  if (body?.kind === 'question') {
    // The DB CHECK (kind = question ⇔ status present) backs this; the
    // addressee is what makes it a dispute channel and not a shout.
    if (!UUID.test(body?.addressee_org_id ?? '')) errors.addressee_org_id = 'a question is addressed to an organisation';
  } else if (body?.addressee_org_id !== undefined && body?.addressee_org_id !== null) {
    errors.addressee_org_id = 'only questions carry an addressee';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);

  // Client id = idempotency key.
  const existing = await store.getComment(body.id);
  if (existing) {
    if (existing.author_org_id === viewer.orgId && existing.object_id === objectId) {
      return { status: 201, body: commentBody(existing) };
    }
    throw new ProblemError('idempotency_mismatch', 'this id was already used by a different request');
  }

  const created = await store.createComment({
    id: body.id,
    objectType,
    objectId,
    projectId,
    kind: body.kind,
    body: body.body.trim(),
    mentions: [...new Set(mentions)],
    attachmentDocumentIds: [...new Set(attachments)],
    addresseeOrgId: body.kind === 'question' ? body.addressee_org_id : null,
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: commentBody(created) };
}

/** operationId: answerQuestion — addressee org only; open → answered. */
export async function answerQuestion({ viewer, store, commentId, body }) {
  requireActiveOrg(viewer);
  const question = await requireQuestion({ viewer, store, commentId });
  if (viewer.orgId !== question.addressee_org_id) {
    throw new ProblemError('forbidden', 'only the organisation the question is addressed to answers it', { reason: 'relationship' });
  }
  const outcome = questionTransition(question.question_status, 'answer');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (typeof body?.body !== 'string' || !body.body.trim()) errors.body = 'required';
  else if (body.body.length > MAX_BODY) errors.body = `at most ${MAX_BODY} characters`;
  const attachments = body?.attachment_ids ?? [];
  if (!Array.isArray(attachments) || attachments.some((a) => !UUID.test(a ?? ''))) errors.attachment_ids = 'a list of document ids';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);
  const answered = await store.answerQuestion({
    questionId: commentId,
    answerId: body.id,
    body: body.body.trim(),
    mentions: [...new Set(body?.mentions ?? [])],
    attachmentDocumentIds: [...new Set(attachments)],
    projectId: question.project_id,
    actor: actorOf(actor, viewer),
  });
  if (!answered) throw new ProblemError('invalid_transition', 'someone answered this question first');
  return { status: 201, body: commentBody(answered) };
}

/** operationId: resolveQuestion — asker only; answered → resolved. */
export async function resolveQuestion({ viewer, store, commentId }) {
  requireActiveOrg(viewer);
  const question = await requireQuestion({ viewer, store, commentId });
  if (viewer.orgId !== question.author_org_id) {
    throw new ProblemError('forbidden', 'only the organisation that asked resolves its question', { reason: 'relationship' });
  }
  const outcome = questionTransition(question.question_status, 'resolve');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  const resolved = await store.resolveQuestion({
    questionId: commentId,
    projectId: question.project_id,
    actor: actorOf(actor, viewer),
  });
  if (!resolved) throw new ProblemError('invalid_transition', 'someone moved this question first');
  return { status: 200, body: commentBody(resolved) };
}

/** operationId: listMyQuestions — the active org's addressee queue. */
export async function listMyQuestions({ viewer, store, query }) {
  requireActiveOrg(viewer);
  if (query?.status !== undefined && !QUESTION_STATUSES.has(query.status)) {
    throw new ProblemError('validation_failed', null, { errors: { status: 'open, answered or resolved' } });
  }
  const { items, nextCursor } = await store.listMyQuestions({
    orgId: viewer.orgId,
    // The queue defaults to what still needs an answer.
    status: query?.status ?? 'open',
    cursor: uuidOrNull(query?.cursor),
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(commentBody), next_cursor: nextCursor } };
}

/** operationId: createMinute — draft ata de obra; participant writes it. */
export async function createMinute({ viewer, store, projectId, body }) {
  requireActiveOrg(viewer);
  await requireParticipant({ viewer, store, projectId });

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!DATE_ONLY.test(body?.date ?? '')) errors.date = 'YYYY-MM-DD required';
  const attendees = body?.attendees ?? [];
  if (!Array.isArray(attendees) || !attendees.length || attendees.some((a) => !UUID.test(a ?? ''))) {
    errors.attendees = 'the organisations present, at least one';
  }
  const items = body?.items ?? [];
  if (!Array.isArray(items)
      || items.some((i) => !i || typeof i !== 'object'
        || typeof i.text !== 'string' || !i.text.trim()
        || (i.owner_org_id != null && !UUID.test(i.owner_org_id))
        || (i.due_date != null && !DATE_ONLY.test(i.due_date))
        || ((i.object_type != null) !== (i.object_id != null))
        || (i.object_id != null && !UUID.test(i.object_id)))) {
    errors.items = 'a list of {text, owner_org_id?, due_date?, object_type?+object_id?}';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const actor = await requireActor(store, viewer);
  const existing = await store.getMinute(body.id);
  if (existing) {
    if (existing.created_by_org_id === viewer.orgId && existing.project_id === projectId) {
      const parts = await store.minuteParts(body.id);
      return { status: 201, body: minuteBody(existing, parts.items, parts.acks) };
    }
    throw new ProblemError('idempotency_mismatch', 'this id was already used by a different request');
  }

  const created = await store.createMinute({
    id: body.id,
    projectId,
    date: body.date,
    attendees: [...new Set(attendees)],
    items: items.map((i) => ({
      text: i.text.trim(),
      owner_org_id: i.owner_org_id ?? null,
      due_date: i.due_date ?? null,
      object_type: i.object_type ?? null,
      object_id: i.object_id ?? null,
    })),
    actor: actorOf(actor, viewer),
  });
  const parts = await store.minuteParts(body.id);
  return { status: 201, body: minuteBody(created, parts.items, parts.acks) };
}

/** operationId: circulateMinute — author only; draft → circulated. */
export async function circulateMinute({ viewer, store, minuteId }) {
  requireActiveOrg(viewer);
  const minute = await requireMinute({ viewer, store, minuteId });
  if (!minute.created_by_org_id || minute.created_by_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the organisation that wrote the minute circulates it', { reason: 'relationship' });
  }
  const outcome = minuteTransition(minute.status, 'circulate');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const updated = await store.circulateMinute({ minuteId });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this minute first');
  const parts = await store.minuteParts(minuteId);
  return { status: 200, body: minuteBody(updated, parts.items, parts.acks) };
}

/** operationId: acknowledgeMinute — attendee org; replays are absorbed. */
export async function acknowledgeMinute({ viewer, store, minuteId }) {
  requireActiveOrg(viewer);
  const minute = await requireMinute({ viewer, store, minuteId });
  if (!minute.attendees.includes(viewer.orgId)) {
    throw new ProblemError('forbidden', 'only an organisation that attended acknowledges', { reason: 'relationship' });
  }
  const outcome = minuteTransition(minute.status, 'acknowledge');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.acknowledgeMinute({
    minuteId,
    projectId: minute.project_id,
    actor: actorOf(actor, viewer),
  });
  const parts = await store.minuteParts(minuteId);
  return { status: 200, body: minuteBody(updated, parts.items, parts.acks) };
}

/** operationId: listActivity — the outbox projection, viewer-filtered. */
export async function listActivity({ viewer, store, projectId, query }) {
  requireActiveOrg(viewer);
  await requireParticipant({ viewer, store, projectId });
  if (query?.since !== undefined && Number.isNaN(Date.parse(query.since))) {
    throw new ProblemError('validation_failed', null, { errors: { since: 'an ISO timestamp' } });
  }
  const { items, nextCursor } = await store.listActivity({
    projectId,
    orgId: viewer.orgId,
    cursor: query?.cursor ?? null,
    since: query?.since ?? null,
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(activityItem), next_cursor: nextCursor } };
}

/** operationId: listNotifications — mine, newest first. */
export async function listNotifications({ viewer, store, query }) {
  const actor = await requireActor(store, viewer);
  const { items, nextCursor } = await store.listNotifications({
    personId: actor.id,
    unread: query?.unread === 'true' || query?.unread === '1',
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(notificationBody), next_cursor: nextCursor } };
}

/** operationId: markNotificationsRead — {ids} or {all:true}; 204. */
export async function markNotificationsRead({ viewer, store, body }) {
  const ids = body?.ids ?? [];
  const all = body?.all === true;
  if (!all && (!Array.isArray(ids) || !ids.length || ids.some((i) => !UUID.test(i ?? '')))) {
    throw new ProblemError('validation_failed', null, { errors: { ids: 'a list of notification ids, or all: true' } });
  }
  const actor = await requireActor(store, viewer);
  await store.markNotificationsRead({ personId: actor.id, ids, all });
  return { status: 204, body: null };
}

/** operationId: putNotificationPreferences — replace-by-upsert, answer all. */
export async function putNotificationPreferences({ viewer, store, body }) {
  const items = Array.isArray(body) ? body : body?.items;
  if (!Array.isArray(items) || !items.length
      || items.some((p) => !p || typeof p !== 'object'
        || typeof p.category !== 'string' || !p.category.trim()
        || !CHANNELS.has(p.channel) || typeof p.enabled !== 'boolean')) {
    throw new ProblemError('validation_failed', null, {
      errors: { items: 'a list of {category, channel: in_app|email, enabled}' },
    });
  }
  const actor = await requireActor(store, viewer);
  const saved = await store.putPreferences({
    personId: actor.id,
    items: items.map((p) => ({ category: p.category.trim(), channel: p.channel, enabled: p.enabled })),
  });
  return { status: 200, body: { items: saved, next_cursor: null } };
}

// ── shared helpers ───────────────────────────────────────────────────────

/** Resolve + read-check an object; 404 hides both absence and no-access. */
async function requireReadableObject({ viewer, store, objectType, objectId }) {
  if (!THREAD_OBJECT_TYPES.includes(objectType) || !UUID.test(objectId ?? '')) {
    throw new ProblemError('not_found');
  }
  const anchor = await store.resolveObject(objectType, objectId);
  if (!anchor) throw new ProblemError('not_found');
  if (!(await store.canReadObject({ objectType, objectId, orgId: viewer.orgId }))) {
    throw new ProblemError('not_found');
  }
  return anchor;
}

/** Load a question the viewer can read; 404 for everything else. */
async function requireQuestion({ viewer, store, commentId }) {
  const comment = await store.getComment(commentId);
  if (!comment || comment.kind !== 'question' || comment.deleted_at) throw new ProblemError('not_found');
  await requireReadableObject({ viewer, store, objectType: comment.object_type, objectId: comment.object_id });
  return comment;
}

/** Load a minute with participant check (they are project-scoped objects). */
async function requireMinute({ viewer, store, minuteId }) {
  const minute = await store.getMinute(minuteId);
  if (!minute) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: minute.project_id });
  return minute;
}

async function requireParticipant({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  if (!(await store.isParticipant(projectId, viewer.orgId))) {
    // 404, not 403: a non-participant does not learn the project exists.
    throw new ProblemError('not_found');
  }
  if (!(viewer.orgRole === 'admin' || viewer.orgRole === 'manager')) {
    const actor = await requireActor(store, viewer);
    if (!(await store.isStaffed(projectId, viewer.orgId, actor.id))) {
      throw new ProblemError('not_a_participant', 'you are not staffed on this project');
    }
  }
}

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

async function requireActor(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

function actorOf(person, viewer) {
  return { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
}

function uuidOrNull(raw) {
  return raw !== undefined && UUID.test(raw) ? raw : null;
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}
