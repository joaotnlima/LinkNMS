// The tendering home projection — pure (no I/O), PRD-08 H-1,
// schema #/components/schemas/ProjectRfp.
//
// The store hands one row per RFP of the project the viewer's org can see
// (issued; or, once sent, invited to / bidding on), each with its package
// roots, lane-status histogram and open-question count. The rules that decide
// what each viewer may read of it live here:
//   - the issuer gets the counts (`n/m in`, open questions) and the winner;
//   - a bidder gets its own lane and NOTHING about the other bidders (V8) —
//     not even how many there are.
// No money ever reaches this code.
import { rfpBody } from './wire.mjs';
import { laneCounts } from './task-procurement.mjs';
import { questionsOpen } from './clarifications.mjs';

/** Lifecycle order the home groups by (drafts first: they need the issuer). */
export const LIFECYCLE_ORDER = Object.freeze(['draft', 'published', 'closed', 'awarded', 'cancelled']);

/**
 * @param rows  RFP rows + `root_task_ids`, `covers` ([{task_id, name}]),
 *              `covered_task_count`, `lane_counts` ({status: n}),
 *              `open_question_count`, `awarded_org_id`, `awarded_name`,
 *              `my_proposal_id`, `my_proposal_status`
 * @param ctx   { viewerOrgId, now }
 * @returns     ProjectRfp[] newest first
 */
export function projectRfps(rows, { viewerOrgId, now = new Date() }) {
  return [...(rows ?? [])]
    .sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at) || String(b.id).localeCompare(String(a.id)))
    .map((row) => projectRfpBody(row, { viewerOrgId, now }));
}

export function projectRfpBody(row, { viewerOrgId, now = new Date() }) {
  const isIssuer = row.issuer_org_id === viewerOrgId;
  const base = {
    ...rfpBody(row),
    viewer_role: isIssuer ? 'issuer' : 'bidder',
    questions_open: questionsOpen(row, now),
    covers: (row.covers ?? []).map((c) => ({ task_id: c.task_id, name: c.name })),
    covered_task_count: Number(row.covered_task_count ?? 0),
  };
  if (isIssuer) {
    const { invited, submitted } = laneCounts(row.lane_counts);
    const awarded = row.status === 'awarded' && row.awarded_name;
    return {
      ...base,
      invited_count: invited,
      submitted_count: submitted,
      open_question_count: Number(row.open_question_count ?? 0),
      awarded_to: awarded ? { org_id: row.awarded_org_id ?? null, name: row.awarded_name } : null,
    };
  }
  return {
    ...base,
    my_proposal: row.my_proposal_id ? { id: row.my_proposal_id, status: row.my_proposal_status } : null,
  };
}

function timeOf(value) {
  const t = new Date(value ?? 0).getTime();
  return Number.isNaN(t) ? 0 : t;
}
