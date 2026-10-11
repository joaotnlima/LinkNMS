// Pure wire → view mapping for the plan's per-task procurement projection
// (`GET /projects/{projectId}/task-procurement`, operationId
// listTaskProcurement — PRD-01 G-2/G-3, LINA-413). Split from `tendering.ts`
// (the I/O, `server-only`) so it is unit-testable without a session.
//
// The server owns every rule here: which RFP governs a row, which lane states
// count as a landed bid, who won. This file only renames fields into the
// `ProcurementRfp` view model the plan grid and Gantt already consume, and
// trims timestamps to the schedule's calendar days.

import type { ProcurementRfp } from '../plan-gantt';
import type { RfpStatus } from './tendering-view';

/** #/components/schemas/TaskProcurement, verbatim. */
export interface V2TaskProcurement {
  task_id: string;
  rfp_id: string;
  title: string;
  status: RfpStatus;
  opened_at: string;
  submission_deadline: string;
  root_task_ids: string[];
  invited_count: number;
  submitted_count: number;
  awarded_to: { org_id: string | null; name: string } | null;
  /** PRD-02 additions (absent on an older server). */
  excluded_task_ids?: string[];
  published_at?: string | null;
  closed_at?: string | null;
  awarded_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  /** PRD-08 H-7 (absent on an older server). */
  open_question_count?: number;
}

/** The projection's items → the plan's `procurement` map, keyed by task id. */
export function toProcurementWindows(
  items: readonly V2TaskProcurement[],
): Record<string, ProcurementRfp> {
  const windows: Record<string, ProcurementRfp> = {};
  for (const item of items) {
    if (!item.opened_at || !item.submission_deadline) continue; // nothing to paint
    windows[item.task_id] = {
      status: item.status,
      openedDay: item.opened_at.slice(0, 10),
      bidsDueDay: item.submission_deadline.slice(0, 10),
      submittedCount: item.submitted_count,
      invitedCount: item.invited_count,
      ...(item.title ? { title: item.title } : {}),
      ...(item.awarded_to?.name ? { awardedTo: item.awarded_to.name } : {}),
      rfpId: item.rfp_id,
      ...(item.excluded_task_ids?.length ? { excludedTaskIds: [...item.excluded_task_ids] } : {}),
      ...(item.cancel_reason ? { cancelReason: item.cancel_reason } : {}),
      ...(item.open_question_count ? { openQuestions: item.open_question_count } : {}),
    };
  }
  return windows;
}
