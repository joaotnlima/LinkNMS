// Record module use cases (the audit ledger, read side) — one function per
// operationId. The ledger is written by every producing module inside its own
// transaction; this module only READS it.
//
// Authorization is the doc-16 conjunction: relationship (project.participant)
// ∧ staffing. There is no extra Clerk permission on the record surface
// (openapi: "none beyond an authenticated session") — being a staffed
// participant is the whole gate. Redaction (V7) then narrows CONTENT within an
// allowed read: the store tags each row `visible`, domain/redaction.mjs shapes
// it. 404 (not 403) for a non-participant: a project's existence is not theirs
// to learn.
import { ProblemError } from '../../../platform/errors.mjs';
import { toRecordPage } from '../domain/redaction.mjs';

/** operationId: listRecord — GET /projects/{projectId}/record */
export async function listRecord({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const { rows, nextCursor } = await store.listEvents({
    projectId,
    orgId: viewer.orgId,
    objectType: query?.object_type ?? null,
    objectId: parseObjectId(query?.object_id),
    cursorSeq: parseCursor(query?.cursor),
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: toRecordPage(rows, nextCursor) };
}

/** operationId: verifyRecord — POST /projects/{projectId}/record:verify */
export async function verifyRecord({ viewer, store, projectId }) {
  await requireParticipant({ viewer, store, projectId });
  const result = await store.verifyChain(projectId);
  return {
    status: 200,
    body: {
      valid: result.valid,
      length: result.length,
      head: result.head,
      first_invalid_seq: result.first_invalid_seq,
    },
  };
}

// ── authz (mirrors modules/project/application/use-cases.mjs) ────────────────

function requireActiveOrg(viewer) {
  if (!viewer.orgId) {
    throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
  }
}

function seesWholeOrg(viewer) {
  return viewer.orgRole === 'admin' || viewer.orgRole === 'manager';
}

/** relationship: project.participant (∧ staffing for non-managers). */
async function requireParticipant({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const related = project.owner_org_id === viewer.orgId
    || project.created_by_org_id === viewer.orgId
    || (await store.isParticipant(projectId, viewer.orgId));
  if (!related) throw new ProblemError('not_found'); // 404, not 403
  if (!seesWholeOrg(viewer)) {
    const person = await store.getPersonByClerkId(viewer.clerkUserId);
    if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
    if (!(await store.isStaffed(projectId, viewer.orgId, person.id))) {
      throw new ProblemError('not_a_participant', 'you are not staffed on this project');
    }
  }
  return { project };
}

// ── query parsing ───────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

/** The cursor is the last seq of the previous page. Ignore anything that is
 *  not a positive integer rather than 422 — a stale cursor just restarts. */
function parseCursor(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? String(n) : null;
}

/** object_id is an optional drill-down filter; a non-uuid is a 422. */
function parseObjectId(raw) {
  if (raw == null || raw === '') return null;
  if (!UUID.test(raw)) throw new ProblemError('validation_failed', null, { errors: { object_id: 'must be a uuid' } });
  return raw;
}
