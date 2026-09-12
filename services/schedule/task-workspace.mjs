// Task workspace — per-stage comments and file attachments (LINA-249; parent
// LINA-248, founder ask 3). Every plan task is addressable at its own URL
// (Jira-style) and carries collaboration chatter in two append-only boxes.
//
// WHY THIS IS NOT A LEDGER SERVICE. Comments and files are **chatter, not
// agreement change** — no budget/decision semantics, no party-scoped private
// draft. The endpoint surfaces under the existing project API, every project
// member may read AND write both (they are shared build context). The actor is
// ALWAYS the session party (ADR-0004 — the client never names the author, just
// as `:author` never accepts an actor). There is deliberately NO ledger append
// anywhere in this file: the ledger is the tamper-evident agreement record and
// these rows are not part of it (no grant to append a new event type exists,
// and none is wanted).
//
// STABLE IDENTITY. Rows anchor on `(project_id, stage_key)` — the client-minted
// `key` PERSISTED on the stage row by `:author` (migration 0011) — not on stage
// row ids, because a draft re-save churns ids. A comment survives a re-save and
// a version bump as long as the FE keeps sending the same key. A stage key is
// addressable only while it is LIVE (see `assertLiveStage`); a key whose stage
// was superseded away orphans its rows, which is the v1 contract.
//
// STORAGE. Attachment bytes go to a blob store (Vercel Blob in production)
// through a `blob` port; the row stores the returned URL + server-derived
// metadata. The client's declared content type is NEVER trusted: the type is
// sniffed from the buffer's magic bytes server-side, and the allowlist (images
// + pdf + common office docs) plus the 10 MB cap are enforced here.
import { randomUUID } from 'node:crypto';
import { DomainError, now } from './ports.mjs';

const KEY_MAX = 200;
const BODY_MAX = 4000;
const FILE_NAME_MAX = 255;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Office documents arrive as TWO zip-like containers that magic bytes can only
// prove to the family, not the exact app. Map the extension → full MIME only
// when the container magic matched (a `.xlsx` that is not a zip is rejected).
const OOXML_BY_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const OLE_BY_EXT = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? '');
  return m ? m[1].toLowerCase() : '';
}

function startsWith(buf, magic, offset = 0) {
  if (buf.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (buf[offset + i] !== magic[i]) return false;
  }
  return true;
}

// Re-derive a file's content type from its bytes — the ONLY allowed source for
// the stored `content_type`. Returns a MIME string or null (rejected).
function sniffContentType(buffer, filename) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.length >= 12
      && buffer.toString('latin1', 0, 4) === 'RIFF'
      && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  // OLE compound document (legacy .doc/.xls/.ppt) — app decided by extension.
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return OLE_BY_EXT[extOf(filename)] ?? null;
  }
  // ZIP container — only real OOXML files (.docx/.xlsx/.pptx, decided by ext).
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return OOXML_BY_EXT[extOf(filename)] ?? null;
  }
  // SVG: an XML document whose root element is <svg>. Reject all other text.
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 512)).trimStart();
  if (/^<\?xml[\s\S]*?<svg\b/i.test(head) || /^<svg\b/i.test(head)) return 'image/svg+xml';
  return null;
}

function sanitizeFileName(name) {
  if (typeof name !== 'string') return '';
  // Take the final path segment only (defuses `../etc/passwd` and Windows
  // backslash traversal); strip control chars; cap at the column limit.
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base || base.length > FILE_NAME_MAX) return '';
  return base;
}

// The typed 400/413 helpers keep the validation story in one place and read
// like the `:author` validator's friends.
function stageKeyError() {
  return new DomainError(400, 'bad_request', 'stageKey must be a non-empty string ≤ 200 chars');
}

function validateUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.byteLength === 0) {
    throw new DomainError(400, 'empty_file', 'attachments:multipart expects a non-empty file part');
  }
  if (file.buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new DomainError(413, 'attachment_too_large',
      `file exceeds the 10 MB attachment cap (${file.buffer.byteLength} bytes)`);
  }
  const fileName = sanitizeFileName(file.filename);
  if (!fileName) {
    throw new DomainError(400, 'invalid_filename', 'file part must carry a valid file name (≤ 255 chars)');
  }
  const contentType = sniffContentType(file.buffer, fileName);
  if (!contentType) {
    throw new DomainError(415, 'unsupported_content_type',
      'only images, PDF and common office documents can be attached');
  }
  return { fileName, contentType, buffer: file.buffer };
}

