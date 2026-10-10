// The per-task procurement projection — pure (no I/O), PRD-01 G-2/G-3,
// schema #/components/schemas/TaskProcurement.
//
// The plan's Tender column and Gantt band need, for every tendered root task,
// ONE governing RFP and a handful of facts about it. The store hands this code
// every (root task, RFP) pair of the issuer's tenders on the project, each with
// its lane-status histogram; the rules that turn that into the row's state live
// here, not in the client:
//   - which RFP governs a row that was tendered more than once (a re-tender,
//     a design RFP then an execution one, a cancelled one then a fresh one);
//   - which lane statuses count as a LANDED bid (what flips "out for bids"
//     into "bids in").
// No money ever reaches this code (D-06/D-07): counts and the winner's name.

/** Lane statuses whose bid has landed — the `n` of the grid's `n/m in`. */
export const LANDED_BID_STATUSES = Object.freeze(['submitted', 'shortlisted', 'awarded']);

export function isLandedBid(status) {
  return LANDED_BID_STATUSES.includes(status);
}

/**
 * Order candidate RFPs of one row, governing first: an awarded tender is the
 * outcome the schedule commits to; otherwise the newest LIVE one; a cancelled
 * tender governs only a row with nothing else (the column still says
 * "Cancelled" — PRD-01 G-2). Ties break on id so the pick is deterministic.
 */
export function compareGoverning(a, b) {
  const rank = (r) => (r.status === 'awarded' ? 0 : r.status === 'cancelled' ? 2 : 1);
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const byNewest = timeOf(b.created_at) - timeOf(a.created_at);
  if (byNewest !== 0) return byNewest;
  return String(a.id).localeCompare(String(b.id));
}

/** Fold a lane-status histogram ({status: count}) into the two counts. */
export function laneCounts(histogram) {
  let invited = 0;
  let submitted = 0;
  for (const [status, n] of Object.entries(histogram ?? {})) {
    const count = Number(n) || 0;
    invited += count;
    if (isLandedBid(status)) submitted += count;
  }
  return { invited, submitted };
}

/**
 * @param rows  one per (task_id, RFP) pair: the RFP columns (id, title, status,
 *              created_at, submission_deadline, root_task_ids, excluded_task_ids,
 *              the lifecycle stamps, cancel_reason) + `lane_counts`
 *              ({status: n}) + `awarded_org_id` / `awarded_name`
 * @returns     TaskProcurement[] — one per task, ordered by task id
 */
export function taskProcurement(rows) {
  const byTask = new Map();
  for (const row of rows) {
    const current = byTask.get(row.task_id);
    if (!current || compareGoverning(row, current) < 0) byTask.set(row.task_id, row);
  }
  return [...byTask.keys()].sort().map((taskId) => taskProcurementBody(byTask.get(taskId)));
}

/** #/components/schemas/TaskProcurement for one governing (task, RFP) row. */
export function taskProcurementBody(row) {
  const { invited, submitted } = laneCounts(row.lane_counts);
  const awarded = row.status === 'awarded' && row.awarded_name;
  return {
    task_id: row.task_id,
    rfp_id: row.id,
    title: row.title,
    status: row.status,
    opened_at: iso(row.created_at),
    submission_deadline: iso(row.submission_deadline),
    root_task_ids: [...(row.root_task_ids ?? [])],
    excluded_task_ids: [...(row.excluded_task_ids ?? [])],
    published_at: iso(row.published_at),
    closed_at: iso(row.closed_at),
    awarded_at: iso(row.awarded_at),
    cancelled_at: iso(row.cancelled_at),
    cancel_reason: row.status === 'cancelled' ? (row.cancel_reason ?? null) : null,
    invited_count: invited,
    submitted_count: submitted,
    awarded_to: awarded ? { org_id: row.awarded_org_id ?? null, name: row.awarded_name } : null,
  };
}

function timeOf(value) {
  const t = new Date(value ?? 0).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
