// The shared project model on `/api/v2` (PRD-07, D-45). The I/O half: every
// call goes through the shared v2 client; the pure mapping lives in
// `./model-view.ts`. Who may read, edit, upload or restore is the Documents
// module's decision (M-7..M-9) — a refusal comes back as a typed ModelError the
// page shows as a sentence; a 409 carries the conflicting elements (M-14) and a
// 403 out_of_scope the refused changes, so the page can ask element by element.
import 'server-only';

import { v2, V2Error } from './client';
import type { V2ProjectModel, V2RecordDiff, V2Conflict } from './model-view';
import type { V2FileDocument } from './task-files-view';

const enc = encodeURIComponent;

export class ModelError extends Error {
  constructor(
    public code: string,
    message: string,
    public conflicts: V2Conflict[] = [],
    public refused: Array<{ change_index: number; reason: string }> = [],
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

const SAID: Record<string, string> = {
  not_found: 'This build has no model you can open, or you are not on it.',
  forbidden: 'You can read this model but not change it here.',
  out_of_scope: 'Some changes touch elements or tasks outside your edit scope.',
  version_conflict: 'Someone changed these elements after the version you started from.',
  validation_failed: 'That did not go through — check what you entered and try again.',
};

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof V2Error) {
      const p = err.problem ?? {};
      const conflicts = Array.isArray(p.conflicts) ? (p.conflicts as V2Conflict[]) : [];
      const refused = Array.isArray(p.refused) ? (p.refused as Array<{ change_index: number; reason: string }>) : [];
      const fieldMessage = err.errors ? Object.values(err.errors)[0] : null;
      throw new ModelError(err.code, err.detail ?? fieldMessage ?? SAID[err.code] ?? 'That did not go through. Try again.', conflicts, refused);
    }
    throw new ModelError('internal', 'Something went wrong. Try again.');
  }
}

export async function fetchProjectModel(projectId: string, version?: number | null): Promise<V2ProjectModel> {
  return call(() => v2<V2ProjectModel>({
    method: 'GET', path: `/projects/${enc(projectId)}/model`, query: { version: version ?? undefined },
  }));
}

export async function saveModelEdits(projectId: string, body: unknown) {
  return call(() => v2<{ document: V2FileDocument; version_no: number; change_count: number; dropped?: number; edited_by_author?: boolean }>({
    method: 'POST', path: `/projects/${enc(projectId)}/model:save`, body, idempotencyKey: crypto.randomUUID(),
  }));
}

export async function restoreModel(projectId: string, versionNo: number, note?: string | null) {
  return call(() => v2<{ document: V2FileDocument; version_no: number }>({
    method: 'POST', path: `/projects/${enc(projectId)}/model:restore`,
    body: { version_no: versionNo, ...(note ? { note } : {}) }, idempotencyKey: crypto.randomUUID(),
  }));
}

export async function fetchRecordDiff(projectId: string, from: number, to: number): Promise<V2RecordDiff> {
  return call(() => v2<V2RecordDiff>({
    method: 'GET', path: `/projects/${enc(projectId)}/model/record-diff`, query: { from, to },
  }));
}

export async function reserveModelVersion(projectId: string, file: { name: string; sizeBytes: number; sha256: string }, note?: string | null) {
  return call(async () => {
    const t = await v2<{ document_version_id: string; upload_url: string }>({
      method: 'POST', path: `/projects/${enc(projectId)}/model/versions`, idempotencyKey: crypto.randomUUID(),
      body: {
        file: { name: file.name, mime: 'application/x-step', size_bytes: file.sizeBytes, sha256: file.sha256.toLowerCase() },
        ...(note ? { note } : {}),
      },
    });
    return { versionRef: t.document_version_id, uploadUrl: t.upload_url };
  });
}

export async function completeModelVersion(versionRef: string): Promise<V2FileDocument> {
  return call(() => v2<V2FileDocument>({
    method: 'POST', path: `/document-versions/${enc(versionRef)}:complete`, idempotencyKey: crypto.randomUUID(),
  }));
}

/** A short-lived inline URL for one model version's bytes (V6 check server-side). */
export async function modelViewUrl(documentId: string, versionNo: number): Promise<string> {
  return call(async () => (await v2<{ url: string }>({
    method: 'GET', path: `/document-versions/${enc(`${documentId}.${versionNo}`)}:view-url`,
  })).url);
}

export interface TaskModelCard {
  document_id: string; title: string; current_version: number; element_count: number;
  can_edit: boolean; edit_reason: 'author' | 'owner' | 'scope' | 'none';
}

export async function fetchTaskModel(taskId: string): Promise<TaskModelCard | null> {
  return call(async () => (await v2<{ model: TaskModelCard | null }>({ method: 'GET', path: `/tasks/${enc(taskId)}/model` })).model);
}
