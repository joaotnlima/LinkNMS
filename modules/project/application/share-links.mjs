// Share links (flow D21, PRD-12 N-12) — one function per operationId:
//   createShareLink, listShareLinks, revokeShareLink, listShareLinkAccesses
//   (owner side: org:plan:edit ∧ project.owner ∧ staffing), and the public pair
//   resolveShareLink, downloadSharedDocument (security: [] — the token IS the
//   credential; no viewer).
//
// The documents a link may name and serve come from the Documents module's
// published share-files port (doc 02 rule 2): project never reads
// documents.*. The port answers only the build's shared files (project /
// location / task scope, not organisation-private, a proven current version).
//
// Every access the public surface serves is written — access row + ledger
// entry, one transaction — BEFORE the answer leaves (gap S1 bullet 4). A
// refused token (unknown / expired / revoked) is not an access.
import { randomUUID, randomBytes } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import {
  parseShareLinkCreate, shareLinkStatus, shareLinkBody, shareLinkAccessBody,
} from '../domain/share-link.mjs';
import { requireOwner, requireActor, actorOf, clampLimit, sha256 } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{48}$/;

/** operationId: createShareLink — scoped, expiring, for a licensing authority. */
export async function createShareLink({ viewer, store, documents, projectId, body, shareBaseUrl }) {
  const { project } = await requireOwner({ viewer, store, projectId, permission: 'org:plan:edit' });
  const parsed = parseShareLinkCreate(body);
  if (!parsed.ok) throw new ProblemError('validation_failed', null, { errors: parsed.errors });
  const cmd = parsed.value;

  const files = await requireDocuments(documents).shareableFiles(project.id, cmd.documentIds);
  const known = new Set(files.map((f) => f.document_id));
  const unknown = cmd.documentIds.filter((d) => !known.has(d));
  if (unknown.length) {
    throw new ProblemError('validation_failed', null, {
      errors: { document_ids: `not files of this build that can be shared: ${unknown.join(', ')}` },
    });
  }

  const actor = await requireActor(store, viewer);
  const token = randomBytes(24).toString('hex');
  const link = await store.createShareLink({
    id: randomUUID(),
    projectId: project.id,
    createdByPersonId: actor.id,
    audience: cmd.audience,
    documentIds: cmd.documentIds,
    taskIds: cmd.taskIds,
    tokenHash: sha256(token),
    expiresAt: cmd.expiresAt,
    actor: actorOf(actor, viewer),
  });
  return {
    status: 201,
    body: { ...shareLinkBody({ ...link, access_count: 0 }), url: `${shareBaseUrl}/share/${token}` },
  };
}

/** operationId: listShareLinks — every state, newest first, with use counts. */
export async function listShareLinks({ viewer, store, projectId, query }) {
  await requireOwner({ viewer, store, projectId, permission: 'org:plan:edit' });
  const { items, nextCursor } = await store.listShareLinks({
    projectId, cursor: cursorOf(query?.cursor), limit: clampLimit(query?.limit),
  });
  const now = new Date();
  return { status: 200, body: { items: items.map((l) => shareLinkBody(l, now)), next_cursor: nextCursor } };
}

/** operationId: revokeShareLink — idempotent; the record says who closed it. */
export async function revokeShareLink({ viewer, store, shareLinkId, idempotencyKey = null }) {
  const link = await requireOwnedLink({ viewer, store, shareLinkId });
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'revokeShareLink', body: { share_link_id: link.id } },
    () => revoke({ viewer, store, link }),
  );
}

async function revoke({ viewer, store, link }) {
  if (link.revoked_at) return { status: 200, body: shareLinkBody(link) };
  const actor = await requireActor(store, viewer);
  const revoked = await store.revokeShareLink({
    shareLinkId: link.id, projectId: link.project_id, actor: actorOf(actor, viewer),
  });
  // A racer revoked it first: answer the link as it now stands.
  return { status: 200, body: shareLinkBody(revoked ?? await store.getShareLink(link.id)) };
}

