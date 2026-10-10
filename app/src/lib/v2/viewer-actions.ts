'use server';

// The session-bound door the CLIENT drawing viewer reaches the server-only data
// layer (`./viewer.ts`) through — the same pattern as `task-files-actions.ts`:
// the authored intent crosses the boundary, the privilege does not, and every
// answer is a serializable `{ ok, … }`.
import {
  fetchMarkups, saveMarkups, setMarkupState, markupToQuestion, markupToIssue,
  fetchViewUrl, fetchPreview, fetchQuestionParties,
} from './viewer';
import { WorkspaceError } from './task-workspace-view';
import type { FileView } from './task-files-view';
import type { MarkupView, V2Preview } from './viewer-view';

export type ViewerResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

async function run<T>(fn: () => Promise<T>): Promise<ViewerResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof WorkspaceError) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: 'internal', message: 'Something went wrong. Try again.' };
  }
}

export async function loadMarkupsAction(documentId: string): Promise<ViewerResult<MarkupView[]>> {
  return run(() => fetchMarkups(documentId));
}

export async function saveMarkupsAction(
  documentId: string, baseVersionNo: number, markups: unknown[],
): Promise<ViewerResult<{ file: FileView; markups: MarkupView[] }>> {
  return run(() => saveMarkups(documentId, baseVersionNo, markups));
}

export async function markupStateAction(markupId: string, action: 'close' | 'reopen'): Promise<ViewerResult<MarkupView>> {
  return run(() => setMarkupState(markupId, action));
}

export async function markupToQuestionAction(args: {
  markupId: string; documentId: string; addresseeOrgId: string; text: string;
}): Promise<ViewerResult<MarkupView>> {
  return run(() => markupToQuestion(args));
}

export async function markupToIssueAction(args: {
  markupId: string; projectId: string; taskId: string | null; text: string; severity: 'minor' | 'major' | 'critical';
}): Promise<ViewerResult<MarkupView>> {
  return run(() => markupToIssue(args));
}

export async function viewUrlAction(versionRef: string): Promise<ViewerResult<string>> {
  return run(() => fetchViewUrl(versionRef));
}

export async function previewAction(versionRef: string): Promise<ViewerResult<V2Preview>> {
  return run(() => fetchPreview(versionRef));
}

export async function questionPartiesAction(projectId: string): Promise<ViewerResult<Array<{ orgId: string; name: string; capacity: string | null }>>> {
  return run(() => fetchQuestionParties(projectId));
}
