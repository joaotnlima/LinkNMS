// Documents module use cases (phase 7) — one function per operationId:
//   createDocument, createDocumentVersion, completeUpload, listDocuments,
//   downloadDocument.
//
// The contract asks for no Clerk permission beyond a session; authorization
// is V6 relationships (doc 04): WRITE = edit scope of the target object,
// READ = readers of the scope. Existence hiding throughout: a scope (or a
// document) the viewer cannot read answers 404, never 403.
//
// Upload protocol (doc 08 + schema UploadTicket):
//   1. createDocument / createDocumentVersion reserve the version row and
//      answer a presigned PUT (the declared sha256 is pinned into the
//      signature, so storage refuses different bytes);
//   2. the client PUTs the file;
//   3. completeUpload proves the object exists with the declared size, then
//      advances current_version and writes ledger (sha256) + outbox event in
//      one transaction. Until then the version is invisible everywhere.
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import {
  SCOPE_TYPES, KINDS, validateFile, storageKey, versionRef,
  parseVersionRef, documentBody,
} from '../domain/model.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** operationId: createDocument — reserve v1 + answer an upload ticket. */
export async function createDocument({ viewer, store, storage, body }) {
  requireActiveOrg(viewer);
  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (!SCOPE_TYPES.includes(body?.scope_type)) errors.scope_type = `one of ${SCOPE_TYPES.join(', ')}`;
  if (!UUID.test(body?.scope_id ?? '')) errors.scope_id = 'the object id';
  if (!KINDS.includes(body?.kind)) errors.kind = `one of ${KINDS.join(', ')}`;
  if (typeof body?.title !== 'string' || !body.title.trim()) errors.title = 'required';
  Object.assign(errors, validateFile(body?.file));
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const scope = await store.resolveScope(body.scope_type, body.scope_id);
  if (!scope) throw new ProblemError('not_found'); // unknown object — nothing leaked
  if (!(await store.canEditScope({ scopeType: body.scope_type, scopeId: body.scope_id, orgId: viewer.orgId }))) {
    // Readers learn the object exists; non-editors get a clean refusal.
    if (await store.canReadScope({ scopeType: body.scope_type, scopeId: body.scope_id, orgId: viewer.orgId })) {
      throw new ProblemError('forbidden', 'attaching documents needs edit scope of the object', { reason: 'relationship' });
    }
    throw new ProblemError('not_found');
  }
  const actor = await requireActor(store, viewer);

  // Client id = idempotency key: replaying the same create re-issues a ticket
  // for the same reserved version; a stolen id answers 409.
  const existing = await store.getDocument(body.id);
  if (existing) {
    const v1 = await store.getVersion(body.id, 1);
    if (existing.scope_type === body.scope_type && existing.scope_id === body.scope_id
        && v1 && v1.uploaded_by_org_id === viewer.orgId && v1.sha256 === body.file.sha256.toLowerCase()) {
      return uploadTicket({ storage, version: v1 });
    }
    throw new ProblemError('idempotency_mismatch', 'this id was already used by a different request');
  }

  const version = await store.createDocument({
    id: body.id,
    projectId: scope.projectId,
    scopeType: body.scope_type,
    scopeId: body.scope_id,
    kind: body.kind,
    title: body.title.trim(),
    shareWithAncestors: body.share_with_ancestors === true,
    file: body.file,
    storageKey: storageKey({ documentId: body.id, versionNo: 1, fileName: body.file.name, random: randomUUID() }),
    actor: actorOf(actor, viewer),
  });
  return uploadTicket({ storage, version });
}

/** operationId: createDocumentVersion — next version of an existing document. */
export async function createDocumentVersion({ viewer, store, storage, documentId, body }) {
  requireActiveOrg(viewer);
  const doc = await requireReadableDocument({ viewer, store, documentId });
  const errors = validateFile(body?.file);
  // The contract reuses DocumentCreate here; the scope of an existing document
  // is immutable, so scope fields (when sent) must agree with the row.
  if (body?.scope_type !== undefined && body.scope_type !== doc.scope_type) errors.scope_type = 'a document never changes scope';
  if (body?.scope_id !== undefined && body.scope_id !== doc.scope_id) errors.scope_id = 'a document never changes scope';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  if (!(await store.canEditScope({ scopeType: doc.scope_type, scopeId: doc.scope_id, orgId: viewer.orgId }))) {
    throw new ProblemError('forbidden', 'attaching documents needs edit scope of the object', { reason: 'relationship' });
  }
  const actor = await requireActor(store, viewer);
  const version = await store.addVersion({
    documentId,
    file: body.file,
    storageKeyOf: (versionNo) => storageKey({ documentId, versionNo, fileName: body.file.name, random: randomUUID() }),
    actor: actorOf(actor, viewer),
  });
  return uploadTicket({ storage, version });
}

