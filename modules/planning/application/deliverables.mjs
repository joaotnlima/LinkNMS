// Deliverables of a task (PRD-05 F-2, F-12..F-16, D-48) — one function per
// operationId, plus the two consumers and the done gate reportProgress asks.
//
// Planning owns them: a deliverable is the task's acceptance artefact and
// D-48 ("done only when every required deliverable is approved") is a rule on
// the task's status. The file is a Documents document; planning binds a
// submission to a proven version through the documents query port
// (versionFacts) and snapshots its sha256 — it never reads documents.*.
//
// Authorization (doc 16 conjunction: permission ∧ relationship ∧ staffing):
//   read    — project.participant (V1)
//   edit    — org:plan:edit ∧ client side of the task (domain/deliverables)
//   submit  — org:progress:report ∧ the task's assignee org
//   decide  — org:quality:verify ∧ client side ∧ ≠ the submitting org
import { ProblemError } from '../../../platform/errors.mjs';
import {
  sideOf, canDecide, currentSubmission, pendingRequired, validateDeliverableFields, validateText,
  deliverableBody, taskDeliverablesBody,
} from '../domain/deliverables.mjs';
import { requireParticipant, actorOf } from './use-cases.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadTask({ viewer, store, taskId }) {
  if (!UUID.test(taskId ?? '')) throw new ProblemError('not_found');
  const task = await store.getTask(taskId);
  if (!task || task.deletedAt) throw new ProblemError('not_found');
  const { actor } = await requireParticipant({ viewer, store, projectId: task.projectId });
  const plan = await store.loadPlan(task.projectId);
  const row = plan.tasks.get(taskId) ?? task;
  const side = sideOf({ world: { ownerOrgId: plan.ownerOrgId, contracts: plan.contracts }, tasks: plan.tasks, task: row, orgId: viewer.orgId });
  return { task: row, actor, side };
}

async function loadDeliverable({ viewer, store, deliverableId }) {
  if (!UUID.test(deliverableId ?? '')) throw new ProblemError('not_found');
  const deliverable = await store.getDeliverable(deliverableId);
  if (!deliverable) throw new ProblemError('not_found');
  const ctx = await loadTask({ viewer, store, taskId: deliverable.task_id });
  return { deliverable, ...ctx };
}

function requirePermission(viewer, permission) {
  if (!viewer.has(permission)) throw new ProblemError('forbidden', null, { reason: 'role' });
}

function requireClientSide(side) {
  if (!side.clientSide) {
    throw new ProblemError('forbidden', 'deliverables are set and reviewed by the client side of the task', { reason: 'relationship' });
  }
}

// ── reads ──────────────────────────────────────────────────────────────────

/** operationId: listTaskDeliverables */
export async function listTaskDeliverables({ viewer, store, taskId }) {
  const { task, side } = await loadTask({ viewer, store, taskId });
  const deliverables = await store.listDeliverables({ taskId: task.id });
  return { status: 200, body: taskDeliverablesBody({ taskId: task.id, deliverables, side, orgId: viewer.orgId }) };
}

/** operationId: listProjectDeliverables */
export async function listProjectDeliverables({ viewer, store, projectId }) {
  if (!UUID.test(projectId ?? '')) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId });
  const deliverables = await store.listDeliverables({ projectId });
  return { status: 200, body: { items: deliverables.map(deliverableBody), next_cursor: null } };
}

// ── client side: the required list (F-12) ───────────────────────────────────

/** operationId: createDeliverable — idempotent on the client id. */
export async function createDeliverable(args) {
  const { viewer, store, taskId, body, idempotencyKey = null } = args;
  requirePermission(viewer, 'org:plan:edit');
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'createDeliverable', body: { task_id: taskId, ...body } },
    () => runCreateDeliverable(args),
  );
}

