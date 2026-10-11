'use server';

// The Excel import's writes (PRD-09 O-6..O-9). Thin: carry the file, the
// sheet + mapping and the confirm to the planning module, and hand its answer
// (or its sentence) back to the screen. Parsing, the required-mapping rule, the
// empty-plan rule and the record stamp are all the server's.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { V2Error } from '@/lib/v2/client';
import {
  uploadPlanWorkbook, mapPlanImport, previewPlanImport, confirmPlanImport,
} from '@/lib/v2/plan-import';
import type { ImportField, V2ScheduleImport } from '@/lib/v2/plan-import-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImportActionState { error?: string; view?: V2ScheduleImport }

function sentence(err: unknown, fallback: string): string {
  if (err instanceof V2Error) {
    const field = err.errors ? Object.values(err.errors)[0] : null;
    return field ? `${fallback}: ${field}.` : `${fallback}: ${err.message}`;
  }
  return fallback;
}

/** Screen 8 → screen 9: upload the workbook, land on its mapper. */
export async function uploadPlanAction(_prev: ImportActionState, form: FormData): Promise<ImportActionState> {
  const projectId = String(form.get('projectId') ?? '');
  const file = form.get('file');
  if (!UUID.test(projectId)) return { error: 'This build could not be found.' };
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose the .xlsx file of your plan.' };
  if (!/\.xlsx$/i.test(file.name)) return { error: 'Only .xlsx workbooks — in Excel, “Save as” → “Excel Workbook (.xlsx)”.' };
  let id: string;
  try {
    const view = await uploadPlanWorkbook(projectId, {
      filename: file.name, contentType: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()),
    });
    id = view.id;
  } catch (err) {
    return { error: sentence(err, 'Couldn’t read that file') };
  }
  redirect(`/projects/${projectId}/plan/import/${id}`);
}

/** Screen 9: every mapping change answers the live 10-row sample. */
export async function mapPlanAction(importId: string, sheet: string, mapping: Partial<Record<ImportField, number>>): Promise<ImportActionState> {
  if (!UUID.test(importId)) return { error: 'This import could not be found.' };
  try {
    return { view: await mapPlanImport(importId, sheet, mapping) };
  } catch (err) {
    return { error: sentence(err, 'Couldn’t apply that mapping') };
  }
}

/** Screen 9 → 10: the WBS tree, counts and warnings. */
export async function previewPlanAction(importId: string): Promise<ImportActionState> {
  if (!UUID.test(importId)) return { error: 'This import could not be found.' };
  try {
    return { view: await previewPlanImport(importId) };
  } catch (err) {
    return { error: sentence(err, 'Couldn’t preview the import') };
  }
}

/** Screen 10 → 11: write it, then the plan with the "plan imported" stamp. */
export async function confirmPlanAction(projectId: string, importId: string): Promise<ImportActionState> {
  if (!UUID.test(importId) || !UUID.test(projectId)) return { error: 'This import could not be found.' };
  try {
    await confirmPlanImport(importId);
  } catch (err) {
    if (err instanceof V2Error && (err.problem as { reason?: string } | null)?.reason === 'plan_not_empty') {
      return { error: 'This build already has a plan. Importing into an existing plan (as a reviewed diff) is coming; for now the import goes into an empty plan only.' };
    }
    return { error: sentence(err, 'Couldn’t import the plan') };
  }
  revalidatePath(`/projects/${projectId}/plan`);
  redirect(`/projects/${projectId}/plan?imported=${importId}`);
}
