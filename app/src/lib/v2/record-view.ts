// Pure v2-wire → view transforms for the record surface (LINA-353, S2 of the UI
// cutover, doc 22 §3). Split out of `record.ts` (which does the I/O and imports
// `server-only`) so the mapping is unit-testable without a session or a router —
// the same discipline as `profile-view.ts` (S1) and `lib/view.ts` on the v1 side.
//
// ── WHAT S2 CAN AND CANNOT MAP (doc 22 §3, verified against the live v2 backend)
// The v1 record is four tabs from one `getRecord` projection. On v2 only two of
// those four have a backing read:
//
//  • Header / state ← `GET /projects/{id}` + the schedule's baseline stamp.
//  • Schedule tab   ← `GET /projects/{id}/schedule` (planning). The v2 task
//    `status` enum is `not_started|in_progress|done|blocked` — identical to the
//    v1 `ProgressStatus`, so it maps straight across.
//
// The Plan (materials) and Money (movements) tabs read the Slice-B3
// materials/movements model, which was NEVER ported to a v2 module. Under B2
// (fresh start) a fresh v2 project has no materials and no movements, so this
// module deliberately produces NOTHING for those two tabs rather than inventing
// it. When that backend lands, this file gains their transforms.
//
// The History tab reads `listRecord` (the audit-ledger projection), which is
// LIVE on v2 as of LINA-363: `toHistoryEntries` below maps its AuditEntry wire
// into the row the page renders. Out-of-scope entries arrive redacted (payload
// withheld, `redacted: true`) but keep their seq/type/hashes, so the tab shows
// the shape of every change while withholding the detail of the ones the viewer
// is not party to.
import type { ProgressStatus, ScheduleLine } from '@/lib/record';

// ── The v2 wire shapes we read (subset) ──────────────────────────────────────
// Verbatim against modules/planning/application/projection.mjs::taskBody and
// modules/project use-case bodies / cowork/documentation/api/v2/openapi.yaml.

/** v2 task `status` — the SAME four words as v1 `ProgressStatus` (see note). */
export type V2TaskStatus = ProgressStatus;

export interface V2ScheduleTask {
  id: string;
  name: string;
  /** Fractional-string ordering key; the schedule read already returns tasks sorted by it. */
  position: string;
  depth: number;
  start: string | null;
  finish: string | null;
  status: V2TaskStatus;
  baseline: { start: string | null; finish: string | null; version: number } | null;
}

export interface V2Schedule {
  project_id: string;
  tasks: V2ScheduleTask[];
}

// project.project.status enum (modules/project/domain/lifecycle.mjs).
export type V2ProjectStatus =
  | 'draft' | 'tendering' | 'contracted' | 'in_execution' | 'closed' | 'cancelled';

export interface V2Project {
  id: string;
  name: string;
  status: V2ProjectStatus;
}

// ── Header / state ────────────────────────────────────────────────────────────

/**
 * The record header, re-derived from the two v2 reads. `state` stays a v1
 * `LineState` so the badge/copy on the page are unchanged, but only the two
 * states v2 can HONESTLY assert are ever produced:
 *   - `accepted` ("as agreed") — the default; nothing has been recorded against
 *     a fresh v2 project, so "as agreed" is the truthful reading.
 *   - `deviation` is NOT asserted here: it means "a material movement has been
 *     recorded", and v2 carries no movement model to have recorded one. Claiming
 *     it from schedule status would be the UI inventing a deviation nobody filed.
 * `closed_and_verified` is likewise never emitted (it needs a verification stamp
 * the record does not carry — same reason as v1, contract §7).
 */
export interface RecordHeaderV2 {
  state: 'accepted';
  /**
   * The baseline the schedule is measured against, or null. v2's schedule
   * baseline carries a `version` but no freeze timestamp, so `frozenAt` is null
   * and the caption omits the date rather than inventing one.
   */
  baseline: { versionNo: number; frozenAt: string | null } | null;
}

/**
 * Derive the header from the project and its schedule. A baseline is reported
 * only when at least one dated task actually carries one — the highest baseline
 * `version` across the plan. No dated baseline anywhere → `null`, which the page
 * renders as "No baseline yet", the honest B2 reading.
 */
