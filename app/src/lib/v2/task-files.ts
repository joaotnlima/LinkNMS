// Task files, project files and deliverables on `/api/v2` (PRD-05). The I/O
// half: every call goes through the shared v2 client (`./client.ts`); the pure
// wire → view mapping lives in `./task-files-view.ts`. Authorization is the
// modules' (V6 + D-33 for files, the client-side / assignee / two-sided rules for
// deliverables, D-48 for done) — a refusal comes back as a typed WorkspaceError
// the screen renders as a sentence.
import 'server-only';

import { v2, V2Error } from './client';
import { WorkspaceError, workspaceMessage, type V2List, type V2UploadTicket } from './task-workspace-view';
import {
  toFileView, toDeliverablesView, toDeliverableView,
  type FileView, type DeliverableView, type TaskFilesView,
  type V2FileDocument, type V2TaskDeliverables, type V2Deliverable, type LinkRole, type FileType,
} from './task-files-view';

export type { TaskFilesView };

const enc = encodeURIComponent;

function asError(err: unknown): WorkspaceError {
  if (err instanceof V2Error) {
    if (err.code === 'invalid_transition' && err.detail) return new WorkspaceError(err.code, err.detail, err.status);
    return new WorkspaceError(err.code, workspaceMessage(err.code, err.detail), err.status);
  }
  return new WorkspaceError('internal', 'Something went wrong. Try again.', 500);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asError(err);
  }
}

/** The Files tab in one round: the task's files + its deliverables (two module reads). */
export async function fetchTaskFiles(taskId: string): Promise<TaskFilesView> {
  return call(async () => {
    const [docs, dels] = await Promise.all([
      v2<V2List<V2FileDocument>>({ method: 'GET', path: `/tasks/${enc(taskId)}/documents` }),
      v2<V2TaskDeliverables>({ method: 'GET', path: `/tasks/${enc(taskId)}/deliverables` }),
    ]);
    return { taskId, files: docs.items.map(toFileView), deliverables: toDeliverablesView(dels) };
  });
}

/** One page of the project's files (F-9 picker, F-19 page). */
export async function fetchProjectFiles(
  projectId: string, opts: { q?: string; type?: FileType | null; cursor?: string | null; limit?: number } = {},
): Promise<{ files: FileView[]; nextCursor: string | null }> {
  return call(async () => {
    const res = await v2<V2List<V2FileDocument>>({
      method: 'GET',
      path: `/projects/${enc(projectId)}/documents`,
      query: {
        q: opts.q?.trim() || undefined, type: opts.type || undefined,
        cursor: opts.cursor ?? undefined, limit: opts.limit ?? 100,
      },
    });
    return { files: res.items.map(toFileView), nextCursor: res.next_cursor };
  });
}

export async function fetchProjectDeliverables(projectId: string): Promise<V2Deliverable[]> {
  return call(async () => (await v2<V2List<V2Deliverable>>({
    method: 'GET', path: `/projects/${enc(projectId)}/deliverables`,
  })).items);
}

export interface FileDeclaration { name: string; mime: string; sizeBytes: number; sha256: string }

const fileBody = (f: FileDeclaration) => ({
  name: f.name, mime: f.mime, size_bytes: f.sizeBytes, sha256: f.sha256.toLowerCase(),
});

/**
 * Reserve a NEW project file linked to the task (one call, F-6): the document is
 * scoped to the project and linked — never copied — to the task, optionally on
 * every sub-task. Answers the ticket the browser PUTs to.
 */
export async function reserveProjectFile(args: {
  projectId: string; taskId: string; file: FileDeclaration; role: LinkRole; includeSubtasks: boolean;
  kind: string; note?: string | null;
}): Promise<{ versionRef: string; uploadUrl: string }> {
  const id = crypto.randomUUID();
  return call(async () => {
    const t = await v2<V2UploadTicket>({
      method: 'POST',
      path: '/documents',
      body: {
        id, scope_type: 'project', scope_id: args.projectId, kind: args.kind,
        title: args.file.name, file: fileBody(args.file),
        ...(args.note ? { note: args.note } : {}),
        link: { task_id: args.taskId, role: args.role, include_subtasks: args.includeSubtasks },
      },
      idempotencyKey: id,
    });
    return { versionRef: t.document_version_id, uploadUrl: t.upload_url };
  });
}

/** Reserve the next version of an existing file (F-8 "new version of X"). */
export async function reserveNewVersion(documentId: string, file: FileDeclaration, note?: string | null) {
  return call(async () => {
    const t = await v2<V2UploadTicket>({
      method: 'POST',
      path: `/documents/${enc(documentId)}/versions`,
      body: { file: fileBody(file), ...(note ? { note } : {}) },
    });
    return { versionRef: t.document_version_id, uploadUrl: t.upload_url };
  });
}

/** Prove the bytes landed (the version becomes visible everywhere). */
export async function completeFile(versionRef: string): Promise<void> {
  await call(() => v2({ method: 'POST', path: `/document-versions/${versionRef}:complete` }));
}

export async function linkFiles(taskId: string, documentIds: string[], role: LinkRole, includeSubtasks: boolean) {
  await call(() => v2({
    method: 'POST', path: `/tasks/${enc(taskId)}/document-links`,
    body: { document_ids: documentIds, role, include_subtasks: includeSubtasks },
  }));
}

export async function unlinkFile(taskId: string, documentId: string) {
  await call(() => v2({ method: 'DELETE', path: `/tasks/${enc(taskId)}/document-links/${enc(documentId)}` }));
}

export async function addDeliverable(taskId: string, title: string, required: boolean): Promise<DeliverableView> {
  const id = crypto.randomUUID();
  return call(async () => toDeliverableView(await v2<V2Deliverable>({
    method: 'POST', path: `/tasks/${enc(taskId)}/deliverables`, body: { id, title, required }, idempotencyKey: id,
  })));
}

export async function removeDeliverable(deliverableId: string) {
  await call(() => v2({ method: 'DELETE', path: `/deliverables/${enc(deliverableId)}` }));
}

export async function submitDeliverableVersion(deliverableId: string, documentId: string, note?: string | null) {
  return call(async () => toDeliverableView(await v2<V2Deliverable>({
    method: 'POST', path: `/deliverables/${enc(deliverableId)}:submit`,
    body: { document_id: documentId, ...(note ? { note } : {}) },
  })));
}

export async function decideDeliverable(deliverableId: string, decision: 'approve' | 'request-changes', comment?: string | null) {
  return call(async () => toDeliverableView(await v2<V2Deliverable>({
    method: 'POST', path: `/deliverables/${enc(deliverableId)}:${decision}`,
    body: comment ? { comment } : {},
  })));
}
