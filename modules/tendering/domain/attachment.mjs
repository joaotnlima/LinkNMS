// Proposal attachments (LINA-370, gap S1 follow-up) — pure: the file envelope
// a tokened bidder may upload, the storage-key shape, and the wire bodies. No
// I/O. The upload itself lives in the store (R2 via the shared storage port);
// the token guards live in use-cases.
//
// The envelope is deliberately tighter than the Documents module's (which
// takes any mime, any size): this is an ANONYMOUS surface, so the surface area
// an attacker can push through the presigned PUT is bounded to a short list of
// portfolio-shaped types and a hard size cap. The sha256 is pinned into the
// presigned PUT, so a client can never upload bytes other than the ones it
// declared here — size and type are therefore effectively pinned too.

const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * What a portfolio attachment may be: images a bidder shows comparable work
 * with, plus PDF (method statements, brochures — the common non-image the word
 * "portfolio" still means). Anything else is refused before a ticket is minted.
 */
export const ALLOWED_MIME = Object.freeze([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf',
]);

/** 15 MB — generous for a site photo or a short PDF, small enough to bound abuse. */
export const MAX_SIZE_BYTES = 15 * 1024 * 1024;

/** A single link cannot reserve an unbounded pile of tickets. */
export const MAX_ATTACHMENTS_PER_PROPOSAL = 10;

/**
 * Validate the `file` envelope of an upload request. Returns {errors} — empty
 * when clean, the same shape the Documents module returns.
 */
export function validateAttachmentFile(file) {
  const errors = {};
  if (!file || typeof file !== 'object') return { file: 'required: {name, mime, size_bytes, sha256}' };
  if (typeof file.name !== 'string' || !file.name.trim()) errors['file.name'] = 'required';
  if (!ALLOWED_MIME.includes(file.mime)) {
    errors['file.mime'] = `one of ${ALLOWED_MIME.join(', ')}`;
  }
  if (!Number.isInteger(file.size_bytes) || file.size_bytes <= 0) {
    errors['file.size_bytes'] = 'a positive integer';
  } else if (file.size_bytes > MAX_SIZE_BYTES) {
    errors['file.size_bytes'] = `at most ${MAX_SIZE_BYTES} bytes`;
  }
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
    errors['file.sha256'] = '64 hex characters';
  }
  return errors;
}

/**
 * Object key for one attachment. The random component makes the key
 * unguessable (defence in depth — the bucket is private, every read is
 * presigned); the sanitized original name keeps a presigned download legible.
 */
export function attachmentStorageKey({ proposalId, documentId, fileName }) {
  const safe = String(fileName).replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';
  return `v2/proposal-documents/${proposalId}/${documentId}/${safe}`;
}

/** The presigned-PUT ticket the reserve step answers. */
export function uploadTicketBody({ document, url, expiresAt }) {
  return {
    document_id: document.id,
    upload_url: url,
    expires_at: expiresAt,
  };
}

/** The stored-attachment body the complete/download steps echo. */
export function attachmentBody(row) {
  return {
    document_id: row.id,
    file_name: row.file_name,
    mime: row.mime,
    size_bytes: Number(row.size_bytes),
    status: row.status,
  };
}
