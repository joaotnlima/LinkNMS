// The drawing viewer on `/api/v2` (PRD-06). The I/O half: every call goes
// through the shared v2 client; the pure mapping lives in `./viewer-view.ts`.
// Who may read, mark up, close, ask or raise is the modules' decision
// (documents V6, collaboration readers/addressee, quality `org:quality:inspect`)
// — a refusal comes back as a typed WorkspaceError the viewer shows as a sentence.
import 'server-only';

import { v2, V2Error } from './client';
import { WorkspaceError, workspaceMessage, type V2List } from './task-workspace-view';
import { toFileView, type FileView, type V2FileDocument } from './task-files-view';
import { toMarkupView, type MarkupView, type V2Markup, type V2Preview } from './viewer-view';

const enc = encodeURIComponent;

function asError(err: unknown): WorkspaceError {
  if (err instanceof V2Error) {
    if (err.code === 'version_conflict' && err.detail) return new WorkspaceError(err.code, err.detail, err.status);
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

/** Every markup of a document (all versions), following the cursor. */
export async function fetchMarkups(documentId: string): Promise<MarkupView[]> {
  return call(async () => {
    const out: MarkupView[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page: V2List<V2Markup> = await v2<V2List<V2Markup>>({
        method: 'GET', path: `/documents/${enc(documentId)}/markups`, query: { cursor: cursor ?? undefined, limit: 500 },
      });
      out.push(...page.items.map(toMarkupView));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    return out;
  });
}

/** Save drafts → the markups-only version n+1; answers the refreshed file and its markups. */
export async function saveMarkups(documentId: string, baseVersionNo: number, markups: unknown[], note?: string | null) {
  const key = crypto.randomUUID();
  return call(async () => {
    const res = await v2<{ document: V2FileDocument; markups: V2Markup[] }>({
      method: 'POST',
      path: `/documents/${enc(documentId)}/markups:save`,
      body: { base_version_no: baseVersionNo, markups, ...(note ? { note } : {}) },
      idempotencyKey: key,
    });
    return { file: toFileView(res.document), markups: res.markups.map(toMarkupView) };
  });
}

export async function setMarkupState(markupId: string, action: 'close' | 'reopen'): Promise<MarkupView> {
  return call(async () => toMarkupView(await v2<V2Markup>({
    method: 'POST', path: `/markups/${enc(markupId)}:${action}`, idempotencyKey: crypto.randomUUID(),
  })));
}

async function linkMarkup(markupId: string, link: { question_id: string } | { nonconformity_id: string }): Promise<MarkupView> {
  return toMarkupView(await v2<V2Markup>({
    method: 'POST', path: `/markups/${enc(markupId)}:link`, body: link, idempotencyKey: crypto.randomUUID(),
  }));
}

/**
 * V-8 "turn markup into a question to …": a Collaboration question on the
 * document's thread (its own notification to the addressee), then the markup
 * records the link. Two commands; a replay of the second is idempotent.
 */
export async function markupToQuestion(args: { markupId: string; documentId: string; addresseeOrgId: string; text: string }) {
  return call(async () => {
    const questionId = crypto.randomUUID();
    await v2({
      method: 'POST',
      path: `/threads/document/${enc(args.documentId)}/comments`,
      body: { id: questionId, kind: 'question', body: args.text, addressee_org_id: args.addresseeOrgId },
      idempotencyKey: questionId,
    });
    return linkMarkup(args.markupId, { question_id: questionId });
  });
}

/** V-8 "raise as an issue on the task": a Quality non-conformity on the task, then the link. */
export async function markupToIssue(args: { markupId: string; projectId: string; taskId: string | null; text: string; severity: 'minor' | 'major' | 'critical' }) {
  return call(async () => {
    const id = crypto.randomUUID();
    await v2({
      method: 'POST',
      path: `/projects/${enc(args.projectId)}/nonconformities`,
      body: { id, kind: 'quality', severity: args.severity, description: args.text, ...(args.taskId ? { task_id: args.taskId } : {}) },
      idempotencyKey: id,
    });
    return linkMarkup(args.markupId, { nonconformity_id: id });
  });
}

/** A short-lived inline URL the PDF renderer fetches (V-4). */
export async function fetchViewUrl(versionRef: string): Promise<string> {
  return call(async () => (await v2<{ url: string }>({ method: 'GET', path: `/document-versions/${versionRef}:view-url` })).url);
}

/** The DWG / DXF preview of a version (V-11..V-15). */
export async function fetchPreview(versionRef: string): Promise<V2Preview> {
  return call(() => v2<V2Preview>({ method: 'GET', path: `/document-versions/${versionRef}/preview` }));
}

/** The organisations a question can be addressed to: the build's participants. */
export async function fetchQuestionParties(projectId: string): Promise<Array<{ orgId: string; name: string; capacity: string | null }>> {
  return call(async () => {
    const res = await v2<V2List<{ org: { id: string; legal_name?: string }; capacity?: string }>>({
      method: 'GET', path: `/projects/${enc(projectId)}/participants`, query: { limit: 200 },
    });
    return res.items.map((p) => ({ orgId: p.org.id, name: p.org.legal_name ?? 'Organisation', capacity: p.capacity ?? null }));
  });
}

export type { FileView };