async function runCreateDeliverable({ viewer, store, taskId, body }) {
  const { task, actor, side } = await loadTask({ viewer, store, taskId });
  requireClientSide(side);
  const { errors, value } = validateDeliverableFields(body);
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const { deliverable, created } = await store.insertDeliverable({
    id: body.id, projectId: task.projectId, taskId: task.id, ...value, actor: actorOf(actor, viewer),
  });
  if (!created) {
    const same = deliverable && deliverable.task_id === task.id && deliverable.title === value.title
      && deliverable.required === value.required;
    if (!same) throw new ProblemError('idempotency_mismatch', 'this id was already used by a different request');
    return { status: 200, body: deliverableBody(deliverable) };
  }
  return { status: 201, body: deliverableBody(deliverable) };
}

/** operationId: updateDeliverable */
export async function updateDeliverable({ viewer, store, deliverableId, body }) {
  requirePermission(viewer, 'org:plan:edit');
  const { side, actor } = await loadDeliverable({ viewer, store, deliverableId });
  requireClientSide(side);
  const { errors, value } = validateDeliverableFields(body, { partial: true });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const updated = await store.patchDeliverable({ id: deliverableId, patch: value, actor: actorOf(actor, viewer) });
  if (!updated) throw new ProblemError('not_found');
  return { status: 200, body: deliverableBody(updated) };
}

/** operationId: deleteDeliverable — soft; submissions stay on the record. */
export async function deleteDeliverable({ viewer, store, deliverableId }) {
  requirePermission(viewer, 'org:plan:edit');
  const { side, actor } = await loadDeliverable({ viewer, store, deliverableId });
  requireClientSide(side);
  const removed = await store.removeDeliverable({ id: deliverableId, actor: actorOf(actor, viewer) });
  if (!removed) throw new ProblemError('not_found');
  return { status: 204, body: null };
}

// ── submit and review (F-13..F-15) ──────────────────────────────────────────

/** operationId: submitDeliverable — the assignee hands over a proven version. */
export async function submitDeliverable(args) {
  const { viewer, store, deliverableId, body, idempotencyKey = null } = args;
  requirePermission(viewer, 'org:progress:report');
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'submitDeliverable', body: { deliverable_id: deliverableId, ...body } },
    () => runSubmitDeliverable(args),
  );
}

async function runSubmitDeliverable({ viewer, store, documents, deliverableId, body }) {
  const { deliverable, task, side, actor } = await loadDeliverable({ viewer, store, deliverableId });
  if (!side.canSubmit) {
    throw new ProblemError('forbidden', 'the organisation responsible for the task submits its deliverables', { reason: 'relationship' });
  }
  const errors = {};
  if (!UUID.test(body?.document_id ?? '')) errors.document_id = 'the document id';
  if (body?.version_no !== undefined && (!Number.isInteger(body.version_no) || body.version_no < 1)) errors.version_no = 'a version number ≥ 1';
  const note = validateText(body?.note, 'note');
  if (note.error) Object.assign(errors, note.error);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  if (!documents) throw new ProblemError('internal', 'the documents port is not wired');

  const facts = await documents.versionFacts({ documentId: body.document_id, versionNo: body.version_no ?? null, orgId: viewer.orgId });
  if (!facts || facts.project_id !== task.projectId) {
    throw new ProblemError('validation_failed', null, {
      errors: { document_id: 'a completed version of a file of this project you can read' },
    });
  }
  const current = currentSubmission(deliverable.submissions);
  if (current && current.document_id === facts.document_id && current.version_no === facts.version_no) {
    // Idempotent: the same version already waits for review (e.g. the new-version
    // consumer re-submitted it first) — answer it unchanged.
    if (current.status === 'submitted') return { status: 200, body: deliverableBody(deliverable) };
    if (current.status === 'approved') {
      throw new ProblemError('invalid_transition', `version ${facts.version_no} is already approved`);
    }
  }
  const updated = await store.submitDeliverable({ id: deliverableId, facts, note: note.value, actor: actorOf(actor, viewer) });
  if (!updated) throw new ProblemError('not_found');
  return { status: 200, body: deliverableBody(updated) };
}

async function decide(args) {
  const { viewer, store, deliverableId, body, status, idempotencyKey = null } = args;
  requirePermission(viewer, 'org:quality:verify');
  const operationId = status === 'approved' ? 'approveDeliverable' : 'requestDeliverableChanges';
  return store.idempotent(
    { key: idempotencyKey, caller: viewer.clerkUserId, operationId, body: { deliverable_id: deliverableId, ...body } },
    () => decideNow(args),
  );
}