/** operationId: listShareLinkAccesses — the append-only access log, newest first. */
export async function listShareLinkAccesses({ viewer, store, shareLinkId, query }) {
  const link = await requireOwnedLink({ viewer, store, shareLinkId });
  const { items, nextCursor } = await store.listShareLinkAccesses({
    shareLinkId: link.id, cursor: cursorOf(query?.cursor), limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(shareLinkAccessBody), next_cursor: nextCursor } };
}

/** operationId: resolveShareLink — public; the shared documents only; logged. */
export async function resolveShareLink({ store, documents, token, requester }) {
  const link = await requireLiveLink(store, token);
  const project = await store.getProject(link.project_id);
  if (!project) throw new ProblemError('not_found');
  // A file removed or made private after sharing silently drops out — the
  // link never serves more than the build still shares.
  const files = await requireDocuments(documents).shareableFiles(link.project_id, link.document_ids ?? []);
  await store.recordShareLinkAccess({
    id: randomUUID(), link, action: 'view', documentId: null, ...requester,
  });
  return {
    status: 200,
    headers: { 'cache-control': 'no-store' },
    body: {
      project_name: project.name,
      ...(project.municipality_code ? { municipality_code: project.municipality_code } : {}),
      audience: link.audience,
      expires_at: link.expires_at instanceof Date ? link.expires_at.toISOString() : String(link.expires_at),
      documents: files.map((f) => ({
        id: f.document_id,
        title: f.title,
        kind: f.kind,
        file_type: f.file_type,
        mime: f.mime,
        version_no: f.version_no,
        ...(f.size_bytes != null ? { size_bytes: Number(f.size_bytes) } : {}),
        sha256: f.sha256,
        ...(f.uploaded_at ? { uploaded_at: f.uploaded_at } : {}),
      })),
    },
  };
}

/** operationId: downloadSharedDocument — public; 302 to a signed URL; logged. */
export async function downloadSharedDocument({ store, documents, token, documentId, query, requester }) {
  const link = await requireLiveLink(store, token);
  if (!UUID.test(documentId ?? '') || !(link.document_ids ?? []).includes(documentId)) {
    throw new ProblemError('not_found');
  }
  const disposition = query?.disposition === 'inline' ? 'inline' : 'attachment';
  const signed = await requireDocuments(documents).signSharedDownload(link.project_id, documentId, { disposition });
  if (!signed) throw new ProblemError('not_found');
  await store.recordShareLinkAccess({
    id: randomUUID(), link, action: 'download', documentId, ...requester,
  });
  return { status: 302, body: null, headers: { location: signed.url, 'cache-control': 'no-store' } };
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Unknown → 404 (nothing to learn from a guess). Known but expired or revoked
 * → 410 with the reason: the holder already had the token, so saying "this
 * link expired on …" leaks nothing and is what acceptance criterion 4 asks.
 */
async function requireLiveLink(store, token) {
  if (!TOKEN.test(token ?? '')) throw new ProblemError('not_found');
  const link = await store.getShareLinkByTokenHash(sha256(token));
  if (!link) throw new ProblemError('not_found');
  const status = shareLinkStatus(link);
  if (status !== 'active') {
    throw new ProblemError('gone', status === 'revoked' ? 'this link was revoked' : 'this link has expired', {
      reason: status,
      expires_at: link.expires_at instanceof Date ? link.expires_at.toISOString() : String(link.expires_at),
    });
  }
  return link;
}

async function requireOwnedLink({ viewer, store, shareLinkId }) {
  if (!UUID.test(shareLinkId ?? '')) throw new ProblemError('not_found');
  const link = await store.getShareLink(shareLinkId);
  if (!link) throw new ProblemError('not_found');
  await requireOwner({ viewer, store, projectId: link.project_id, permission: 'org:plan:edit' });
  return link;
}

function requireDocuments(documents) {
  if (!documents?.shareableFiles) throw new Error('project share links need the documents share-files port');
  return documents;
}

/** Keyset cursor `<iso>~<uuid>`; anything else starts from the top. */
function cursorOf(raw) {
  if (typeof raw !== 'string') return null;
  const [at, id] = raw.split('~');
  return at && UUID.test(id ?? '') && !Number.isNaN(Date.parse(at)) ? { at, id } : null;
}
