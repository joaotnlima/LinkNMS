// Tendering query: "Ask for a proposal" from a company profile (operationId
// listAskCandidates, PRD-04 X-6, X-7). ONE server read replaces the app's join
// of /schedule with /task-procurement and its client-side specialty ranking.
//
// Ports (injected at the composition root; tendering reads none of their
// tables): planning.tasksOf — the build's rows in outline order;
// directory.biddingProfileOf — the company's specialty family. The governing
// RFP of each row is tendering's own projection (the issuer's tenders).
//
// Authorization (doc 16 conjunction): org:tendering:issue ∧ project.participant
// ∧ staffing (404 for a non-party — existence hiding).
import { ProblemError } from '../../../platform/errors.mjs';
import { askCandidates } from '../domain/ask-candidates.mjs';
import { taskProcurement } from '../domain/task-procurement.mjs';
import { requireParticipant } from './use-cases.mjs';
import { UUID } from './paging.mjs';

const ALL_TASKS = 10000;

/** operationId: listAskCandidates — GET /projects/{projectId}/ask-candidates?company_id= */
export async function listAskCandidates({ viewer, store, planning, directory, projectId, query = {} }) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const companyId = query?.company_id;
  if (!UUID.test(companyId ?? '')) {
    throw new ProblemError('validation_failed', null, { errors: { company_id: 'the company (organisation) id' } });
  }
  await requireParticipant({ viewer, store, projectId });
  const [tasks, profile, { items: rows }] = await Promise.all([
    planning ? planning.tasksOf(projectId) : [],
    directory ? directory.biddingProfileOf(companyId) : null,
    store.taskProcurementOfProject(projectId, viewer.orgId, { limit: ALL_TASKS }),
  ]);
  const items = askCandidates({ tasks, family: profile?.specialty_family ?? [], procurement: taskProcurement(rows) });
  // A build's plan is one page: the dialog needs every row to rank them.
  return { status: 200, body: { items, next_cursor: null } };
}
