// Deliverables of a task (PRD-05 F-2, F-12..F-16, D-48) — pure: state, the
// done gate, who may do what, and the wire body. No I/O.
//
// THE RULE (D-06 visibility follows the contract chain, D-33 edit scope):
//   client side of a task = an organisation whose edit scope contains the row
//     (the owner, or a client anywhere up the branch's contract chain — the
//     branch supplier too when someone else is assigned) that is NOT the
//     task's effective assignee. It edits the required deliverables and
//     REVIEWS them. So the GC may approve its sub's deliverables on the
//     owner's behalf; the owner approves the GC's.
//   submit side = the task's effective assignee organisation (any org in edit
//     scope when the row has no assignee).
//   two-sided    = nobody decides a version its own organisation submitted
//     (as verification: the reporting org never verifies, doc 04).
import { inEditScope, effectiveAssignee } from './scope.mjs';

export const DELIVERABLE_STATUSES = Object.freeze(['not_yet', 'submitted', 'changes_requested', 'approved']);
const TITLE_MAX = 300;
const NOTE_MAX = 2000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The latest submission that counts (superseded rows never are latest). */
export function currentSubmission(submissions = []) {
  let latest = null;
  for (const s of submissions) if (!latest || s.seq > latest.seq) latest = s;
  return latest && latest.status !== 'superseded' ? latest : null;
}

/** A deliverable's state is its latest submission's; `not_yet` when none. */
export function deliverableStatus(submissions = []) {
  return currentSubmission(submissions)?.status ?? 'not_yet';
}

/**
 * D-48: the required, live deliverables that are not approved — `done` is
 * refused while this is non-empty.
 * @param {Array<{id, required, deleted_at?, submissions}>} deliverables
 */
export function pendingRequired(deliverables = []) {
  return deliverables
    .filter((d) => d.required && !d.deleted_at && deliverableStatus(d.submissions) !== 'approved')
    .map((d) => d.id);
}

/**
 * What `orgId` is to this task. `world` = {ownerOrgId, contracts}, `tasks` =
 * the plan's task map (for the inherited assignee).
 */
export function sideOf({ world, tasks, task, orgId }) {
  const assigneeOrgId = effectiveAssignee(tasks, task.id)?.orgId ?? null;
  const inScope = inEditScope(world, task, orgId);
  return {
    assigneeOrgId,
    clientSide: inScope && assigneeOrgId !== orgId,
    canSubmit: assigneeOrgId ? assigneeOrgId === orgId : inScope,
  };
}

/** May `orgId` decide this submission? Client side, never the submitter. */
export function canDecide(side, submission, orgId) {
  return Boolean(side.clientSide && submission && submission.status === 'submitted'
    && submission.submitted_by_org_id !== orgId);
}

/**
 * The organisations that review a task's deliverables — for notifications:
 * the owner and every org on the branch's contract chain (supplier of the
 * branch, clients up the chain) that is in edit scope, minus the assignee and
 * minus the submitter.
 */
export function reviewerOrgIds({ world, tasks, task, submitterOrgId = null }) {
  const candidates = new Set();
  if (world.ownerOrgId) candidates.add(world.ownerOrgId);
  let contractId = task.branchContractId ?? null;
  const seen = new Set();
  while (contractId && !seen.has(contractId)) {
    seen.add(contractId);
    const c = world.contracts.get(contractId);
    if (!c) break;
    if (c.supplierOrgId) candidates.add(c.supplierOrgId);
    if (c.clientOrgId) candidates.add(c.clientOrgId);
    contractId = c.parentContractId ?? null;
  }
  return [...candidates].filter((orgId) => sideOf({ world, tasks, task, orgId }).clientSide && orgId !== submitterOrgId);
}

// ── validation ───────────────────────────────────────────────────────────────

/** DeliverableCreate / DeliverablePatch fields. Returns {errors, value}. */
export function validateDeliverableFields(body, { partial = false } = {}) {
  const errors = {};
  const value = {};
  if (!partial || body?.title !== undefined) {
    if (typeof body?.title !== 'string' || !body.title.trim() || body.title.trim().length > TITLE_MAX) {
      errors.title = `1–${TITLE_MAX} characters`;
    } else value.title = body.title.trim();
  }
  if (body?.required !== undefined) {
    if (typeof body.required !== 'boolean') errors.required = 'true or false';
    else value.required = body.required;
  } else if (!partial) value.required = true;
  if (body?.due !== undefined) {
    if (body.due === null) value.due = null;
    else if (typeof body.due !== 'string' || !ISO_DATE.test(body.due)) errors.due = 'YYYY-MM-DD or null';
    else value.due = body.due;
  } else if (!partial) value.due = null;
  if (partial && !Object.keys(value).length && !Object.keys(errors).length) errors.body = 'at least one of title, required, due';
  return { errors, value };
}

/** A note or a decision comment: optional trimmed text ≤ 2000. */
export function validateText(raw, field, { required = false } = {}) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return required ? { error: { [field]: 'required' }, value: null } : { error: null, value: null };
  }
  if (typeof raw !== 'string' || raw.trim().length > NOTE_MAX) return { error: { [field]: `text up to ${NOTE_MAX} characters` }, value: null };
  return { error: null, value: raw.trim() };
}

// ── wire ─────────────────────────────────────────────────────────────────────

const iso = (v) => (v?.toISOString ? v.toISOString() : v ?? null);
const day = (v) => {
  if (v == null) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
};

export function submissionBody(s) {
  return {
    id: s.id,
    seq: s.seq,
    document_id: s.document_id,
    version_no: s.version_no,
    sha256: s.sha256,
    file_title: s.file_title,
    mime: s.mime,
    ...(s.note ? { note: s.note } : {}),
    submitted_by: { person_id: s.submitted_by_person_id, org_id: s.submitted_by_org_id },
    submitted_at: iso(s.submitted_at),
    status: s.status,
    ...(s.decided_by_org_id ? {
      decision: {
        by: { person_id: s.decided_by_person_id, org_id: s.decided_by_org_id },
        at: iso(s.decided_at),
        ...(s.decision_comment ? { comment: s.decision_comment } : {}),
      },
    } : {}),
  };
}

/** #/components/schemas/Deliverable — history newest first. */
export function deliverableBody(d) {
  const subs = [...(d.submissions ?? [])].sort((a, b) => b.seq - a.seq);
  const current = currentSubmission(subs);
  return {
    id: d.id,
    project_id: d.project_id,
    task_id: d.task_id,
    title: d.title,
    required: d.required,
    due: day(d.due),
    source_rfp_id: d.source_rfp_id ?? null,
    status: deliverableStatus(subs),
    ...(current ? { current: submissionBody(current) } : {}),
    history: subs.map(submissionBody),
    created_at: iso(d.created_at),
  };
}

/** #/components/schemas/TaskDeliverables for one viewer. */
export function taskDeliverablesBody({ taskId, deliverables, side, orgId }) {
  const live = deliverables.filter((d) => !d.deleted_at);
  const required = live.filter((d) => d.required);
  return {
    task_id: taskId,
    required_count: required.length,
    approved_count: required.filter((d) => deliverableStatus(d.submissions) === 'approved').length,
    done_blocked: pendingRequired(live).length > 0,
    to_review_count: live.filter((d) => canDecide(side, currentSubmission(d.submissions), orgId)).length,
    can_edit: side.clientSide,
    can_submit: side.canSubmit,
    can_review: side.clientSide,
    items: live.map(deliverableBody),
  };
}
