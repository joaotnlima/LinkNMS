// The model upload check on completion (PRD-07 M-18; audit S4c). Called by
// completeUpload when a version of the build's model is proven: the declared
// GlobalIds of the new file (sent with the reservation) are compared with the
// record and with the previous upload — the server's answer, read back by
// getProjectModel as `upload_check`. A version reserved without GlobalIds has
// no check (nothing to compare honestly).
import { modelUploadCheck } from '../domain/model-check.mjs';

export async function checkModelUpload({ store, doc, versionNo }) {
  if (!doc?.is_project_model || typeof store.modelUploadPair !== 'function') return null;
  const { current, previous } = await store.modelUploadPair(doc.id, versionNo);
  if (!current || current.checked_at) return null;
  const { links, pins } = await store.modelRecord(doc.id);
  const recorded = [
    ...links.filter((l) => l.removed_in_version == null).map((l) => l.global_id),
    ...pins.flatMap((p) => p.global_ids ?? []),
  ];
  const check = modelUploadCheck({ recorded, next: current.global_ids, previous: previous?.global_ids ?? null });
  await store.recordModelUploadCheck({ documentId: doc.id, versionNo, check });
  return check;
}