/** operationId: completeUpload — prove the bytes, then ledger + event. */
export async function completeUpload({ viewer, store, storage, versionId }) {
  requireActiveOrg(viewer);
  const ref = parseVersionRef(versionId);
  if (!ref) {
    throw new ProblemError('validation_failed', null, { errors: { versionId: 'a version reference <document_id>.<version_no>' } });
  }
  const doc = await requireReadableDocument({ viewer, store, documentId: ref.documentId });
  const version = await store.getVersion(ref.documentId, ref.versionNo);
  if (!version) throw new ProblemError('not_found');
  // Whoever reserved the version completes it — the ticket is theirs.
  if (version.uploaded_by_org_id !== viewer.orgId) {
    throw new ProblemError('forbidden', 'only the organisation that opened the upload completes it', { reason: 'relationship' });
  }

  const head = await storage.head({ key: version.storage_key });
  if (!head) {
    throw new ProblemError('validation_failed', 'the file has not arrived in storage yet — PUT it to the ticket URL first',
      { errors: { upload: 'object not found in storage' } });
  }
  if (head.sizeBytes !== Number(version.size_bytes)) {
    // sha256 was already enforced by the pinned checksum on the presigned PUT.
    throw new ProblemError('validation_failed', null,
      { errors: { 'file.size_bytes': `declared ${version.size_bytes}, stored ${head.sizeBytes}` } });
  }

  const actor = await requireActor(store, viewer);
  const result = await store.completeUpload({
    documentId: ref.documentId,
    versionNo: ref.versionNo,
    actor: actorOf(actor, viewer),
  });
  if (!result) throw new ProblemError('not_found');
  const versions = await store.listVersions(ref.documentId, result.doc.current_version);
  return { status: 200, body: documentBody(result.doc, versions) };
}

/** operationId: listDocuments — completed documents of one scope. */
export async function listDocuments({ viewer, store, query }) {
  requireActiveOrg(viewer);
  const errors = {};
  if (!SCOPE_TYPES.includes(query?.scope_type)) errors.scope_type = `one of ${SCOPE_TYPES.join(', ')}`;
  if (!UUID.test(query?.scope_id ?? '')) errors.scope_id = 'the object id';
  if (query?.cursor !== undefined && !UUID.test(query.cursor)) errors.cursor = 'an opaque cursor from next_cursor';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const scope = await store.resolveScope(query.scope_type, query.scope_id);
  if (!scope) throw new ProblemError('not_found');
  if (!(await store.canReadScope({ scopeType: query.scope_type, scopeId: query.scope_id, orgId: viewer.orgId }))) {
    throw new ProblemError('not_found');
  }
  const { items, nextCursor } = await store.listDocuments({
    scopeType: query.scope_type,
    scopeId: query.scope_id,
    cursor: query.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  const bodies = [];
  for (const doc of items) {
    bodies.push(documentBody(doc, await store.listVersions(doc.id, doc.current_version)));
  }
  return { status: 200, body: { items: bodies, next_cursor: nextCursor } };
}

/** operationId: downloadDocument — V6 check, then 302 to a short-lived URL. */
export async function downloadDocument({ viewer, store, storage, versionId }) {
  requireActiveOrg(viewer);
  const ref = parseVersionRef(versionId);
  if (!ref) throw new ProblemError('not_found');
  const doc = await requireReadableDocument({ viewer, store, documentId: ref.documentId });
  // Only proven versions are downloadable — a reserved-but-never-completed
  // version does not exist on the read side.
  if (ref.versionNo > doc.current_version) throw new ProblemError('not_found');
  const version = await store.getVersion(ref.documentId, ref.versionNo);
  if (!version) throw new ProblemError('not_found');

  const { url } = await storage.signDownload({
    key: version.storage_key,
    fileName: `${doc.title}${extensionOf(version.storage_key)}`,
  });
  return { status: 302, body: null, headers: { location: url, 'cache-control': 'no-store' } };
}

// ── shared helpers ───────────────────────────────────────────────────────

function uploadTicket({ storage, version }) {
  return storage.signUpload({
    key: version.storage_key,
    mime: version.mime,
    sha256Hex: version.sha256,
  }).then(({ url, expiresAt }) => ({
    status: 201,
    body: {
      document_version_id: versionRef(version.document_id, version.version_no),
      upload_url: url,
      expires_at: expiresAt,
    },
  }));
}

/** Load a document with existence hiding: non-readers get 404. */
async function requireReadableDocument({ viewer, store, documentId }) {
  const doc = await store.getDocument(documentId);
  if (!doc) throw new ProblemError('not_found');
  const readable = await store.canReadScope({
    scopeType: doc.scope_type,
    scopeId: doc.scope_id,
    orgId: viewer.orgId,
    shareWithAncestors: doc.share_with_ancestors,
  });
  if (!readable) throw new ProblemError('not_found');
  return doc;
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

function extensionOf(key) {
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(key);
  return m ? m[1] : '';
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}
