// Task files and project files (PRD-05) — one function per operationId:
//   listTaskDocuments, linkTaskDocuments, unlinkTaskDocument,
//   listProjectDocuments.
//
// A file lives ONCE in the project; tasks link to it (documents.document_link,
// role reference | deliverable). Authorization is V6 + D-33 (doc 04):
//   READ  — readers of the task / project: every participant (V1);
//   LINK  — edit scope of the task (the same rule as attaching a task file),
//           and only files the viewer reads, of the same build, scoped to the
//           project, a location or a task (contract / RFP / proposal files
//           keep their narrower audiences, V2/V8).
// Existence hiding as elsewhere: a task the viewer cannot read answers 404.
//
// `planning` is the planning task port (descendantIds) injected at the
// composition root — documents never reads planning.* to find sub-tasks.
import { ProblemError } from '../../../platform/errors.mjs';
import { documentBody } from '../domain/model.mjs';
import { FILE_TYPES, LINK_ROLES, linkRows, usesBody } from '../domain/files.mjs';
import { requireActiveOrg, requireActor, actorOf, clampLimit } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINKS = 50;

/** The task (project id) after the V6 read check; 404 otherwise. */
async function requireReadableTask({ viewer, store, taskId }) {
  requireActiveOrg(viewer);
  if (!UUID.test(taskId ?? '')) throw new ProblemError('not_found');
  const task = await store.resolveScope('task', taskId);
  if (!task) throw new ProblemError('not_found');
  if (!(await store.canReadScope({ scopeType: 'task', scopeId: taskId, orgId: viewer.orgId }))) {
    throw new ProblemError('not_found');
  }
  return task;
}

async function requireTaskEditor({ viewer, store, taskId }) {
  const task = await requireReadableTask({ viewer, store, taskId });
  if (!(await store.canEditScope({ scopeType: 'task', scopeId: taskId, orgId: viewer.orgId }))) {
    throw new ProblemError('forbidden', 'linking files to this task needs its edit scope', { reason: 'relationship' });
  }
  return task;
}

/** Document bodies for rows, versions and links read in two queries (no N+1). */
async function bodiesOf(store, docs) {
  const ids = docs.map((d) => d.id);
  const [versions, links] = await Promise.all([store.versionsOfDocuments(ids), store.linksOfDocuments(ids)]);
  const versionsBy = groupBy(versions, 'document_id');
  const linksBy = groupBy(links, 'document_id');
  return docs.map((d) => ({
    ...documentBody(d, versionsBy.get(d.id) ?? []),
    used_on: usesBody(linksBy.get(d.id) ?? []),
  }));
}

function taskDocumentBody(row, base) {
  return {
    ...base,
    role: row.linked ? row.link_role : 'reference',
    inherited: Boolean(row.linked && row.link_inherited),
    ...(row.link_inherited_from ? { inherited_from_task_id: row.link_inherited_from } : {}),
    attached: !row.linked,
  };
}

/** operationId: listTaskDocuments */
export async function listTaskDocuments({ viewer, store, taskId }) {
  await requireReadableTask({ viewer, store, taskId });
  const rows = await store.listTaskFiles({ taskId, orgId: viewer.orgId });
  const bodies = await bodiesOf(store, rows);
  return {
    status: 200,
    body: { items: rows.map((r, i) => taskDocumentBody(r, bodies[i])), next_cursor: null },
  };
}

/** operationId: linkTaskDocuments */
export async function linkTaskDocuments({ viewer, store, planning = null, taskId, body }) {
  const task = await requireTaskEditor({ viewer, store, taskId });
  const errors = {};
  const ids = Array.isArray(body?.document_ids) ? [...new Set(body.document_ids)] : null;
  if (!ids || ids.length < 1 || ids.length > MAX_LINKS || ids.some((id) => !UUID.test(id ?? ''))) {
    errors.document_ids = `1–${MAX_LINKS} document ids`;
  }
  const role = body?.role ?? 'reference';
  if (!LINK_ROLES.includes(role)) errors.role = `one of ${LINK_ROLES.join(', ')}`;
  if (body?.include_subtasks !== undefined && typeof body.include_subtasks !== 'boolean') {
    errors.include_subtasks = 'true or false';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const linkable = await store.linkableDocuments(ids, task.projectId);
  const found = new Set(linkable.map((d) => d.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    // Unknown, unreadable, another build's or a restricted-scope file — one answer.
    throw new ProblemError('validation_failed', null, {
      errors: { document_ids: `not files of this project you can link: ${missing.join(', ')}` },
    });
  }
  const descendants = body.include_subtasks === true && planning ? await planning.descendantIds(taskId) : [];
  const actor = await requireActor(store, viewer);
  await store.addLinks({
    documentIds: ids,
    projectId: task.projectId,
    links: linkRows({ taskId, role, includeSubtasks: body.include_subtasks === true, descendantIds: descendants }),
    actor: actorOf(actor, viewer),
  });
  // Answer the task's view of what was asked for (existing links unchanged).
  const rows = (await store.listTaskFiles({ taskId, orgId: viewer.orgId })).filter((r) => found.has(r.id));
  const bodies = await bodiesOf(store, rows);
  return { status: 200, body: { items: rows.map((r, i) => taskDocumentBody(r, bodies[i])) } };
}

/** operationId: unlinkTaskDocument */
export async function unlinkTaskDocument({ viewer, store, taskId, documentId }) {
  const task = await requireTaskEditor({ viewer, store, taskId });
  if (!UUID.test(documentId ?? '')) throw new ProblemError('not_found');
  const actor = await requireActor(store, viewer);
  const removed = await store.removeLink({
    documentId, taskId, projectId: task.projectId, actor: actorOf(actor, viewer),
  });
  if (!removed) throw new ProblemError('not_found');
  return { status: 204, body: null };
}

/** operationId: listProjectDocuments */
export async function listProjectDocuments({ viewer, store, projectId, query }) {
  requireActiveOrg(viewer);
  const errors = {};
  const q = typeof query?.q === 'string' ? query.q.trim() : '';
  if (q.length > 200) errors.q = 'up to 200 characters';
  if (query?.type !== undefined && query.type !== '' && !FILE_TYPES.includes(query.type)) {
    errors.type = `one of ${FILE_TYPES.join(', ')}`;
  }
  if (query?.cursor !== undefined && !UUID.test(query.cursor)) errors.cursor = 'an opaque cursor from next_cursor';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  const project = await store.resolveScope('project', projectId);
  if (!project) throw new ProblemError('not_found');
  if (!(await store.canReadScope({ scopeType: 'project', scopeId: projectId, orgId: viewer.orgId }))) {
    throw new ProblemError('not_found');
  }
  const { items, nextCursor } = await store.listProjectFiles({
    projectId,
    orgId: viewer.orgId,
    q: q ? q.replace(/[\\%_]/g, (c) => `\\${c}`) : null,
    fileType: query?.type || null,
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: await bodiesOf(store, items), next_cursor: nextCursor } };
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const list = out.get(r[key]);
    if (list) list.push(r);
    else out.set(r[key], [r]);
  }
  return out;
}