async function decideNow({ viewer, store, deliverableId, body, status }) {
  const { deliverable, side, actor } = await loadDeliverable({ viewer, store, deliverableId });
  requireClientSide(side);
  const comment = validateText(body?.comment, 'comment', { required: status === 'changes_requested' });
  if (comment.error) throw new ProblemError('validation_failed', null, { errors: comment.error });
  const current = currentSubmission(deliverable.submissions);
  if (!current || current.status !== 'submitted') {
    throw new ProblemError('invalid_transition', 'nothing is waiting for review on this deliverable');
  }
  if (!canDecide(side, current, viewer.orgId)) {
    throw new ProblemError('two_sided_rule', 'your organisation submitted this version — another party reviews it');
  }
  const result = await store.decideDeliverable({
    id: deliverableId, submissionId: current.id, status, comment: comment.value, actor: actorOf(actor, viewer),
  });
  if (!result) throw new ProblemError('not_found');
  if (result.conflict) throw new ProblemError('invalid_transition', 'someone decided or re-submitted this first');
  return { status: 200, body: deliverableBody(result.deliverable) };
}

/** operationId: approveDeliverable — person, org, time, sha256 on the record. */
export function approveDeliverable(args) {
  return decide({ ...args, status: 'approved' });
}

/** operationId: requestDeliverableChanges */
export function requestDeliverableChanges(args) {
  return decide({ ...args, status: 'changes_requested' });
}

// ── the gate (D-48) ─────────────────────────────────────────────────────────

/**
 * Refuse `done` while a required deliverable is unapproved. Optional on the
 * store so the pre-PRD-05 unit harnesses keep composing (as isPlanLocked).
 */
export async function assertDeliverablesApproved(store, taskId) {
  if (!store.listDeliverables) return;
  const pending = pendingRequired(await store.listDeliverables({ taskId }));
  if (pending.length) {
    throw new ProblemError('invalid_transition',
      `${pending.length} required deliverable${pending.length === 1 ? ' is' : 's are'} not approved yet (D-48)`,
      { reason: 'deliverables_pending', pending_deliverable_ids: pending });
  }
}

// ── consumers ───────────────────────────────────────────────────────────────

const actorOfEvent = (evt) => ({
  personId: evt.actor?.person_id ?? null, orgId: evt.actor?.org_id ?? null, channel: 'system',
});

/** tendering.rfp.awarded (design) → required deliverables on the first tendered row. */
export async function seedAwardDeliverables({ store, evt }) {
  const d = evt?.data ?? {};
  const titles = Array.isArray(d.deliverables) ? d.deliverables.filter((t) => typeof t === 'string' && t.trim()) : [];
  const taskId = Array.isArray(d.root_task_ids) ? d.root_task_ids[0] : null;
  if (d.purpose !== 'design' || !titles.length || !UUID.test(taskId ?? '') || !evt.project_id || !d.rfp_id) return [];
  return store.seedDeliverables({
    projectId: evt.project_id, taskId, rfpId: d.rfp_id,
    titles: titles.map((t) => t.trim().slice(0, 300)), actor: actorOfEvent(evt),
  });
}

/** documents.version.uploaded → a submitted document's new version goes back to review (F-15). */
export async function resubmitOnNewVersion({ store, evt }) {
  const d = evt?.data ?? {};
  if (!evt.project_id || !UUID.test(d.document_id ?? '') || !Number.isInteger(d.version_no) || d.version_no < 2) return [];
  if (typeof d.sha256 !== 'string' || d.sha256.length !== 64) return [];
  return store.resubmitForNewVersion({
    projectId: evt.project_id,
    facts: { document_id: d.document_id, version_no: d.version_no, sha256: d.sha256, title: d.title ?? 'file', mime: d.mime ?? 'application/octet-stream' },
    note: typeof d.note === 'string' && d.note.trim() ? d.note.trim().slice(0, 2000) : null,
    actor: actorOfEvent(evt),
  });
}
