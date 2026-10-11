// DWG / DXF preview conversion (PRD-06 V-11, V-14, V-15, V-17; D-49).
//
// THE DwgConverter PORT — implemented in infra/dwg-converters.mjs (a no-op
// default and a LibreDWG CLI adapter), selected by env at the composition root:
//
//   converter.name                                   → 'none' | 'libredwg' | …
//   converter.convert({ bytes, fileType, fileName }) → Promise<
//       { ok: true, layouts: [{ name, svg }], layers?: [{ name, on, color?, count? }],
//         warnings?: [{ code, detail? }] }
//     | { ok: false, reason, warnings? } >
//
// The converter never sees a storage key or a database; it gets bytes and
// answers SVG. Its answer is untrusted (normalizeConversion caps and sanitises).
//
// THE JOB — Documents consumes its own `documents.version.uploaded` (doc 10):
// for a DWG / DXF version it reads the bytes, converts, writes each layout SVG
// as a derived object with its own storage key, records the preview keyed by
// the BYTES (document, sha256) and mirrors ready / unavailable (+ reason) onto
// the document when that version is still current. Idempotent: a replay — or a
// re-upload of the same bytes — finds the preview and only re-mirrors.
//
// A converter failure is a RESULT (unavailable + reason), never a thrown
// consumer: the outbox would otherwise retry a broken drawing forever and hold
// back every event behind it. Storage write failures DO throw (transient — the
// row stays undispatched and the next tick retries).
import { createHash } from 'node:crypto';

import { fileNameOf } from '../domain/model.mjs';
import { fileTypeOf, CONVERTED_TYPES } from '../domain/files.mjs';
import { normalizeConversion, previewKey } from '../domain/preview.mjs';

/**
 * Convert one proven version, if it is a DWG / DXF without a preview yet.
 * @returns {Promise<'skipped'|'reused'|'ready'|'unavailable'>}
 */
export async function convertVersionPreview({ store, storage, converter, documentId, versionNo, log = console }) {
  const doc = await store.getDocument(documentId);
  if (!doc) return 'skipped';
  const version = await store.getVersion(documentId, versionNo);
  if (!version || versionNo > doc.current_version) return 'skipped';
  const fileType = fileTypeOf(fileNameOf(version.storage_key), version.mime);
  if (!CONVERTED_TYPES.includes(fileType)) return 'skipped';

  if (await store.getPreview(documentId, version.sha256)) {
    await store.mirrorPreviewStatus(documentId);
    return 'reused';
  }

  let raw;
  try {
    const bytes = await storage.get({ key: version.storage_key });
    raw = await converter.convert({ bytes, fileType, fileName: fileNameOf(version.storage_key) });
  } catch (err) {
    // Logged without the file: names and contents of drawings stay out of logs.
    log.error?.(`[documents] ${converter.name} conversion of ${documentId} v${versionNo} threw: ${err?.message ?? err}`);
    raw = { ok: false, reason: err?.code === 'conversion_timeout' ? 'conversion_timeout' : 'conversion_failed' };
  }
  const result = normalizeConversion(raw);

  const layouts = [];
  if (result.status === 'ready') {
    for (const [index, l] of result.layouts.entries()) {
      const body = Buffer.from(l.svg, 'utf8');
      const sha256Svg = createHash('sha256').update(body).digest('hex');
      const key = previewKey({ documentId, sha256: version.sha256, index });
      await storage.put({ key, body, mime: 'image/svg+xml', sha256Hex: sha256Svg });
      layouts.push({ index, name: l.name, storageKey: key, sizeBytes: body.length, sha256Svg, width: l.width, height: l.height });
    }
  }
  await store.savePreview({
    documentId,
    sha256: version.sha256,
    status: result.status,
    reason: result.reason,
    converter: converter.name,
    layers: result.layers,
    warnings: result.warnings,
    layouts,
  });
  return result.status;
}
