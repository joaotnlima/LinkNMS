// Coordination (PRD-12 N-3, N-5..N-7; flows C15–C17) — pure: question topics,
// the viewer's next steps on questions and minutes, and the notifications the
// quality and question events turn into. No I/O.
import { projectUrl } from './notifications.mjs';

/** What a question is (contract schema QuestionTopic). */
export const QUESTION_TOPICS = Object.freeze(['clarification', 'design_change', 'scope_gap']);
export const DESIGN_DECISIONS = Object.freeze(['approved', 'rejected']);

/**
 * Who a new question goes to. A scope gap — work nobody holds — is always the
 * owner's to assign (flow C17): an addressee naming anyone else is refused,
 * and the owner cannot flag a gap to itself.
 * @returns {{ok: true, addresseeOrgId: string} | {ok: false, error: string}}
 */
export function questionAddressee({ topic, addresseeOrgId, ownerOrgId, askerOrgId }) {
  if (topic !== 'scope_gap') {
    return addresseeOrgId ? { ok: true, addresseeOrgId } : { ok: false, error: 'a question is addressed to an organisation' };
  }
  if (!ownerOrgId) return { ok: false, error: 'this build has no owner yet to route a scope gap to' };
  if (askerOrgId === ownerOrgId) return { ok: false, error: 'scope gaps are flagged to the owner — you are the owner; assign the work instead' };
  if (addresseeOrgId && addresseeOrgId !== ownerOrgId) {
    return { ok: false, error: 'a scope gap is routed to the project owner' };
  }
  return { ok: true, addresseeOrgId: ownerOrgId };
}

/**
 * The answer's decision: required on a design change, refused elsewhere.
 * @returns {{ok: true, decision: string|null} | {ok: false, error: string}}
 */
export function answerDecision(topic, decision) {
  if (topic === 'design_change') {
    return DESIGN_DECISIONS.includes(decision)
      ? { ok: true, decision }
      : { ok: false, error: 'approve or reject the design change (decision: approved | rejected)' };
  }
  if (decision !== undefined && decision !== null) return { ok: false, error: 'only a design change carries a decision' };
  return { ok: true, decision: null };
}

/** answer: the addressee of an open question; resolve: the asker of an answered one. */
export function questionActions(q, orgId) {
  if (q.kind !== 'question' || q.deleted_at) return [];
  if (q.question_status === 'open' && orgId === q.addressee_org_id) return ['answer'];
  if (q.question_status === 'answered' && orgId === q.author_org_id) return ['resolve'];
  return [];
}

/** circulate: the writer of a draft; acknowledge: an attendee not yet acked. */
export function minuteActions(minute, acks, orgId) {
  if (minute.status === 'draft') return minute.created_by_org_id === orgId ? ['circulate'] : [];
  if (minute.status === 'circulated' && minute.attendees.includes(orgId) && !acks.some((a) => a.org_id === orgId)) {
    return ['acknowledge'];
  }
  return [];
}

// ── notifications (doc 10 §Notification centre) ─────────────────────────────

const enc = encodeURIComponent;

export function questionsUrl(projectId, commentId = null) {
  return `${projectUrl(projectId)}/questions${commentId ? `?q=${enc(commentId)}` : ''}`;
}

export function qualityUrl(projectId, nonconformityId = null) {
  return `${projectUrl(projectId)}/quality${nonconformityId ? `?nc=${enc(nonconformityId)}` : ''}`;
}

const OPENED_TITLES = Object.freeze({
  clarification: 'A question was addressed to your organisation',
  design_change: 'A design change is waiting for your approval',
  scope_gap: 'A scope gap was flagged to you — work nobody holds',
});

/** collaboration.question.* → the org whose move it is now. */
export function questionTargets(evt) {
  if (!evt.project_id) return [];
  const d = evt.data ?? {};
  const kind = evt.type.split('.').pop();
  const [orgId, title] = {
    opened: [d.addressee_org_id, OPENED_TITLES[d.topic] ?? OPENED_TITLES.clarification],
    answered: [d.asker_org_id, d.decision
      ? `Your design change was ${d.decision === 'approved' ? 'approved' : 'rejected'}`
      : 'Your question was answered'],
    resolved: [d.addressee_org_id, 'A question you answered was resolved'],
  }[kind] ?? [null, null];
  // Never notify the acting organisation about its own move.
  if (!orgId || orgId === evt.actor?.org_id) return [];
  return [{
    orgId,
    audience: 'project',
    category: 'questions',
    title,
    objectRef: { type: 'comment', id: d.comment_id, project_id: evt.project_id, url: questionsUrl(evt.project_id, d.comment_id) },
  }];
}

/**
 * quality.nonconformity.* → whose move it is: raised / assigned / fix
 * rejected → the assigned org (fix it); fixed → the raising org (close it or
 * reject the fix — only it may); closed → the assigned org (done).
 */
export function nonConformityTargets(evt) {
  if (!evt.project_id) return [];
  const d = evt.data ?? {};
  const ncId = d.nonconformity_id ?? null;
  const severity = d.severity ? `${d.severity} ` : '';
  const kind = d.kind === 'safety' ? 'safety' : 'quality';
  const step = evt.type.split('.').pop();
  const [orgId, title] = {
    raised: [d.assigned_to_org_id, `A ${severity}${kind} non-conformity was raised for your organisation`],
    assigned: [d.assigned_to_org_id, `A ${severity}${kind} non-conformity was assigned to your organisation`],
    fix_rejected: [d.assigned_to_org_id, 'Your fix of a non-conformity was rejected'],
    fixed: [d.raised_by_org_id, 'A non-conformity you raised was fixed — close it or reject the fix'],
    closed: [d.assigned_to_org_id, 'A non-conformity you fixed was closed'],
  }[step] ?? [null, null];
  if (!orgId || orgId === evt.actor?.org_id) return [];
  return [{
    orgId,
    audience: 'project',
    category: 'quality',
    title,
    objectRef: { type: 'nonconformity', ...(ncId ? { id: ncId } : {}), project_id: evt.project_id, url: qualityUrl(evt.project_id, ncId) },
  }];
}
