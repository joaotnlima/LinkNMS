// The Excel import's data layer on `/api/v2` (PRD-09 O-6..O-12). I/O only: the
// workbook is parsed by the planning module (server-side, exceljs); these calls
// carry the file, the sheet + mapping, and the confirm. Writes rethrow
// (`V2Error`) so the actions can put the server's sentence beside the control.
import 'server-only';

import { v2, V2Error } from './client';
import type { ImportField, V2ScheduleImport } from './plan-import-view';

const enc = encodeURIComponent;

export function uploadPlanWorkbook(projectId: string, file: { filename: string; contentType: string; bytes: Uint8Array }): Promise<V2ScheduleImport> {
  return v2<V2ScheduleImport>({ method: 'POST', path: `/projects/${enc(projectId)}/schedule-imports`, multipart: { file } });
}

export async function getPlanImport(importId: string): Promise<V2ScheduleImport | null> {
  try {
    return await v2<V2ScheduleImport>({ method: 'GET', path: `/schedule-imports/${enc(importId)}` });
  } catch (err) {
    if (err instanceof V2Error) return null;
    throw err;
  }
}

export function mapPlanImport(importId: string, sheet: string, mapping: Partial<Record<ImportField, number>>): Promise<V2ScheduleImport> {
  return v2<V2ScheduleImport>({ method: 'POST', path: `/schedule-imports/${enc(importId)}:map`, body: { sheet, mapping } });
}

export function previewPlanImport(importId: string): Promise<V2ScheduleImport> {
  return v2<V2ScheduleImport>({ method: 'POST', path: `/schedule-imports/${enc(importId)}:preview` });
}

export function confirmPlanImport(importId: string): Promise<unknown> {
  return v2<unknown>({ method: 'POST', path: `/schedule-imports/${enc(importId)}:confirm`, idempotencyKey: `import-${importId}` });
}
