// The shared project model (PRD-07, D-45) — one function per operationId:
//   getProjectModel, reserveProjectModelVersion, saveModelEdits,
//   restoreProjectModel, compareModelRecord, getTaskModel.
//
// Ownership: the model, its versions and its RECORD-SIDE data (element ↔ task
// links, issue pins) are Documents' (doc 02: "Files, versions, BIM"): a record
// edit IS a model version, so the links/pins and the version commit in one
// transaction with the ledger entry. Planning stays the one writer of rows and
// of the D-33 edit scope; it answers through its task port (`modelScopes`),
// never through its tables.
//
// Authorization (doc 04 + PRD-07 §4.2), enforced HERE, never in the UI:
//   READ   — every participant of the build (V1/V6, project scope). Bidders on
//            an RFP read only the view the RFP attaches (tendering's rule).
//   EDIT   — M-8: the model's author and the project owner, the whole model;
//            every other org, the elements linked to rows in its live D-33
//            scope (GC: its branch; an awarded company: its awarded rows),
//            closed when the contract ends (M-9, planning port).
//   UPLOAD — M-9: only the author (the org whose upload is v1). The first model
//            of a build may be put on the record by any participant; that org
//            becomes the author.
//   RESTORE — the whole-model editors (author, owner).
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { documentBody, storageKey, versionRef } from '../domain/model.mjs';
import { validateFile } from '../domain/model.mjs';
import {
  validateModelEdits, editScope, scopeRefusals, mergeDraft, changeCount, restorePlan, recordDiff,
  linksAt, elementLinkBody, pinBody, scopeBody, elementCounts,
} from '../domain/project-model.mjs';
import { validateDeclaredGlobalIds, uploadCheckBody } from '../domain/model-check.mjs';
import { requireActiveOrg, requireActor, actorOf } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SCOPES = Object.freeze({ owner_org_id: null, tasks: [], editors: [] });
const MODEL_MIME = 'application/x-step';

