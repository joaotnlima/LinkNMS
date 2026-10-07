// RFP BIM model (LINA-409, D-41 / doc 24) — pure: the file envelope an issuer
// may attach as the building model priced in a (design) RFP, plus the wire body
// the three read surfaces render. No I/O.
//
// The model is persisted as a Documents-module document (`scope_type='rfp'`,
// `kind='bim'`) — no schema change (doc 24 decision 2). Authorization and the
// token surface live in the tendering use-cases (decision 3); this file only
// bounds what bytes may enter and shapes what leaves.
//
// The envelope is IFC-only with a hard 100 MB cap (decision 6). IFC files carry
// no agreed mime — browsers hand us `application/octet-stream`, `model/ifc`,
// `application/x-step`, or an empty string — so the TYPE gate is the `.ifc`
// extension, not the mime (the sha256 pinned into the presigned PUT makes the
// declared bytes unforgeable regardless).

const SHA256 = /^[0-9a-f]{64}$/i;

/** 100 MB — doc 24 decision 6. The viewer shows a "large model" notice >50 MB. */
export const MAX_MODEL_BYTES = 100 * 1024 * 1024;

/** Advisory client-side threshold; not enforced server-side. */
export const LARGE_MODEL_BYTES = 50 * 1024 * 1024;

/** The only mime we normalise a model to on the wire, whatever the browser sent. */
export const MODEL_MIME = 'application/x-step';

/** IFC is the only model format in scope (doc 24). */
export function isIfcName(name) {
  return typeof name === 'string' && /\.ifc$/i.test(name.trim());
}

/**
 * Validate the `file` envelope of an attach/replace request. Returns {errors} —
 * empty when clean, the same shape the Documents module returns. The type gate
 * is the `.ifc` extension; mime is accepted as sent (coerced on store).
 */
export function validateModelFile(file) {
  const errors = {};
  if (!file || typeof file !== 'object') return { file: 'required: {name, mime, size_bytes, sha256}' };
  if (typeof file.name !== 'string' || !file.name.trim()) errors['file.name'] = 'required';
  else if (!isIfcName(file.name)) errors['file.name'] = 'an IFC file (.ifc) — the only model format in scope';
  if (!Number.isInteger(file.size_bytes) || file.size_bytes <= 0) {
    errors['file.size_bytes'] = 'a positive integer';
  } else if (file.size_bytes > MAX_MODEL_BYTES) {
    errors['file.size_bytes'] = `at most ${MAX_MODEL_BYTES} bytes (100 MB)`;
  }
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
    errors['file.sha256'] = '64 hex characters';
  }
  return errors;
}

/**
 * The model descriptor the RFP package projection carries so the three surfaces
 * (owner inbox, public token form, marketplace composer) can render the viewer
 * without a second round trip. `fileName` is the document title (we store the
 * uploaded name as the title for bim documents); the version carries the proven
 * bytes' facts. `doc` is a Documents-module document row + its current version.
 */
export function modelBody(doc, version) {
  return {
    documentId: doc.id,
    version: doc.current_version,
    fileName: doc.title,
    mime: version?.mime ?? MODEL_MIME,
    sizeBytes: version ? Number(version.size_bytes) : 0,
    sha256: version?.sha256 ?? null,
  };
}
