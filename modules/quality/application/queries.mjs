// Quality reads for the build's quality page (PRD-12 N-3, N-4) — one function
// per operationId: listNonConformities, listInspections.
//
// Relationship: project.participant (∧ staffing) — the same rule as reading
// the build; a non-participant learns nothing (404). Non-conformities and
// inspections are plan-side records (V1): every participant reads them. Each
// non-conformity carries the viewer's next steps (`actions`), computed by the
// same domain rules the commands enforce.
import { ProblemError } from '../../../platform/errors.mjs';
import { inspectionBody } from '../domain/lifecycle.mjs';
import { requireParticipant, projectNonConformity, clampLimit } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NC_STATUSES = new Set(['active', 'all', 'open', 'assigned', 'fixed', 'rejected_fix', 'closed']);
const KINDS = new Set(['quality', 'safety']);

/** operationId: listNonConformities — newest first; default `active` (not closed). */
export async function listNonConformities({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const errors = {};
  const status = query?.status ?? 'active';
  if (!NC_STATUSES.has(status)) errors.status = [...NC_STATUSES].join(', ');
  if (query?.kind !== undefined && !KINDS.has(query.kind)) errors.kind = 'quality or safety';
  if (query?.task_id !== undefined && !UUID.test(query.task_id)) errors.task_id = 'a task id';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const { items, nextCursor } = await store.listNonConformities({
    projectId,
    status,
    kind: query?.kind ?? null,
    taskId: query?.task_id ?? null,
    cursor: cursorOf(query?.cursor),
    limit: clampLimit(query?.limit),
  });
  const body = [];
  for (const nc of items) body.push(await projectNonConformity({ viewer, store, nc }));
  return { status: 200, body: { items: body, next_cursor: nextCursor } };
}

/** operationId: listInspections — newest inspection date first. */
export async function listInspections({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const errors = {};
  if (query?.task_id !== undefined && !UUID.test(query.task_id)) errors.task_id = 'a task id';
  if (query?.location_id !== undefined && !UUID.test(query.location_id)) errors.location_id = 'a location id';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const { items, nextCursor } = await store.listInspections({
    projectId,
    taskId: query?.task_id ?? null,
    locationId: query?.location_id ?? null,
    cursor: cursorOf(query?.cursor),
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(inspectionBody), next_cursor: nextCursor } };
}

/** Keyset cursor `<sort key>~<uuid>`; anything else starts from the top. */
function cursorOf(raw) {
  if (typeof raw !== 'string') return null;
  const [key, id] = raw.split('~');
  return key && UUID.test(id ?? '') && !Number.isNaN(Date.parse(key)) ? { key, id } : null;
}