/** The project after the V1 read check; 404 otherwise (existence hiding). */
async function requireReadableProject({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  if (!(await store.resolveScope('project', projectId))) throw new ProblemError('not_found');
  if (!(await store.canReadScope({ scopeType: 'project', scopeId: projectId, orgId: viewer.orgId }))) {
    throw new ProblemError('not_found');
  }
}

async function requireModel(store, projectId) {
  const doc = await store.getProjectModel(projectId);
  if (!doc || doc.current_version < 1) throw new ProblemError('not_found', 'this build has no model yet');
  return doc;
}

/** Who the viewer is to the model: author / owner (whole) and its D-33 rows. */
function roleOf({ viewer, scopes, authorOrgId }) {
  const isOwner = Boolean(scopes.owner_org_id) && scopes.owner_org_id === viewer.orgId;
  const isAuthor = Boolean(authorOrgId) && authorOrgId === viewer.orgId;
  const taskIds = scopes.editors.find((e) => e.org_id === viewer.orgId)?.task_ids ?? [];
  return { isOwner, isAuthor, whole: isOwner || isAuthor, taskIds };
}

function isIfcName(name) {
  return typeof name === 'string' && /\.ifc$/i.test(name.trim());
}

/** M-6 access panel: who edits, on which scope, with element counts. */
function accessBody({ scopes, authorOrgId, links }) {
  const counts = elementCounts(links);
  const editors = [];
  if (authorOrgId) editors.push({ org_id: authorOrgId, role: 'author', task_ids: [], element_count: null });
  if (scopes.owner_org_id && scopes.owner_org_id !== authorOrgId) {
    editors.push({ org_id: scopes.owner_org_id, role: 'owner', task_ids: [], element_count: null });
  }
  for (const e of scopes.editors) {
    if (e.org_id === authorOrgId) continue;
    const gids = new Set(links.filter((l) => l.removed_in_version == null && e.task_ids.includes(l.task_id)).map((l) => l.global_id));
    editors.push({
      org_id: e.org_id, ...(e.org_name ? { org_name: e.org_name } : {}), role: 'branch',
      task_ids: e.task_ids, element_count: gids.size,
    });
  }
  // Rows nobody but the owner edits yet that already carry elements: they open
  // for whoever wins them (the RFP state is tendering's — the UI joins it).
  const scoped = new Set(scopes.editors.flatMap((e) => e.task_ids));
  const pending = [...counts.entries()]
    .filter(([taskId]) => !scoped.has(taskId))
    .map(([task_id, element_count]) => ({ task_id, element_count }));
  return { readers: 'participants', editors, unassigned_tasks: pending };
}

/** operationId: getProjectModel — the model, its record at a version, the viewer's scope. */
export async function getProjectModel({ viewer, store, planning = null, projectId, query = {} }) {
  await requireReadableProject({ viewer, store, projectId });
  const scopes = planning ? await planning.modelScopes(projectId) : NO_SCOPES;
  const doc = await store.getProjectModel(projectId);
  if (!doc || doc.current_version < 1) {
    return {
      status: 200,
      body: {
        project_id: projectId, document: null, links: [], pins: [], tasks: scopes.tasks,
        viewer: { scope: { kind: 'none', task_ids: [], element_count: 0 }, can_upload: true, can_restore: false },
        access: { readers: 'participants', editors: [], unassigned_tasks: [] },
      },
    };
  }
  let at = doc.current_version;
  if (query?.version !== undefined && query.version !== '') {
    const n = Number(query.version);
    if (!Number.isInteger(n) || n < 1 || n > doc.current_version) {
      throw new ProblemError('validation_failed', null, { errors: { version: `a version from 1 to ${doc.current_version}` } });
    }
    at = n;
  }
  const [versions, authorOrgId, record, check] = await Promise.all([
    store.listVersions(doc.id, doc.current_version),
    store.modelAuthorOrgId(doc.id),
    store.modelRecord(doc.id),
    typeof store.latestModelUploadCheck === 'function' ? store.latestModelUploadCheck(doc.id) : null,
  ]);
  const role = roleOf({ viewer, scopes, authorOrgId });
  const scope = editScope({ whole: role.whole, taskIds: role.taskIds, links: record.links });
  const live = linksAt(record.links, at);
  const counts = elementCounts(live);
  return {
    status: 200,
    body: {
      project_id: projectId,
      document: documentBody(doc, versions),
      author_org_id: authorOrgId,
      viewing_version: at,
      links: live.map(elementLinkBody),
      pins: record.pins.filter((p) => p.version_no <= at).map(pinBody),
      tasks: scopes.tasks.map((t) => ({ ...t, element_count: counts.get(t.id) ?? 0 })),
      viewer: {
        scope: scopeBody(scope, role),
        can_upload: role.isAuthor,
        can_restore: role.whole,
      },
      access: accessBody({ scopes, authorOrgId, links: record.links }),
      // M-18, computed when the latest .ifc completed (null without declared GlobalIds).
      upload_check: check ? uploadCheckBody(check) : null,
    },
  };
}

/**
 * operationId: reserveProjectModelVersion — reserve the next .ifc of the build's
 * model (or its first) and answer an upload ticket; `completeUpload` proves it.
 * Links and issues carry over by GlobalId with nothing to do here (M-18).
 */
export async function reserveProjectModelVersion({ viewer, store, storage, projectId, body, idempotencyKey = null }) {
  await requireReadableProject({ viewer, store, projectId });
  // A replay answers the same reservation (and ticket) instead of a second version.
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'reserveProjectModelVersion', body: { project_id: projectId, ...body } },
    () => reserveVersion({ viewer, store, storage, projectId, body }),
  );
}

