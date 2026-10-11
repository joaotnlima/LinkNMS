// The documents QUERY PORT published for other modules (doc 02 rule 2).
// Planning binds a deliverable submission to a document version without
// reading documents.* (PRD-05 F-13):
//
//   versionFacts({ documentId, versionNo?, orgId }) → null | {
//     document_id, project_id, version_no, sha256, title, mime, file_type,
//     current_version, kind
//   }
//
// Null unless the version is PROVEN (≤ current_version), the document is live,
// it is a project / location / task file (the audiences every participant
// shares, V1/V6) and `orgId` may read it. `versionNo` defaults to the current
// version.
import { fileNameOf } from '../domain/model.mjs';
import { fileTypeOf, PROJECT_FILE_SCOPES } from '../domain/files.mjs';

/** @param {object} store documents pg-store (or a fake with the same reads) */
export function createDocumentsPort(store) {
  return {
    async versionFacts({ documentId, versionNo = null, orgId }) {
      const doc = await store.getDocument(documentId);
      if (!doc || !doc.project_id || !PROJECT_FILE_SCOPES.includes(doc.scope_type)) return null;
      if (doc.private_to_org_id && doc.private_to_org_id !== orgId) return null;
      const no = versionNo ?? doc.current_version;
      if (!Number.isInteger(no) || no < 1 || no > doc.current_version) return null;
      const readable = await store.canReadScope({ scopeType: doc.scope_type, scopeId: doc.scope_id, orgId });
      if (!readable) return null;
      const version = await store.getVersion(documentId, no);
      if (!version) return null;
      return {
        document_id: doc.id,
        project_id: doc.project_id,
        version_no: no,
        sha256: version.sha256,
        title: doc.title,
        mime: version.mime,
        file_type: fileTypeOf(fileNameOf(version.storage_key), version.mime),
        current_version: doc.current_version,
        // PRD-10 E-8: the daily log binds only photos (kind = photo).
        kind: doc.kind,
      };
    },
  };
}
