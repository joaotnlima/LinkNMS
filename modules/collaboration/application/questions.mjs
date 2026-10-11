// The build's questions and minutes (PRD-12 N-5, N-6; flows C16–C17) — one
// function per operationId: listProjectQuestions, listMinutes.
//
// Relationship: project.participant (∧ staffing). A thread's visibility is its
// object's (doc 08), and a contract or tender thread is not every
// participant's to read — so the build's question list is the exchanges the
// viewer's organisation is PART of (asker or addressee), never someone else's.
// That is exactly the architect's queue (addressed: clarifications and
// design-change approvals), the owner's scope gaps (addressed), and what the
// organisation is waiting on (asked).
//
// Minutes are project-scoped objects every participant reads; a draft is not
// yet part of the record and stays with the organisation writing it.
import { ProblemError } from '../../../platform/errors.mjs';
import { QUESTION_TOPICS } from '../domain/coordination.mjs';
import { requireParticipant, projectComment, projectMinute, clampLimit, uuidOrNull } from './use-cases.mjs';

const ROLES = new Set(['addressed', 'asked', 'all']);
const STATUSES = new Set(['open', 'answered', 'resolved']);

/** operationId: listProjectQuestions — newest first. */
export async function listProjectQuestions({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const errors = {};
  const role = query?.role ?? 'all';
  if (!ROLES.has(role)) errors.role = 'addressed, asked or all';
  if (query?.status !== undefined && !STATUSES.has(query.status)) errors.status = 'open, answered or resolved';
  if (query?.topic !== undefined && !QUESTION_TOPICS.includes(query.topic)) errors.topic = QUESTION_TOPICS.join(', ');
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const { items, nextCursor } = await store.listProjectQuestions({
    projectId,
    orgId: viewer.orgId,
    role,
    status: query?.status ?? null,
    topic: query?.topic ?? null,
    cursor: cursorOf(query?.cursor),
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map((c) => projectComment(c, viewer)), next_cursor: nextCursor } };
}

/** operationId: listMinutes — newest meeting first; drafts only for their writer. */
export async function listMinutes({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const { items, nextCursor } = await store.listMinutes({
    projectId,
    orgId: viewer.orgId,
    cursor: cursorOf(query?.cursor),
    limit: clampLimit(query?.limit),
  });
  const parts = await store.minutesParts(items.map((m) => m.id));
  return {
    status: 200,
    body: {
      items: items.map((m) => projectMinute(m, parts.get(m.id) ?? { items: [], acks: [] }, viewer)),
      next_cursor: nextCursor,
    },
  };
}

/** Keyset cursor `<sort key>~<uuid>`; anything else starts from the top. */
function cursorOf(raw) {
  if (typeof raw !== 'string') return null;
  const [key, id] = raw.split('~');
  return key && uuidOrNull(id) && !Number.isNaN(Date.parse(key)) ? { key, id } : null;
}