async function reserveVersion({ viewer, store, storage, projectId, body }) {
  const errors = validateFile(body?.file);
  if (!errors['file.name'] && !isIfcName(body?.file?.name)) errors['file.name'] = 'an IFC file (.ifc) — the only model format';
  if (body?.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.trim().length > 2000)) {
    errors.note = 'text up to 2000 characters';
  }
  // M-18: the new file's element GlobalIds, extracted by the client — the
  // server compares them with the record when the upload completes.
  const declared = validateDeclaredGlobalIds(body?.global_ids);
  if (declared.error) errors.global_ids = declared.error;
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null;
  const file = { ...body.file, mime: MODEL_MIME };
  const actor = actorOf(await requireActor(store, viewer), viewer);

  const doc = await store.getProjectModel(projectId);
  let version;
  if (doc) {
    const authorOrgId = await store.modelAuthorOrgId(doc.id);
    if (doc.current_version >= 1 && authorOrgId !== viewer.orgId) {
      throw new ProblemError('forbidden', 'only the model\'s author uploads a new .ifc', { reason: 'relationship' });
    }
    version = await store.addVersion({
      documentId: doc.id,
      file,
      meta: { note, baseVersionNo: doc.current_version || null, changeKind: 'upload' },
      storageKeyOf: (n) => storageKey({ documentId: doc.id, versionNo: n, fileName: file.name, random: randomUUID() }),
      actor,
    });
  } else {
    const id = randomUUID();
    try {
      version = await store.createDocument({
        id, projectId, scopeType: 'project', scopeId: projectId, kind: 'bim', title: file.name.trim(),
        shareWithAncestors: false, file, note, isProjectModel: true,
        storageKey: storageKey({ documentId: id, versionNo: 1, fileName: file.name, random: randomUUID() }),
        actor,
      });
    } catch (err) {
      if (err?.code === '23505') throw new ProblemError('version_conflict', 'another model was just put on this build — reload');
      throw err;
    }
  }
  if (declared.globalIds && typeof store.saveModelElements === 'function') {
    await store.saveModelElements({ documentId: version.document_id, versionNo: version.version_no, globalIds: declared.globalIds });
  }
  const { url, expiresAt } = await storage.signUpload({ key: version.storage_key, mime: version.mime, sha256Hex: version.sha256 });
  return {
    status: 201,
    body: { document_version_id: versionRef(version.document_id, version.version_no), upload_url: url, expires_at: expiresAt },
  };
}

/** operationId: saveModelEdits — a record-side draft becomes version n+1 (M-11..M-14). */
export async function saveModelEdits({ viewer, store, planning = null, projectId, body, idempotencyKey = null }) {
  await requireReadableProject({ viewer, store, projectId });
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'saveModelEdits', body: { project_id: projectId, ...body } },
    () => saveEdits({ viewer, store, planning, projectId, body }),
  );
}

async function saveEdits({ viewer, store, planning, projectId, body }) {
  const doc = await requireModel(store, projectId);
  const { errors, edit } = validateModelEdits(body);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const scopes = planning ? await planning.modelScopes(projectId) : NO_SCOPES;
  const authorOrgId = await store.modelAuthorOrgId(doc.id);
  const role = roleOf({ viewer, scopes, authorOrgId });
  if (!role.whole && !role.taskIds.length) {
    throw new ProblemError('forbidden', 'you have no edit scope on this model — it opens on award', { reason: 'relationship' });
  }
  const projectTaskIds = new Set(scopes.tasks.map((t) => t.id));
  const actor = actorOf(await requireActor(store, viewer), viewer);
  const result = await store.saveModelEdit({
    documentId: doc.id,
    baseVersionNo: edit.baseVersionNo,
    note: edit.note,
    authorOrgId,
    actor,
    decide: (state) => {
      const scope = editScope({ whole: role.whole, taskIds: role.taskIds, links: state.links });
      const pinsById = new Map(state.pins.map((p) => [p.id, p]));
      const refused = scopeRefusals(edit.changes, scope, { pinsById, orgId: viewer.orgId, projectTaskIds });
      if (refused.length) return { refused };
      const merged = mergeDraft({
        changes: edit.changes, base: edit.baseVersionNo, rows: state.links, pins: state.pins, resolutions: edit.resolutions,
      });
      if (merged.conflicts.length) return merged;
      if (!changeCount(merged.apply)) return { refused: [{ index: -1, reason: 'nothing to save — every change is already on the record' }], empty: true };
      return merged;
    },
  });
  if (!result) throw new ProblemError('not_found');
  if (result.stale !== undefined) {
    throw new ProblemError('validation_failed', null, { errors: { base_version_no: `a version from 1 to ${result.stale}` } });
  }
  if (result.refused) {
    if (result.refused[0]?.index === -1) throw new ProblemError('validation_failed', result.refused[0].reason, { errors: { changes: result.refused[0].reason } });
    throw new ProblemError('out_of_scope', 'some changes touch elements or rows outside your edit scope', {
      refused: result.refused.map((r) => ({ change_index: r.index, reason: r.reason })),
    });
  }
  if (result.conflicts) {
    throw new ProblemError('version_conflict',
      'elements in your draft were changed after the version you started from — choose, element by element, whose change stays',
      { conflicts: result.conflicts, current_version: doc.current_version });
  }
  const versions = await store.listVersions(doc.id, result.doc.current_version);
  return {
    status: 201,
    body: {
      document: documentBody(result.doc, versions),
      version_no: result.versionNo,
      change_count: result.changes,
      dropped: result.dropped,
      edited_by_author: authorOrgId === viewer.orgId,
    },
  };
}

