// Viewing a drawing in the browser (PRD-06) — one function per operationId:
//   getDocumentViewUrl, getDocumentPreview.
//
// Same V6 check as downloadDocument (readers of the scope, private documents
// to their owner org, existence hiding) and only PROVEN versions. The answer is
// JSON with short-lived INLINE presigned GETs — the client-side PDF renderer
// fetches the bytes, the DWG viewer fetches each layout's SVG.
import { ProblemError } from '../../../platform/errors.mjs';
import { parseVersionRef, fileNameOf } from '../domain/model.mjs';
import { fileTypeOf, CONVERTED_TYPES } from '../domain/files.mjs';
import { previewBody } from '../domain/preview.mjs';
import { requireActiveOrg, requireReadableDocument } from './use-cases.mjs';

async function requireReadableVersion({ viewer, store, versionId }) {
  requireActiveOrg(viewer);
  const ref = parseVersionRef(versionId);
  if (!ref) throw new ProblemError('not_found');
  const doc = await requireReadableDocument({ viewer, store, documentId: ref.documentId });
  if (ref.versionNo > doc.current_version) throw new ProblemError('not_found');
  const version = await store.getVersion(ref.documentId, ref.versionNo);
  if (!version) throw new ProblemError('not_found');
  return { doc, version };
}

/** operationId: getDocumentViewUrl */
export async function getDocumentViewUrl({ viewer, store, storage, versionId }) {
  const { doc, version } = await requireReadableVersion({ viewer, store, versionId });
  const { url, expiresAt } = await storage.signDownload({
    key: version.storage_key, fileName: doc.title, disposition: 'inline',
  });
  return { status: 200, body: { url, expires_at: expiresAt } };
}

/** operationId: getDocumentPreview */
export async function getDocumentPreview({ viewer, store, storage, versionId }) {
  const { doc, version } = await requireReadableVersion({ viewer, store, versionId });
  const fileType = fileTypeOf(fileNameOf(version.storage_key), version.mime);
  const converted = CONVERTED_TYPES.includes(fileType);
  const preview = converted ? await store.getPreview(doc.id, version.sha256) : null;
  const layouts = [];
  if (preview?.status === 'ready') {
    for (const l of await store.listPreviewLayouts(doc.id, version.sha256)) {
      const { url, expiresAt } = await storage.signDownload({
        key: l.storage_key, fileName: `${doc.title} — ${l.name}.svg`, disposition: 'inline',
      });
      layouts.push({ ...l, view_url: url, expires_at: expiresAt });
    }
  }
  return {
    status: 200,
    body: previewBody({ documentId: doc.id, versionNo: version.version_no, fileType, converted, preview, layouts }),
  };
}
