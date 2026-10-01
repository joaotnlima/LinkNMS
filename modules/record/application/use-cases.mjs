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
import { createHash, randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { toRecordPage } from '../domain/redaction.mjs';
import { buildRecordExport, exportFileName } from '../domain/export.mjs';
// Pure document helpers reused verbatim — the export persists through the
// documents module (createDocument + R2), so its wire body and storage-key
// shape come from there, never re-derived.
import { storageKey, documentBody } from '../../documents/domain/model.mjs';

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

/**
 * operationId: exportRecord — POST /projects/{projectId}/record:export (202).
 *
 * Project the WHOLE ledger exactly as listRecord does (V7 redaction — this
 * org's view), stamp the chain-verification report into the header so the
 * artefact proves itself, then persist it as a real documents.document + R2
 * version through the documents module. The document is private to the
 * requesting org: a co-participant with narrower access must not download a
 * projection made for a broader one.
 *
 * @param {{ viewer: object, store: object, projectId: string,
 *           documents: { store: object, storage: object } }} deps
 */
export async function exportRecord({ viewer, store, projectId, documents }) {
  const { project } = await requireParticipant({ viewer, store, projectId });
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');

  const verification = await store.verifyChain(projectId);
  const rows = await store.listAllEvents({ projectId, orgId: viewer.orgId });

  const generatedAt = new Date().toISOString();
  const artefact = buildRecordExport({
    projectId,
    projectName: project.name ?? null,
    rows,
    verification,
    generatedAt,
    actor: { person_id: person.id, org_id: viewer.orgId, org_role: viewer.orgRole },
  });

  const bytes = Buffer.from(JSON.stringify(artefact, null, 2), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileName = exportFileName({ generatedAt });
  const documentId = randomUUID();
  const key = storageKey({ documentId, versionNo: 1, fileName, random: randomUUID() });

  // Bytes first — createDocument reserves the row, so the object must exist
  // before completeUpload proves it. The server owns these bytes (no client
  // PUT), so it uploads them directly; R2 verifies the pinned sha256.
  await documents.storage.put({ key, body: bytes, mime: 'application/json', sha256Hex: sha256 });

  const actor = { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
  await documents.store.createDocument({
    id: documentId,
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    kind: 'other',
    title: `Record export — ${project.name ?? projectId}`,
    shareWithAncestors: false,
    file: { name: fileName, mime: 'application/json', size_bytes: bytes.length, sha256 },
    storageKey: key,
    actor,
    privateToOrgId: viewer.orgId,
  });
  const result = await documents.store.completeUpload({ documentId, versionNo: 1, actor });
  const versions = await documents.store.listVersions(documentId, result.doc.current_version);
  return { status: 202, body: documentBody(result.doc, versions) };
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
