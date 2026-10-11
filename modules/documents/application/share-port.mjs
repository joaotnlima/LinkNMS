// The documents SHARE-FILES PORT published for the Project module (doc 02
// rule 2; PRD-12 N-12, flow D21). A share link names documents and serves
// them to someone with no account; Project never reads documents.* — it asks:
//
//   shareableFiles(projectId, documentIds) → [{
//     document_id, title, kind, file_type, mime, version_no, size_bytes,
//     sha256, uploaded_at
//   }]   — in the order asked, only those that qualify;
//   signSharedDownload(projectId, documentId, {disposition}) → null | {url}
//
// A document qualifies when it is live, belongs to that build, is one of the
// files every participant shares (project / location / task scope, V1/V6),
// is not organisation-private (0009), and has a proven current version. The
// holder always gets the CURRENT version — read-only, the bytes proven by
// their sha256 in the ledger.
import { fileNameOf } from '../domain/model.mjs';
import { fileTypeOf, PROJECT_FILE_SCOPES } from '../domain/files.mjs';

/**
 * @param {object} store documents pg-store (or a fake with getDocument / getVersion)
 * @param {{ signDownload: Function }} storage the object store
 */
export function createShareFilesPort(store, storage) {
  async function qualifying(projectId, documentId) {
    const doc = await store.getDocument(documentId);
    if (!doc || doc.project_id !== projectId || !PROJECT_FILE_SCOPES.includes(doc.scope_type)) return null;
    if (doc.private_to_org_id) return null;
    if (!Number.isInteger(doc.current_version) || doc.current_version < 1) return null;
    const version = await store.getVersion(documentId, doc.current_version);
    return version ? { doc, version } : null;
  }

  return {
    async shareableFiles(projectId, documentIds) {
      const out = [];
      for (const id of [...new Set(documentIds ?? [])]) {
        const hit = await qualifying(projectId, id);
        if (!hit) continue;
        const { doc, version } = hit;
        out.push({
          document_id: doc.id,
          title: doc.title,
          kind: doc.kind,
          file_type: fileTypeOf(fileNameOf(version.storage_key), version.mime),
          mime: version.mime,
          version_no: version.version_no,
          size_bytes: version.size_bytes == null ? null : Number(version.size_bytes),
          sha256: version.sha256,
          uploaded_at: version.uploaded_at instanceof Date ? version.uploaded_at.toISOString() : (version.uploaded_at ?? null),
        });
      }
      return out;
    },

    async signSharedDownload(projectId, documentId, { disposition = 'attachment' } = {}) {
      const hit = await qualifying(projectId, documentId);
      if (!hit) return null;
      const { doc, version } = hit;
      const ext = /\.[A-Za-z0-9]{1,8}$/.exec(fileNameOf(version.storage_key))?.[0] ?? '';
      const { url } = await storage.signDownload({
        key: version.storage_key,
        fileName: `${doc.title}${ext}`,
        disposition: disposition === 'inline' ? 'inline' : 'attachment',
      });
      return { url };
    },
  };
}