/** operationId: restoreProjectModel — Restore vN creates v(n+1) as its copy (M-17). */
export async function restoreProjectModel({ viewer, store, planning = null, projectId, body, idempotencyKey = null }) {
  await requireReadableProject({ viewer, store, projectId });
  // Inside the reservation: a replay must not trip "already the current version".
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'restoreProjectModel', body: { project_id: projectId, ...body } },
    () => restore({ viewer, store, planning, projectId, body }),
  );
}

async function restore({ viewer, store, planning, projectId, body }) {
  const doc = await requireModel(store, projectId);
  const n = body?.version_no;
  const errors = {};
  if (!Number.isInteger(n) || n < 1 || n > doc.current_version) errors.version_no = `a version from 1 to ${doc.current_version}`;
  else if (n === doc.current_version) errors.version_no = 'that is already the current version';
  if (body?.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.trim().length > 2000)) errors.note = 'text up to 2000 characters';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const scopes = planning ? await planning.modelScopes(projectId) : NO_SCOPES;
  const authorOrgId = await store.modelAuthorOrgId(doc.id);
  if (!roleOf({ viewer, scopes, authorOrgId }).whole) {
    throw new ProblemError('forbidden', 'restoring a version is for the model\'s author and the owner', { reason: 'relationship' });
  }
  const actor = actorOf(await requireActor(store, viewer), viewer);
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : `Restored v${n}`;
  const result = await store.restoreModel({
    documentId: doc.id, versionNo: n, note, authorOrgId, actor, plan: (state) => restorePlan(state.links, n),
  });
  if (!result) throw new ProblemError('not_found');
  if (result.stale !== undefined) throw new ProblemError('validation_failed', null, { errors: { version_no: `a version from 1 to ${result.stale}` } });
  const versions = await store.listVersions(doc.id, result.doc.current_version);
  return { status: 201, body: { document: documentBody(result.doc, versions), version_no: result.versionNo, change_count: result.changes } };
}

/** operationId: compareModelRecord — record changes between two versions (M-16). */
export async function compareModelRecord({ viewer, store, projectId, query = {} }) {
  await requireReadableProject({ viewer, store, projectId });
  const doc = await requireModel(store, projectId);
  const from = Number(query.from);
  const to = Number(query.to);
  const errors = {};
  if (!Number.isInteger(from) || from < 1 || from > doc.current_version) errors.from = `a version from 1 to ${doc.current_version}`;
  if (!Number.isInteger(to) || to < 1 || to > doc.current_version) errors.to = `a version from 1 to ${doc.current_version}`;
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const record = await store.modelRecord(doc.id);
  return { status: 200, body: recordDiff(record.links, record.pins, from, to) };
}

/** operationId: getTaskModel — the Files tab model card of a task (PRD-05 F-4). */
export async function getTaskModel({ viewer, store, planning = null, taskId }) {
  requireActiveOrg(viewer);
  if (!UUID.test(taskId ?? '')) throw new ProblemError('not_found');
  const task = await store.resolveScope('task', taskId);
  if (!task) throw new ProblemError('not_found');
  if (!(await store.canReadScope({ scopeType: 'task', scopeId: taskId, orgId: viewer.orgId }))) throw new ProblemError('not_found');
  const doc = await store.getProjectModel(task.projectId);
  if (!doc || doc.current_version < 1) return { status: 200, body: { model: null } };
  const scopes = planning ? await planning.modelScopes(task.projectId) : NO_SCOPES;
  const [authorOrgId, count] = await Promise.all([store.modelAuthorOrgId(doc.id), store.taskElementCount(doc.id, taskId)]);
  const role = roleOf({ viewer, scopes, authorOrgId });
  return {
    status: 200,
    body: {
      model: {
        document_id: doc.id,
        title: doc.title,
        current_version: doc.current_version,
        element_count: count,
        can_edit: role.whole || role.taskIds.includes(taskId),
        edit_reason: role.isAuthor ? 'author' : role.isOwner ? 'owner' : role.taskIds.includes(taskId) ? 'scope' : 'none',
      },
    },
  };
}