export function createTaskWorkspaceService({ store, identity, blob }) {
  if (!store || !identity || !blob) {
    throw new Error('createTaskWorkspaceService requires { store, identity, blob } ports');
  }

  // The path is `/projects/:id/plan/stages/:stageKey/…`; the `:stageKey` is a
  // client-minted key (≤ 200 chars, same max `:author` enforces). A malformed
  // key is a client mistake → 400, never a pg 500.
  function normalizeStageKey(stageKey) {
    if (typeof stageKey !== 'string' || stageKey === '' || stageKey.length > KEY_MAX) {
      throw stageKeyError();
    }
    return stageKey;
  }

  // "Reject when the stage key does not exist in the project's current plan or
  // open draft." The DB-level check runs AFTER the membership check (a non-
  // member gets 403 before learning anything about the build — the same
  // 403-before-404 posture as Identity's authorize). 404, not 403, for a live
  // member whose key is just stale (the resource does not exist for them).
  async function assertLiveStage(projectId, stageKey) {
    if (!(await store.stageLiveByKey(projectId, stageKey))) {
      throw new DomainError(404, 'not_found',
        'no task with this key exists in this project\'s current plan or draft');
    }
  }

  // The API shapes. The store rows keep snake_case; the contract (and the FE)
  // sees camelCase, exactly like `getStage`/`getPlan` do for stages.
  const commentView = (c) => ({
    id: c.id,
    body: c.body,
    authorPartyId: c.author_party_id,
    createdAt: c.created_at,
  });

  const attachmentView = (a) => ({
    id: a.id,
    fileName: a.file_name,
    contentType: a.content_type,
    sizeBytes: a.size_bytes,
    uploaderPartyId: a.uploader_party_id,
    blobUrl: a.blob_url,
    createdAt: a.created_at,
  });

  // GET /projects/:projectId/plan/stages/:stageKey/workspace — one fetch for the
  // drawer/page: both boxes, oldest → newest. Both parties read (members only).
  async function getWorkspace(projectId, stageKey, actorPartyId) {
    await identity.requireMember(actorPartyId, projectId);
    const key = normalizeStageKey(stageKey);
    await assertLiveStage(projectId, key);
    const [comments, attachments] = await Promise.all([
      store.listStageCommentsByKey(projectId, key),
      store.listStageAttachmentsByKey(projectId, key),
    ]);
    return {
      stageKey: key,
      comments: comments.map(commentView),
      attachments: attachments.map(attachmentView),
    };
  }

  // POST /projects/:projectId/plan/stages/:stageKey/comments — append a comment.
  // The author is the SESSION party, never the body (ADR-0004). A forged
  // `authorPartyId` in the body is inert; the row stores actorPartyId. No edit,
  // no delete in v1 (append-only table, immutability is cheaper than an
  // edit-history design; revisit only on founder demand).
  async function addComment(projectId, stageKey, actorPartyId, input) {
    await identity.requireMember(actorPartyId, projectId);
    const key = normalizeStageKey(stageKey);
    await assertLiveStage(projectId, key);

    const raw = input?.body;
    if (typeof raw !== 'string') {
      throw new DomainError(400, 'invalid_comment', 'body is required (a string)');
    }
    const body = raw.trim();
    if (!body) {
      throw new DomainError(400, 'invalid_comment', 'body must not be empty');
    }
    if (body.length > BODY_MAX) {
      throw new DomainError(400, 'invalid_comment', `body must be ≤ ${BODY_MAX} chars`);
    }

    // Single-insert append, in a transaction like every other schedule write
    // (the pg adapter needs the client; the in-memory adapter ignores it).
    const created = await store.transaction(async (tx) => store.insertStageComment(tx, {
      id: randomUUID(),
      project_id: projectId,
      stage_key: key,
      author_party_id: actorPartyId,
      body,
      created_at: now(),
    }));
    return { comment: commentView(created) };
  }

  // POST /projects/:projectId/plan/stages/:stageKey/attachments — multipart
  // upload. The uploader is the SESSION party; the type is sniffed server-side;
  // size is capped; the blob write happens before the metadata row so the row
  // always references an object that exists. An orphan blob (row insert fails
  // after a successful put) is cleaned by Blob's own lifecycle, not by a delete
  // grant that append-only deliberately lacks.
  async function addAttachment(projectId, stageKey, actorPartyId, file) {
    await identity.requireMember(actorPartyId, projectId);
    const key = normalizeStageKey(stageKey);
    await assertLiveStage(projectId, key);

    const { fileName, contentType, buffer } = validateUpload(file);
    const blobUrl = await blob.put({ fileName, contentType, buffer });

    const created = await store.transaction(async (tx) => store.insertStageAttachment(tx, {
      id: randomUUID(),
      project_id: projectId,
      stage_key: key,
      uploader_party_id: actorPartyId,
      file_name: fileName,
      content_type: contentType,
      size_bytes: buffer.byteLength,
      blob_url: blobUrl,
      created_at: now(),
    }));
    return { attachment: attachmentView(created) };
  }

  return { getWorkspace, addComment, addAttachment };
}