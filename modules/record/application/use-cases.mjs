// Record module use cases (the Record tag) — one function per operationId.
//
// Authorization is the doc-16 conjunction:
//   permission (none beyond an authenticated session — the ledger read is
//     open to any participant, openapi x-relationship project.participant)
//   ∧ relationship (a participation row for the viewer's org, or the org owns
//     or created the project — the same rule as project reads)
//   ∧ staffing (doc 16 §4: admins/managers see every project of their org;
//     everyone else only projects they are staffed on).
//
// This module only READS the ledger. The withholding of out-of-scope payloads
// (V7) is done in the store's SQL; here we shape the page and guard access.
import { ProblemError } from '../../../platform/errors.mjs';
import { toAuditEntry } from './audit-view.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * operationId: listRecord — the ledger of a project, projected for the viewer
 * (out-of-scope entries redacted), newest first, cursor-paginated.
 */
export async function listRecord({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });

  const objectType = query?.object_type?.trim() || null;
  const objectId = query?.object_id?.trim() || null;
  // A malformed object_id is a client error, not an empty page: the column is a
  // uuid and passing a non-uuid would error in the driver.
  if (objectId && !UUID.test(objectId)) {
    throw new ProblemError('validation_failed', 'object_id must be a UUID', { errors: { object_id: 'must be a UUID' } });
  }

  const { items, nextCursor } = await store.listAuditEntries(projectId, viewer.orgId, {
    objectType,
    objectId,
    cursor: parseCursor(query?.cursor),
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(toAuditEntry), next_cursor: nextCursor } };
}

/** relationship: project.participant (∧ staffing for non-managers). Mirrors the
 *  project module's gate — 404 (never 403) so a non-participant does not learn
 *  the project exists. */
async function requireParticipant({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const related = project.owner_org_id === viewer.orgId
    || project.created_by_org_id === viewer.orgId
    || (await store.isParticipant(projectId, viewer.orgId));
  if (!related) throw new ProblemError('not_found');
  if (!seesWholeOrg(viewer)) {
    const person = await store.getPersonByClerkId(viewer.clerkUserId);
    if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
    if (!(await store.isStaffed(projectId, viewer.orgId, person.id))) {
      throw new ProblemError('not_a_participant', 'you are not staffed on this project');
    }
  }
}

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

function seesWholeOrg(viewer) {
  return viewer.orgRole === 'admin' || viewer.orgRole === 'manager';
}

/** The cursor is the seq of the last row of the previous page (a positive
 *  integer). Anything else is ignored — a bad cursor reads as "from the top",
 *  not an error, matching the other v2 list reads. */
function parseCursor(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}