export function toRecordHeader(_project: V2Project, tasks: V2ScheduleTask[]): RecordHeaderV2 {
  let versionNo: number | null = null;
  for (const t of tasks) {
    if (t.baseline && (t.baseline.start || t.baseline.finish)) {
      versionNo = versionNo == null ? t.baseline.version : Math.max(versionNo, t.baseline.version);
    }
  }
  return {
    state: 'accepted',
    baseline: versionNo == null ? null : { versionNo, frozenAt: null },
  };
}

// ── Schedule tab ────────────────────────────────────────────────────────────

const STATUSES: readonly ProgressStatus[] = ['not_started', 'in_progress', 'done', 'blocked'];

/** A v2 status that fell outside the known enum reads as `not_started` rather
 *  than leaking an unknown string into the badge — the same fail-safe the page's
 *  `progressLabel` already applies. */
function toProgressStatus(status: string): ProgressStatus {
  return (STATUSES as readonly string[]).includes(status) ? (status as ProgressStatus) : 'not_started';
}

/**
 * v2 schedule tasks → the v1 `ScheduleLine[]` the Schedule tab renders. The
 * schedule read returns tasks already sorted by `position`, so the line's
 * numeric `position` is just the array index — the page re-sorts by it, and the
 * index preserves the v2 order the server chose. `percent` is null: the v2
 * schedule projection carries per-task status but not a rollup percent (that is
 * on the per-task `progress` read), and a made-up percent beside the status
 * word would be a second, unfounded claim.
 */
export function toScheduleLines(tasks: V2ScheduleTask[]): ScheduleLine[] {
  return tasks.map((t, i) => ({
    stageId: t.id,
    name: t.name,
    position: i,
    plannedStartDate: t.start,
    plannedEndDate: t.finish,
    status: toProgressStatus(t.status),
    percent: null,
  }));
}

// ── History tab (the audit ledger, projected) ─────────────────────────────────
// The AuditEntry of cowork/documentation/api/v2/openapi.yaml, as listRecord
// returns it. `payload` is absent on a redacted entry; `redacted` says which.

export interface V2Actor {
  person_id: string | null;
  org_id: string | null;
  org_role: string | null;
}

export interface V2AuditEntry {
  seq: number;
  occurred_at: string;
  category: string;
  type: string;
  actor: V2Actor;
  object_type: string;
  object_id: string;
  payload?: unknown;
  redacted: boolean;
  entry_hash: string;
  prev_hash: string | null;
}

/** One row of the History tab: who did what, when, and whether the detail is in
 *  the viewer's scope. Kept flat and presentational — the page renders it, the
 *  chain fields stay so a reader can verify locally. */
export interface HistoryEntry {
  seq: number;
  occurredAt: string;
  /** A human label for `type`, e.g. "Change order decided". */
  action: string;
  /** The dotted event type, verbatim, for the reader who wants the exact key. */
  eventType: string;
  /** Who acted — the org role at the moment, e.g. "site_lead", or null. */
  actorRole: string | null;
  objectType: string;
  redacted: boolean;
  entryHash: string;
}

/** Humanise a dotted event `type` ("contracting.change_order.decided") into a
 *  short sentence ("Change order decided"). Falls back to the raw type so an
 *  event we have not seen a phrasing for is still legible, never blank. */
export function humaniseEventType(type: string): string {
  const parts = type.split('.');
  // drop the leading category ("contracting", "planning", …) — the row already
  // carries enough context; the noun+verb tail is the readable part.
  const tail = parts.length > 1 ? parts.slice(1) : parts;
  const words = tail.join(' ').replace(/_/g, ' ').trim();
  if (!words) return type;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** listRecord items → History rows, newest-first as the server returns them. */
export function toHistoryEntries(items: V2AuditEntry[]): HistoryEntry[] {
  return items.map((e) => ({
    seq: e.seq,
    occurredAt: e.occurred_at,
    action: humaniseEventType(e.type),
    eventType: e.type,
    actorRole: e.actor?.org_role ?? null,
    objectType: e.object_type,
    redacted: e.redacted,
    entryHash: e.entry_hash,
  }));
}
