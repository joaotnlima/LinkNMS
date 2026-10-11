'use server';

// The session-bound door the CLIENT Files tab and Add-files dialog reach the
// server-only data layer (`./task-files.ts`) through — the same pattern as
// `task-workspace-actions.ts`: the authored intent crosses the boundary, the
// privilege does not, and every answer is a serializable `{ ok, … }`.
import {
  fetchTaskFiles, fetchProjectFiles, reserveProjectFile, reserveNewVersion, completeFile,
  linkFiles, unlinkFile, addDeliverable, removeDeliverable, submitDeliverableVersion, decideDeliverable,
  type TaskFilesView, type FileDeclaration,
} from './task-files';
import { WorkspaceError } from './task-workspace-view';
import type { FileView, DeliverableView, LinkRole, FileType } from './task-files-view';

export type FilesResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

async function run<T>(fn: () => Promise<T>): Promise<FilesResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof WorkspaceError) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: 'internal', message: 'Something went wrong. Try again.' };
  }
}

export async function loadTaskFilesAction(taskId: string): Promise<FilesResult<TaskFilesView>> {
  return run(() => fetchTaskFiles(taskId));
}

export async function searchProjectFilesAction(
  projectId: string, q: string, type: FileType | null,
): Promise<FilesResult<FileView[]>> {
  return run(async () => (await fetchProjectFiles(projectId, { q, type, limit: 100 })).files);
}

export async function reserveTaskUploadAction(args: {
  projectId: string; taskId: string; file: FileDeclaration; role: LinkRole; includeSubtasks: boolean;
  kind: string; note?: string | null; newVersionOf?: string | null;
}): Promise<FilesResult<{ versionRef: string; uploadUrl: string }>> {
  return run(() => (args.newVersionOf
    ? reserveNewVersion(args.newVersionOf, args.file, args.note)
    : reserveProjectFile(args)));
}

export async function completeUploadAction(versionRef: string): Promise<FilesResult<null>> {
  return run(async () => { await completeFile(versionRef); return null; });
}

export async function linkFilesAction(
  taskId: string, documentIds: string[], role: LinkRole, includeSubtasks: boolean,
): Promise<FilesResult<null>> {
  return run(async () => { await linkFiles(taskId, documentIds, role, includeSubtasks); return null; });
}

export async function unlinkFileAction(taskId: string, documentId: string): Promise<FilesResult<null>> {
  return run(async () => { await unlinkFile(taskId, documentId); return null; });
}

export async function addDeliverableAction(taskId: string, title: string, required: boolean): Promise<FilesResult<DeliverableView>> {
  return run(() => addDeliverable(taskId, title, required));
}

export async function removeDeliverableAction(deliverableId: string): Promise<FilesResult<null>> {
  return run(async () => { await removeDeliverable(deliverableId); return null; });
}

export async function submitDeliverableAction(
  deliverableId: string, documentId: string, note?: string | null,
): Promise<FilesResult<DeliverableView>> {
  return run(() => submitDeliverableVersion(deliverableId, documentId, note));
}

export async function decideDeliverableAction(
  deliverableId: string, decision: 'approve' | 'request-changes', comment?: string | null,
): Promise<FilesResult<DeliverableView>> {
  return run(() => decideDeliverable(deliverableId, decision, comment));
}
