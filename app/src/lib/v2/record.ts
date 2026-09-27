// The record surface's data layer, on `/api/v2` (LINA-353, S2 of the UI cutover,
// doc 22 §3). Mirrors S1's `profile.ts`: this module is ONLY the I/O and the
// fail-closed error handling; the pure wire→view transforms live in
// `./record-view.ts` so they stay unit-testable without a session.
//
// ── WHAT S2 CUTS OVER, AND WHAT IT HONESTLY LEAVES EMPTY ──────────────────────
// The v1 record read (`lib/api.ts::getRecord`) returns one four-tab projection.
// On v2 only the header and the Schedule tab have a backing read (getProject +
// getSchedule); the Plan/materials and Money/movements model was never ported to
// v2, and the audit-ledger read (`listRecord`) is registered nowhere. Under B2
// (fresh start) a fresh v2 project genuinely has none of that, so this module
// returns the two things it CAN read and the page renders the rest as honest
// "arrives with the v2 record slice" panels. See ./record-view.ts for the full
// mapping note and the tracked backend follow-up.
//
// Fail-closed exactly as S1: a `V2Error` (not mirrored yet / no active org /
// denied) is not a crash — it resolves to a null record and the page shows the
// neutral empty surface, never a leak and never a 500.
import 'server-only';

import { v2, V2Error } from './client';
import {
  toRecordHeader, toScheduleLines,
  type RecordHeaderV2, type V2Project, type V2Schedule,
} from './record-view';
import type { ScheduleLine } from '@/lib/record';

/** The record surface, re-derived from the v2 reads S2 can serve. */
export interface RecordV2 {
  projectId: string;
  name: string;
  header: RecordHeaderV2;
  schedule: ScheduleLine[];
}

/**
 * GET /api/v2/projects/{id} + /schedule → the record surface for a v2 project,
 * or null when the viewer has no resolvable access to it (not mirrored, no
 * active org, or not a participant). The two reads run concurrently; a failure
 * on either is fail-closed to null so the page renders the empty record rather
 * than crashing on a build the viewer cannot see.
 */
export async function getRecordV2(projectId: string): Promise<RecordV2 | null> {
  try {
    const [project, schedule] = await Promise.all([
      v2<V2Project>({ method: 'GET', path: `/projects/${encodeURIComponent(projectId)}` }),
      // The schedule read can legitimately deny (a participant who is not yet on
      // the plan) while the project read succeeds — treat that as an empty plan,
      // not a failure of the whole surface.
      v2<V2Schedule>({ method: 'GET', path: `/projects/${encodeURIComponent(projectId)}/schedule` })
        .catch((err) => {
          if (err instanceof V2Error) return { project_id: projectId, tasks: [] } as V2Schedule;
          throw err;
        }),
    ]);
    return {
      projectId,
      name: project.name,
      header: toRecordHeader(project, schedule.tasks),
      schedule: toScheduleLines(schedule.tasks),
    };
  } catch (err) {
    if (err instanceof V2Error) return null; // not mirrored / no access — no leak
    throw err;
  }
}
