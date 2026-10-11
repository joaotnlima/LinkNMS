'use server';

// The session-bound doors the client components of PRD-10 (the task panel's
// Run block, the phone daily-log page) reach the server-only data layer
// (`./execution.ts`) through. Every answer is a serializable `{ ok, … }`; a
// refusal carries the server's code and sentence (e.g. `predecessors_open`).
import { V2Error } from './client';
import {
  getTaskRun, reportRun, addDailyLogEntriesV2, getDailyLogV2, reserveSitePhoto, completeSitePhoto,
  type TaskRun,
} from './execution';
import type { V2DailyLog } from './execution-view';

export type RunResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string | null; message: string };

async function run<T>(fn: () => Promise<T>): Promise<RunResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof V2Error) {
      const field = err.errors ? Object.values(err.errors)[0] : null;
      const reason = typeof err.problem?.reason === 'string' ? err.problem.reason : null;
      return { ok: false, code: err.code, reason, message: err.detail ?? field ?? err.message };
    }
    return { ok: false, code: 'internal', reason: null, message: 'Something went wrong. Try again.' };
  }
}

export async function loadTaskRunAction(taskId: string): Promise<RunResult<TaskRun>> {
  return run(() => getTaskRun(taskId));
}

/** E-5: start (with the reason the server asks for when it jumps the queue). */
export async function startTaskAction(taskId: string, reason: string | null): Promise<RunResult<null>> {
  return run(async () => {
    await reportRun(taskId, { status: 'in_progress', ...(reason ? { override_reason: reason } : {}) });
    return null;
  });
}

/** E-6: close, naming the acceptance criteria that were met. */
export async function closeTaskAction(taskId: string, criteriaMet: string[], reason: string | null): Promise<RunResult<null>> {
  return run(async () => {
    await reportRun(taskId, { status: 'done', criteria_met: criteriaMet, ...(reason ? { override_reason: reason } : {}) });
    return null;
  });
}

export async function loadDailyLogAction(projectId: string, date: string): Promise<RunResult<V2DailyLog>> {
  return run(() => getDailyLogV2(projectId, date));
}

export async function sendDailyLogAction(
  projectId: string, date: string, entries: Array<Record<string, unknown>>,
): Promise<RunResult<V2DailyLog>> {
  return run(() => addDailyLogEntriesV2(projectId, date, entries));
}

export async function reserveSitePhotoAction(
  projectId: string, file: { name: string; mime: string; sizeBytes: number; sha256: string },
): Promise<RunResult<{ documentId: string; versionRef: string; uploadUrl: string }>> {
  return run(() => reserveSitePhoto(projectId, file));
}

export async function completeSitePhotoAction(versionRef: string): Promise<RunResult<null>> {
  return run(async () => { await completeSitePhoto(versionRef); return null; });
}
