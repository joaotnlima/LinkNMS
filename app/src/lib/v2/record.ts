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
  toRecordHeader, toScheduleLines, toHistoryLines,
  type RecordHeaderV2, type V2Project, type V2Schedule,
  type V2AuditEntry, type RecordHistoryLineV2, type V2ChainVerification,
} from './record-view';
import type { ScheduleLine } from '@/lib/record';

/** The record surface, re-derived from the v2 reads S2 can serve. */
export interface RecordV2 {
  projectId: string;
  name: string;
  header: RecordHeaderV2;
  schedule: ScheduleLine[];
  /** The audit ledger, newest first, V7-redacted (LINA-359). */
  history: RecordHistoryLineV2[];
}

/** The `listRecord` page shape (OpenAPI: Page + items[]). */
interface RecordPageV2 { items: V2AuditEntry[]; next_cursor: string | null }

/**
 * GET /api/v2/projects/{id} + /schedule → the record surface for a v2 project,
 * or null when the viewer has no resolvable access to it (not mirrored, no
 * active org, or not a participant). The two reads run concurrently; a failure
 * on either is fail-closed to null so the page renders the empty record rather
 * than crashing on a build the viewer cannot see.
 */
export async function getRecordV2(projectId: string): Promise<RecordV2 | null> {
  try {
    const [project, schedule, ledger] = await Promise.all([
      v2<V2Project>({ method: 'GET', path: `/projects/${encodeURIComponent(projectId)}` }),
      // The schedule read can legitimately deny (a participant who is not yet on
      // the plan) while the project read succeeds — treat that as an empty plan,
      // not a failure of the whole surface.
      v2<V2Schedule>({ method: 'GET', path: `/projects/${encodeURIComponent(projectId)}/schedule` })
        .catch((err) => {
          if (err instanceof V2Error) return { project_id: projectId, tasks: [] } as V2Schedule;
          throw err;
        }),
      // The ledger read (LINA-359): the first page, newest first. A denial here
      // is an empty history, not a failure of the whole surface — same rule as
      // the schedule read above.
      v2<RecordPageV2>({ method: 'GET', path: `/projects/${encodeURIComponent(projectId)}/record` })
        .catch((err) => {
          if (err instanceof V2Error) return { items: [], next_cursor: null } as RecordPageV2;
          throw err;
        }),
    ]);
    return {
      projectId,
      name: project.name,
      header: toRecordHeader(project, schedule.tasks),
      schedule: toScheduleLines(schedule.tasks),
      history: toHistoryLines(ledger.items),
    };
  } catch (err) {
    if (err instanceof V2Error) return null; // not mirrored / no access — no leak
    throw err;
  }
}

// ── The Audit surface (LINA-382, Phase 12b.3) ─────────────────────────────────
// `/projects/{id}/audit` is the History rail section: the WHOLE hash chain in
// order, with the integrity verdict made tangible. It reads the same v2 ledger
// as the record page's History tab (`listRecord`, LINA-359) but is the fuller
// tamper-evidence view, so it (a) pages through the entire chain rather than the
// first page, and (b) also calls `record:verify` for the chain verdict — v2's
// split-out equivalent of the v1 `getAudit` response's inline `verified` field.

/** Rows per `listRecord` page; capped so a pathologically long ledger cannot
 *  loop unbounded. verifyRecord still reports the TRUE length/head over the whole
 *  chain, so the banner stays accurate even when the displayed rows are capped. */
const AUDIT_PAGE_LIMIT = 200;
const AUDIT_MAX_PAGES = 25; // up to 5,000 displayed entries

/** The Audit surface for one v2 build: the projected ledger + the chain verdict. */
export interface AuditV2 {
  projectId: string;
  /** The chain, newest first, V7-redacted (the page re-sorts ascending). */
  events: RecordHistoryLineV2[];
  /** The whole-chain integrity verdict (from `record:verify`). */
  verified: boolean;
  /** The head hash of the whole chain, or null on an empty ledger. */
  headHash: string | null;
  /** The TRUE entry count over the whole chain (may exceed `events.length`). */
  length: number;
  /** The seq at which the chain first breaks, or null when it verifies. */
  firstInvalidSeq: number | null;
  /** True when the display was capped before the whole chain was fetched. */
  truncated: boolean;
}

/**
 * The Audit surface for a v2 project, or null when the viewer has no resolvable
 * access to it (not mirrored, no active org, or not a participant → the backend
 * 404s the whole surface). Fail-closed exactly as `getRecordV2`: a `V2Error`
 * resolves to null and the page renders the neutral empty surface, never a leak
 * and never a 500.
 */
export async function getAuditV2(projectId: string): Promise<AuditV2 | null> {
  const enc = encodeURIComponent(projectId);
  try {
    // The verdict and the first page run together; the verdict covers the WHOLE
    // chain server-side regardless of how many pages we then walk for display.
    const [verify, firstPage] = await Promise.all([
      v2<V2ChainVerification>({ method: 'POST', path: `/projects/${enc}/record:verify` }),
      v2<RecordPageV2>({ method: 'GET', path: `/projects/${enc}/record`, query: { limit: AUDIT_PAGE_LIMIT } }),
    ]);

    const items: V2AuditEntry[] = [...firstPage.items];
    let cursor = firstPage.next_cursor;
    let pages = 1;
    let truncated = false;
    while (cursor) {
      if (pages >= AUDIT_MAX_PAGES) { truncated = true; break; }
      const page = await v2<RecordPageV2>({
        method: 'GET', path: `/projects/${enc}/record`,
        query: { limit: AUDIT_PAGE_LIMIT, cursor },
      });
      items.push(...page.items);
      cursor = page.next_cursor;
      pages += 1;
    }

    return {
      projectId,
      events: toHistoryLines(items),
      verified: verify.valid,
      headHash: verify.head || null,
      length: verify.length,
      firstInvalidSeq: verify.first_invalid_seq,
      truncated,
    };
  } catch (err) {
    if (err instanceof V2Error) return null; // not mirrored / no access — no leak
    throw err;
  }
}
