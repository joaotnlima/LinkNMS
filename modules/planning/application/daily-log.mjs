// The site's daily log (PRD-10 E-7..E-9; flow B13) — one function per
// operationId.
//
// OWNERSHIP: Planning & Execution (doc 02 #6). The daily log is the execution
// record of a site day against the plan: work done is reported against rows,
// issues and photos are tagged to rows and locations, and who may log work on
// a row is the same D-33 edit-scope rule reportProgress uses. All of that is
// planning's data and planning's rule. Collaboration owns conversation
// (threads, minutes) — a diary entry is not a discussion; Documents keeps the
// photo bytes (kind = photo) and planning binds a proven version through the
// documents query port, as deliverables do (PRD-05).
//
// Authorization (doc 16 conjunction: permission ∧ relationship ∧ staffing):
//   read   — project.participant
//   write  — org:progress:report ∧ project.participant; work entries also need
//            edit scope ∋ the task.
import { ProblemError } from '../../../platform/errors.mjs';
import { inEditScope } from '../domain/scope.mjs';
import { calendarWindow } from '../domain/site-calendar.mjs';
import {
  validateLogDate, validateEntries, sameEntry, entryBody, dayBody, daySummaries,
} from '../domain/daily-log.mjs';
import { requireParticipant, actorOf } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

function names(snapshot, locations) {
  return {
    orgs: snapshot.orgNames ?? new Map(),
    tasks: new Map([...snapshot.tasks.values()].map((t) => [t.id, t.name])),
    locations: locations ?? new Map(),
  };
}

async function readDay({ store, projectId, date, snapshot }) {
  const [rows, locations] = await Promise.all([
    store.listDailyLogDay(projectId, date),
    store.locationNames(projectId),
  ]);
  return dayBody({ projectId, date, rows, names: names(snapshot, locations) });
}

function requireDate(date) {
  const error = validateLogDate(date, today());
  if (error) throw new ProblemError('validation_failed', null, { errors: { date: error } });
}

/** operationId: listDailyLogs */
export async function listDailyLogs({ viewer, store, projectId, query }) {
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId });
  const window = calendarWindow(query, today(), { back: 30, ahead: 30 });
  if (window.errors) throw new ProblemError('validation_failed', null, { errors: window.errors });
  const rows = await store.listDailyLogWindow(projectId, window.from, window.to);
  return { status: 200, body: { items: daySummaries(rows), next_cursor: null } };
}

/** operationId: getDailyLog — a day with nothing yet is an empty day, not a 404. */
export async function getDailyLog({ viewer, store, projectId, date }) {
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId });
  requireDate(date);
  const snapshot = await store.loadPlan(projectId);
  return { status: 200, body: await readDay({ store, projectId, date, snapshot }) };
}

/** operationId: listTaskDailyLogEntries */
export async function listTaskDailyLogEntries({ viewer, store, taskId }) {
  if (!UUID.test(taskId ?? '')) throw new ProblemError('not_found');
  const task = await store.getTask(taskId);
  if (!task || task.deletedAt) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: task.projectId });
  const [rows, snapshot, locations] = await Promise.all([
    store.listTaskDailyLog(taskId),
    store.loadPlan(task.projectId),
    store.locationNames(task.projectId),
  ]);
  const n = names(snapshot, locations);
  return { status: 200, body: { items: rows.map((r) => entryBody(r, n)), next_cursor: null } };
}

/** The organisations of the build: owner, contract parties, plan assignees, participants. */
async function isBuildOrg({ store, projectId, snapshot, orgId }) {
  if (orgId === snapshot.ownerOrgId) return true;
  for (const c of snapshot.contracts.values()) if (c.supplierOrgId === orgId || c.clientOrgId === orgId) return true;
  for (const t of snapshot.tasks.values()) if (t.assigneeOrgId === orgId) return true;
  return store.isParticipant(projectId, orgId);
}

/** operationId: addDailyLogEntries */
export async function addDailyLogEntries({ viewer, store, documents, projectId, date, body }) {
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  const { actor } = await requireParticipant({ viewer, store, projectId });
  if (!viewer.has('org:progress:report')) throw new ProblemError('forbidden', null, { reason: 'role' });
  requireDate(date);
  const { errors, entries } = validateEntries(body);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const snapshot = await store.loadPlan(projectId);
  const locations = await store.locationNames(projectId);
  const world = { ownerOrgId: snapshot.ownerOrgId, contracts: snapshot.contracts };
  const refErrors = {};
  for (const [i, e] of entries.entries()) {
    const at = (field, msg) => { refErrors[`entries[${i}].${field}`] = msg; };
    if (e.taskId) {
      const task = snapshot.tasks.get(e.taskId);
      if (!task) at('task_id', 'a task of this plan');
      else if (e.kind === 'work' && !inEditScope(world, task, viewer.orgId)) {
        throw new ProblemError('out_of_scope', `work on “${task.name}” is reported by the organisations responsible for it (D-33)`);
      }
    }
    if (e.locationId && !locations.has(e.locationId)) at('location_id', 'a location of this build');
    if (e.kind === 'presence' && !(await isBuildOrg({ store, projectId, snapshot, orgId: e.orgId }))) {
      at('org_id', 'an organisation of this build');
    }
    if (e.kind === 'photo') {
      if (!documents) throw new ProblemError('internal', 'the documents port is not wired');
      const facts = await documents.versionFacts({ documentId: e.documentId, orgId: viewer.orgId });
      if (!facts || facts.project_id !== projectId || facts.kind !== 'photo') {
        at('document_id', 'a completed photo (kind photo) of this build you can read');
      } else {
        e.versionNo = facts.version_no;
      }
    }
  }
  if (Object.keys(refErrors).length) throw new ProblemError('validation_failed', null, { errors: refErrors });

  // Idempotent per entry id: an identical replay is absorbed, a different one is refused.
  const existing = new Map((await store.getDailyLogEntries(entries.map((e) => e.id))).map((r) => [r.id, r]));
  for (const e of entries) {
    const stored = existing.get(e.id);
    if (stored && (stored.project_id !== projectId || !sameEntry(stored, e, date))) {
      throw new ProblemError('idempotency_mismatch', `entry ${e.id} was already recorded with different content`);
    }
  }
  const fresh = entries.filter((e) => !existing.has(e.id));
  if (fresh.length) {
    await store.insertDailyLogEntries({ projectId, date, entries: fresh, actor: actorOf(actor, viewer) });
  }
  return { status: fresh.length ? 201 : 200, body: await readDay({ store, projectId, date, snapshot }) };
}
