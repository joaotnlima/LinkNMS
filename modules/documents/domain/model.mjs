// Documents domain (doc 08 §Documents) — pure: vocabularies, storage-key
// shape, wire bodies. No I/O.

export const SCOPE_TYPES = Object.freeze([
  'project', 'location', 'contract', 'task', 'rfp', 'proposal',
  'profile', 'change_order', 'measurement', 'nonconformity',
]);

export const KINDS = Object.freeze([
  'drawing', 'bim', 'photo', 'spec', 'contract_doc', 'invoice', 'other',
]);

const SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Validate the `file` part of DocumentCreate. Returns {errors} — empty when
 * clean. The declared sha256/size are pinned into the presigned PUT, so a
 * client cannot upload different bytes than it declared (doc 08: the sha256
 * in the ledger proves the file unchanged).
 */
export function validateFile(file) {
  const errors = {};
  if (!file || typeof file !== 'object') return { file: 'required: {name, mime, size_bytes, sha256}' };
  if (typeof file.name !== 'string' || !file.name.trim()) errors['file.name'] = 'required';
  if (typeof file.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime)) errors['file.mime'] = 'a mime type';
  if (!Number.isInteger(file.size_bytes) || file.size_bytes <= 0) errors['file.size_bytes'] = 'a positive integer';
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) errors['file.sha256'] = '64 hex characters';
  return errors;
}

/**
 * Object key for one version. The random suffix makes the key unguessable
 * (defence in depth — the bucket is private and every read is presigned);
 * the sanitized original name keeps downloads human-legible.
 */
export function storageKey({ documentId, versionNo, fileName, random }) {
  const safe = String(fileName).replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';
  return `v2/documents/${documentId}/v${versionNo}-${random}/${safe}`;
}

/**
 * The router splits path segments on ':' (colon commands), so a version
 * reference must not contain one. document_version has a composite PK —
 * the wire id is `<document_id>.<version_no>`.
 */
export function versionRef(documentId, versionNo) {
  return `${documentId}.${versionNo}`;
}

export function parseVersionRef(ref) {
  const m = /^([0-9a-f-]{36})\.(\d{1,6})$/i.exec(ref ?? '');
  if (!m) return null;
  return { documentId: m[1], versionNo: Number(m[2]) };
}

/** Wire body (schema Document). Versions newest-last, append-only order. */
export function documentBody(doc, versions = []) {
  return {
    id: doc.id,
    scope_type: doc.scope_type,
    scope_id: doc.scope_id,
    kind: doc.kind,
    title: doc.title,
    share_with_ancestors: doc.share_with_ancestors,
    current_version: doc.current_version,
    versions: versions.map((v) => ({
      version_no: v.version_no,
      mime: v.mime,
      size_bytes: Number(v.size_bytes),
      sha256: v.sha256,
      uploaded_by: { person_id: v.uploaded_by_person_id, org_id: v.uploaded_by_org_id },
      uploaded_at: v.uploaded_at,
    })),
  };
}
