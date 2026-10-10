// Planning queries/commands behind a tender (PRD-02 T-3/T-4/T-5/T-13, §5):
//   getTenderWindow       — the plan side of tendering some rows;
//   getPlanningSettings   — the project's mobilisation lead (award-by);
//   putPlanningSettings   — edit it (same gate as the project calendar).
//
// Authorization (doc 16 conjunction):
//   reads  — session ∧ project.participant (∧ staffing): time is visible to
//            every participant (doc 04 V1); no money is read or returned.
//   write  — org:plan:edit ∧ (project owner | live prime supplier), as
//            putCalendar: the settings work on that calendar.
import { ProblemError } from '../../../platform/errors.mjs';
import { makeCalendar } from '../domain/calendar.mjs';
import { tenderWindow, DEFAULT_MOBILISATION_LEAD_WD } from '../domain/tender-window.mjs';
import { requireParticipant, requireActiveOrg, actorOf } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROOTS = 200;

function idList(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

/** #/components/schemas/PlanningSettings for a stored row (or the defaults). */
function settingsBody(row) {
  return { mobilisation_lead_wd: row?.mobilisation_lead_wd ?? DEFAULT_MOBILISATION_LEAD_WD };
}

/** operationId: getTenderWindow */
export async function getTenderWindow({ viewer, store, projectId, query }) {
  await requireParticipant({ viewer, store, projectId });
  const roots = idList(query?.task_ids);
  const include = idList(query?.include);
  const errors = {};
  if (roots.length === 0 || roots.length > MAX_ROOTS || roots.some((t) => !UUID.test(t))) {
    errors.task_ids = `1–${MAX_ROOTS} comma-separated task ids`;
  }
  if (include.some((t) => !UUID.test(t))) errors.include = 'comma-separated task ids';
  const bidsDue = query?.bids_due ?? null;
  if (bidsDue !== null && !ISO_DATE.test(bidsDue)) errors.bids_due = 'YYYY-MM-DD';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const [snapshot, settings] = await Promise.all([
    store.loadPlan(projectId),
    store.getPlanningSettings(projectId),
  ]);
  const missing = roots.filter((t) => !snapshot.tasks.has(t));
  if (missing.length) {
    throw new ProblemError('validation_failed', null, { errors: { task_ids: `not rows of this plan: ${missing.join(', ')}` } });
  }
  const window = tenderWindow({
    tasks: snapshot.tasks,
    links: snapshot.links,
    calendar: makeCalendar(snapshot.calendarRaw),
    rootIds: roots,
    includeIds: include,
    bidsDue,
    leadWd: settingsBody(settings).mobilisation_lead_wd,
    orgNames: snapshot.orgNames,
  });
  return { status: 200, body: { project_id: projectId, ...window } };
}

/** operationId: getPlanningSettings */
export async function getPlanningSettings({ viewer, store, projectId }) {
  await requireParticipant({ viewer, store, projectId });
  return { status: 200, body: settingsBody(await store.getPlanningSettings(projectId)) };
}

/** operationId: putPlanningSettings */
export async function putPlanningSettings({ viewer, store, projectId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:plan:edit')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { project, actor } = await requireParticipant({ viewer, store, projectId });
  const isOwner = project.owner_org_id === viewer.orgId;
  if (!isOwner && !(await store.isPrimeSupplier(projectId, viewer.orgId))) {
    throw new ProblemError('forbidden', 'only the owner or the prime contractor edits the planning settings', { reason: 'relationship' });
  }
  const lead = body?.mobilisation_lead_wd;
  if (!Number.isInteger(lead) || lead < 0 || lead > 60) {
    throw new ProblemError('validation_failed', null, { errors: { mobilisation_lead_wd: 'whole working days, 0–60' } });
  }
  const saved = await store.putPlanningSettings({
    projectId, mobilisationLeadWd: lead, actor: actorOf(actor, viewer),
  });
  return { status: 200, body: settingsBody(saved) };
}
