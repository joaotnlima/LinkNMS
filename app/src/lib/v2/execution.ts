// Running the plan on `/api/v2` (PRD-10): the baseline selector, what a task
// waits on and its acceptance checklist, the daily log and the site calendar.
// The I/O half — every call through the shared v2 client; the pure mapping is
// `./execution-view.ts`. Reads that feed a whole page fail closed (empty);
// writes rethrow the V2Error so the action can say why.
import 'server-only';

import { v2, V2Error } from './client';
import type { V2UploadTicket } from './task-workspace-view';
import type {
  V2Baseline, V2DailyLog, V2DailyLogDay, V2DailyLogEntry, V2SiteCalendar, V2WaitingOn,
} from './execution-view';

const enc = encodeURIComponent;

async function orEmpty<T>(p: Promise<T>, empty: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof V2Error) return empty;
    throw err;
  }
}

/** The plan header's selector (E-1). Empty when the viewer cannot read the build. */
export function listBaselinesV2(projectId: string): Promise<V2Baseline[]> {
  return orEmpty(
    v2<{ items: V2Baseline[] }>({ method: 'GET', path: `/projects/${enc(projectId)}/baselines` }).then((r) => r.items ?? []),
    [],
  );
}

export interface TaskRun {
  status: string;
  waitingOn: V2WaitingOn[];
  checklist: string[];
  log: V2DailyLogEntry[];
}

/** The task panel's Run block (E-5, E-6, E-9): one task read + its daily-log entries. */
export async function getTaskRun(taskId: string): Promise<TaskRun> {
  const [task, log] = await Promise.all([
    v2<{ status?: string; waiting_on?: V2WaitingOn[]; acceptance_checklist?: string[] }>({
      method: 'GET', path: `/tasks/${enc(taskId)}`,
    }),
    v2<{ items: V2DailyLogEntry[] }>({ method: 'GET', path: `/tasks/${enc(taskId)}/daily-log-entries` }),
  ]);
  return {
    status: task.status ?? 'not_started',
    waitingOn: task.waiting_on ?? [],
    checklist: task.acceptance_checklist ?? [],
    log: log.items ?? [],
  };
}

/** One progress report with the PRD-10 fields (override_reason, criteria_met). */
export async function reportRun(taskId: string, body: {
  status: 'in_progress' | 'blocked' | 'done'; override_reason?: string; criteria_met?: string[];
}): Promise<void> {
  await v2({ method: 'POST', path: `/tasks/${enc(taskId)}/progress`, body });
}

export function getDailyLogV2(projectId: string, date: string): Promise<V2DailyLog> {
  return v2<V2DailyLog>({ method: 'GET', path: `/projects/${enc(projectId)}/daily-logs/${enc(date)}` });
}

export function listDailyLogsV2(projectId: string, from?: string, to?: string): Promise<V2DailyLogDay[]> {
  return orEmpty(
    v2<{ items: V2DailyLogDay[] }>({
      method: 'GET', path: `/projects/${enc(projectId)}/daily-logs`, query: { from, to },
    }).then((r) => r.items ?? []),
    [],
  );
}

export function addDailyLogEntriesV2(projectId: string, date: string, entries: Array<Record<string, unknown>>): Promise<V2DailyLog> {
  return v2<V2DailyLog>({
    method: 'POST', path: `/projects/${enc(projectId)}/daily-logs/${enc(date)}/entries`, body: { entries },
  });
}

export function getSiteCalendarV2(projectId: string, from?: string, to?: string): Promise<V2SiteCalendar> {
  return v2<V2SiteCalendar>({ method: 'GET', path: `/projects/${enc(projectId)}/site-calendar`, query: { from, to } });
}

export interface V2Location { id: string; name: string }

export function listLocationsV2(projectId: string): Promise<V2Location[]> {
  return orEmpty(
    v2<{ items: V2Location[] }>({ method: 'GET', path: `/projects/${enc(projectId)}/locations`, query: { limit: 200 } }).then((r) => r.items ?? []),
    [],
  );
}

/**
 * Reserve a site photo (E-8): a project document of kind `photo` — the same
 * documents upload flow as any file (reserve → PUT → complete). The daily-log
 * entry tags it to a task / location; the file is not linked here.
 */
export async function reserveSitePhoto(projectId: string, file: { name: string; mime: string; sizeBytes: number; sha256: string }) {
  const id = crypto.randomUUID();
  const t = await v2<V2UploadTicket>({
    method: 'POST',
    path: '/documents',
    body: {
      id, scope_type: 'project', scope_id: projectId, kind: 'photo', title: file.name,
      file: { name: file.name, mime: file.mime, size_bytes: file.sizeBytes, sha256: file.sha256.toLowerCase() },
    },
    idempotencyKey: id,
  });
  return { documentId: id, versionRef: t.document_version_id, uploadUrl: t.upload_url };
}

export async function completeSitePhoto(versionRef: string): Promise<void> {
  await v2({ method: 'POST', path: `/document-versions/${versionRef}:complete` });
}
