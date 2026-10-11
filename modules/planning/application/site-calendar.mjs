// operationId: getSiteCalendar (PRD-10 E-10, E-11). Planning owns it: who is
// on site when is a projection of the plan's rows — their dates, their
// effective assignee (D-33) and their location — on the project's working
// calendar, all of which planning already holds in its snapshot. Location
// names come through the store's read of project.location (read port).
//
// E-12 (the disruptive-work notice of flow E23) is not emitted from here: the
// calendar is computed on read, and a read never publishes. The notice belongs
// to the neighbour log, out of scope for PRD-10.
import { ProblemError } from '../../../platform/errors.mjs';
import { makeCalendar } from '../domain/calendar.mjs';
import { effectiveSpans } from '../domain/propagation.mjs';
import { siteCalendar, calendarWindow } from '../domain/site-calendar.mjs';
import { childCounts } from './projection.mjs';
import { requireParticipant } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

/** operationId: getSiteCalendar */
export async function getSiteCalendar({ viewer, store, projectId, query }) {
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId });
  const window = calendarWindow(query, today());
  if (window.errors) throw new ProblemError('validation_failed', null, { errors: window.errors });
  const snapshot = await store.loadPlan(projectId);
  const locationNames = store.locationNames ? await store.locationNames(projectId) : new Map();
  const result = siteCalendar({
    tasks: snapshot.tasks,
    counts: childCounts(snapshot.tasks),
    spans: effectiveSpans(snapshot.tasks),
    calendar: makeCalendar(snapshot.calendarRaw ?? {}),
    from: window.from,
    to: window.to,
    orgNames: snapshot.orgNames,
    locationNames,
  });
  return { status: 200, body: { project_id: projectId, from: window.from, to: window.to, ...result } };
}
