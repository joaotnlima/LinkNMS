// Documents-module event consumers (doc 10). Documents consumes its OWN
// `documents.version.uploaded`: a proven DWG / DXF version is converted into
// its preview (PRD-06 V-11, V-17) through the DwgConverter port — see
// ./dwg-preview.mjs. Idempotent (the preview is keyed by the bytes).
import { convertVersionPreview } from './dwg-preview.mjs';

/**
 * @param {object} store documents pg-store
 * @param {{ storage: object, converter: { name: string, convert: Function }, log?: Console }} deps
 */
export function documentsConsumers(store, { storage, converter, log = console }) {
  return {
    'documents.version.uploaded': async (evt) => {
      if (evt.type !== 'documents.version.uploaded') return;
      const documentId = evt.data?.document_id;
      const versionNo = evt.data?.version_no;
      if (!documentId || !Number.isInteger(versionNo)) return;
      await convertVersionPreview({ store, storage, converter, documentId, versionNo, log });
    },
  };
}
