'use server';

// The session-bound door the CLIENT model page reaches the server-only data
// layer (`./model.ts`) through — the same pattern as `viewer-actions.ts`: the
// authored intent crosses the boundary, the privilege does not, and every
// answer is a serializable `{ ok, … }` (a 409 carries the conflicting
// elements, a 403 out_of_scope the refused changes).
import {
  fetchProjectModel, saveModelEdits, restoreModel, fetchRecordDiff, reserveModelVersion, completeModelVersion,
  modelViewUrl, fetchTaskModel, ModelError, type TaskModelCard,
} from './model';
import type { V2Conflict, V2ProjectModel, V2RecordDiff } from './model-view';

export type ModelResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; conflicts?: V2Conflict[]; refused?: Array<{ change_index: number; reason: string }> };

async function run<T>(fn: () => Promise<T>): Promise<ModelResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof ModelError) {
      return { ok: false, code: err.code, message: err.message, conflicts: err.conflicts, refused: err.refused };
    }
    return { ok: false, code: 'internal', message: 'Something went wrong. Try again.' };
  }
}

export async function loadModelAction(projectId: string, version?: number | null): Promise<ModelResult<V2ProjectModel>> {
  return run(() => fetchProjectModel(projectId, version));
}

export async function saveModelEditsAction(projectId: string, body: unknown): Promise<ModelResult<{ versionNo: number; changeCount: number; dropped: number }>> {
  return run(async () => {
    const r = await saveModelEdits(projectId, body);
    return { versionNo: r.version_no, changeCount: r.change_count, dropped: r.dropped ?? 0 };
  });
}

export async function restoreModelAction(projectId: string, versionNo: number): Promise<ModelResult<number>> {
  return run(async () => (await restoreModel(projectId, versionNo)).version_no);
}

export async function recordDiffAction(projectId: string, from: number, to: number): Promise<ModelResult<V2RecordDiff>> {
  return run(() => fetchRecordDiff(projectId, from, to));
}

export async function reserveModelVersionAction(
  projectId: string, file: { name: string; sizeBytes: number; sha256: string }, note?: string | null,
): Promise<ModelResult<{ versionRef: string; uploadUrl: string }>> {
  return run(() => reserveModelVersion(projectId, file, note));
}

export async function completeModelVersionAction(versionRef: string): Promise<ModelResult<number>> {
  return run(async () => (await completeModelVersion(versionRef)).current_version);
}

export async function modelViewUrlAction(documentId: string, versionNo: number): Promise<ModelResult<string>> {
  return run(() => modelViewUrl(documentId, versionNo));
}

export async function taskModelAction(taskId: string): Promise<ModelResult<TaskModelCard | null>> {
  return run(() => fetchTaskModel(taskId));
}
