// Collaboration domain (docs 08 §Collaboration, 09) — pure: the question and
// minute lifecycles, comment object vocabulary, wire bodies. No I/O.

// Objects a thread can hang off (doc 08: "any object reference") — the set
// this module knows how to anchor to a project and check readers for.
export const THREAD_OBJECT_TYPES = Object.freeze([
  'project', 'task', 'contract', 'variation', 'change_order', 'measurement',
  'nonconformity', 'rfp', 'proposal', 'document', 'minute',
]);

/** Question lifecycle (doc 09): open → answered → resolved. */
export function questionTransition(status, action) {
  const legal = {
    answer: { open: 'answered' },
    resolve: { answered: 'resolved' },
  };
  const to = legal[action]?.[status];
  if (!to) {
    return {
      ok: false,
      reason: action === 'resolve' && status === 'open'
        ? 'a question resolves after it was answered — answer it first'
        : `cannot ${action} a question in ${status}`,
    };
  }
  return { ok: true, to };
}

/** Minute lifecycle (doc 09): draft → circulated → acknowledged (all orgs). */
export function minuteTransition(status, action) {
  const legal = {
    circulate: { draft: 'circulated' },
    acknowledge: { circulated: 'circulated' }, // stays until every org acked
  };
  const to = legal[action]?.[status];
  if (!to) return { ok: false, reason: `cannot ${action} a minute in ${status}` };
  return { ok: true, to };
}

/** Wire body (schema Comment). Tombstones keep the slot, never the words. */
export function commentBody(row) {
  const deleted = row.deleted_at != null;
  return {
    id: row.id,
    object_type: row.object_type,
    object_id: row.object_id,
    kind: row.kind,
    body: deleted ? '' : row.body,
    author: { person_id: row.author_person_id, org_id: row.author_org_id },
    ...(row.addressee_org_id ? { addressee_org_id: row.addressee_org_id } : {}),
    ...(row.question_status ? { question_status: row.question_status } : {}),
    ...(row.answers_comment_id ? { answers_comment_id: row.answers_comment_id } : {}),
    ...(row.attachment_document_ids?.length ? { attachment_ids: row.attachment_document_ids } : {}),
    created_at: row.created_at,
    deleted,
  };
}

/** Wire body (schema MeetingMinute). */
export function minuteBody(row, items = [], acks = []) {
  return {
    id: row.id,
    date: dateOnly(row.date),
    attendees: row.attendees,
    items: items.map((i) => ({
      text: i.text,
      ...(i.owner_org_id ? { owner_org_id: i.owner_org_id } : {}),
      ...(i.due_date ? { due_date: dateOnly(i.due_date) } : {}),
      ...(i.object_type ? { object_type: i.object_type, object_id: i.object_id } : {}),
    })),
    status: row.status,
    acks: acks.map((a) => ({ org_id: a.org_id, person_id: a.person_id, at: a.at })),
  };
}

/** Wire body (schema Notification). */
export function notificationBody(row) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    object_ref: row.object_ref,
    created_at: row.created_at,
    read_at: row.read_at ?? null,
  };
}

/** Wire body (schema ActivityItem) from one outbox envelope. */
export function activityItem(evt) {
  return {
    event_id: evt.event_id,
    type: evt.type,
    occurred_at: evt.occurred_at,
    actor: { person_id: evt.actor?.person_id ?? null, org_id: evt.actor?.org_id ?? null },
    summary: summarize(evt),
    object_type: evt.scope?.type ?? null,
    object_id: evt.scope?.id ?? null,
  };
}

/** A terse, human-shaped line; the UI localises richer copy from `type`. */
function summarize(evt) {
  const what = evt.type.split('.').slice(1).join(' ').replace(/_/g, ' ');
  const name = evt.data?.title ?? evt.data?.name ?? null;
  return name ? `${what}: ${name}` : what;
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
