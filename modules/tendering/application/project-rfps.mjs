// Tendering query: the tendering home of a project (operationId
// listProjectRfps, PRD-08 H-1).
//
// `/projects/{id}/tendering` reads this ONE projection — every RFP the viewer
// can see on the project with its covered tasks, bids due, `n/m in` and open
// questions — instead of composing it from /me/rfps plus a recipients and a
// lanes read per RFP.
//
// Authorization (doc 16 conjunction): no Clerk permission beyond a session ∧
// relationship — a project participant (staffed), OR an org that was sent /
// bids on an RFP of this project (a bidder is not a participant until it is
// awarded). A stranger gets 404 (existence hiding). WHICH RFPs is SQL (issuer:
// all of its own incl. drafts; bidder: the non-draft ones it is on); WHAT each
// viewer reads of them is the domain (V8: a bidder never sees the counts).
import { ProblemError } from '../../../platform/errors.mjs';
import { projectRfps } from '../domain/project-rfps.mjs';
import { requireParticipant } from './use-cases.mjs';

/** operationId: listProjectRfps — GET /projects/{projectId}/rfps. */
export async function listProjectRfps({ viewer, store, orgs = null, projectId, now = new Date() }) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
  let participant = true;
  try {
    await requireParticipant({ viewer, store, projectId });
  } catch (err) {
    // Only "not related" falls through to the bidder path; staffing and
    // identity refusals stand.
    if (!(err instanceof ProblemError) || err.problem.code !== 'not_found') throw err;
    participant = false;
  }
  const rows = await withAwardedNames(orgs, await store.projectRfps(projectId, viewer.orgId));
  if (!participant && rows.length === 0) throw new ProblemError('not_found');
  return { status: 200, body: { items: projectRfps(rows, { viewerOrgId: viewer.orgId, now }) } };
}

/**
 * `awarded_name` for each row: the winning organisation's name through
 * identity's organisation port (tendering never reads identity.*), else the
 * name the invite carried, else its e-mail.
 */
export async function withAwardedNames(orgs, rows) {
  const ids = rows.map((r) => r.awarded_org_id).filter(Boolean);
  const names = orgs && ids.length ? await orgs.namesOf(ids) : new Map();
  return rows.map((r) => ({ ...r, awarded_name: names.get(r.awarded_org_id) ?? r.awarded_recipient_name ?? null }));
}
