// Notification centre domain (PRD-12 N-1, N-2; docs 08, 10) — pure: the
// category catalogue, the deep links, the effective preferences and the
// event → notification decisions. No I/O: the application layer feeds these
// with what the owning modules' audience ports answered.

/** Catalogue order = settings order (contract schema NotificationCategory). */
export const NOTIFICATION_CATEGORIES = Object.freeze([
  'bids', 'tendering', 'variations', 'invitations', 'questions', 'quality', 'files',
]);
export const NOTIFICATION_CHANNELS = Object.freeze(['in_app', 'email']);

// ── deep links (app-relative, to-be/20 URL structure) ───────────────────────

const enc = encodeURIComponent;

export function projectUrl(projectId) {
  return `/projects/${enc(projectId)}`;
}

/** The plan with a task's panel open, optionally on a tab (PRD-01 P-2). */
export function planTaskUrl(projectId, taskId, tab = null) {
  if (!taskId) return `${projectUrl(projectId)}/plan`;
  return `${projectUrl(projectId)}/plan?task=${enc(taskId)}${tab ? `&tab=${enc(tab)}` : ''}`;
}

/** A tender at its own address (PRD-08 H-1), optionally on a workspace tab. */
export function rfpUrl(projectId, rfpId, tab = null) {
  return `${projectUrl(projectId)}/tendering/rfps/${enc(rfpId)}${tab ? `?tab=${enc(tab)}` : ''}`;
}

// ── preferences ──────────────────────────────────────────────────────────────

/**
 * The full effective set: every category × channel in catalogue order, a
 * stored row where the person set one, else the default — enabled (doc 08).
 */
export function effectivePreferences(stored = []) {
  const set = new Map(stored.map((p) => [`${p.category}:${p.channel}`, p.enabled]));
  const out = [];
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const v = set.get(`${category}:${channel}`);
      out.push({ category, channel, enabled: v === undefined ? true : Boolean(v) });
    }
  }
  return out;
}

// ── event → notifications ────────────────────────────────────────────────────
//
// Each decision returns a list of "targets": { orgId, audience, permission?,
// category, title, objectRef }. `audience` says how the application turns the
// org into people: 'project' (people who work the project) or 'org' (members
// whose role holds `permission` — bidders, who are not project participants).

const quoted = (s) => (s ? `“${s}”` : 'a tender');

/** tendering.proposal.submitted → the issuer ("bids in"), on the task's Tender tab. */
export function bidSubmittedTargets(evt, rfp) {
  if (!rfp) return [];
  const projectId = rfp.project_id ?? evt.project_id;
  return [{
    orgId: rfp.issuer_org_id,
    audience: 'project',
    category: 'bids',
    title: `A bid arrived on ${quoted(rfp.title)}`,
    objectRef: {
      type: 'rfp',
      id: rfp.rfp_id,
      project_id: projectId,
      url: rfp.root_task_ids?.length
        ? planTaskUrl(projectId, rfp.root_task_ids[0], 'tender')
        : rfpUrl(projectId, rfp.rfp_id),
    },
  }];
}

/** tendering.clarification.answered → every bidder ORG still in the tender (never the issuer, V8). */
export function clarificationAnsweredTargets(evt, rfp) {
  if (!rfp) return [];
  const projectId = rfp.project_id ?? evt.project_id;
  return activeBidderOrgs(rfp).map((orgId) => ({
    orgId,
    audience: 'org',
    permission: 'org:tendering:bid',
    category: 'tendering',
    title: `A clarification was answered on ${quoted(rfp.title)}`,
    objectRef: { type: 'rfp', id: rfp.rfp_id, project_id: projectId, url: rfpUrl(projectId, rfp.rfp_id, 'clarifications') },
  }));
}

/** tendering.rfp.awarded → the winner ("won") and every other bidder ("not selected"). */
export function awardedTargets(evt, rfp) {
  if (!rfp) return [];
  const projectId = rfp.project_id ?? evt.project_id;
  const winnerProposalId = evt.data?.proposal_id ?? rfp.awarded_proposal_id ?? null;
  const objectRef = { type: 'rfp', id: rfp.rfp_id, project_id: projectId, url: rfpUrl(projectId, rfp.rfp_id) };
  const seen = new Set();
  const out = [];
  for (const b of rfp.bidders ?? []) {
    if (!b.org_id || seen.has(b.org_id)) continue;
    const won = winnerProposalId != null && b.proposal_id === winnerProposalId;
    if (!won && !b.active) continue;
    seen.add(b.org_id);
    out.push({
      orgId: b.org_id,
      audience: 'org',
      permission: 'org:tendering:bid',
      category: 'tendering',
      title: won
        ? `You were awarded ${quoted(rfp.title)}`
        : `${quoted(rfp.title)} was awarded to another bidder`,
      objectRef,
    });
  }
  return out;
}

/** tendering.rfp.cancelled → every bidder still in the tender. */
export function cancelledTargets(evt, rfp) {
  if (!rfp) return [];
  const projectId = rfp.project_id ?? evt.project_id;
  return activeBidderOrgs(rfp).map((orgId) => ({
    orgId,
    audience: 'org',
    permission: 'org:tendering:bid',
    category: 'tendering',
    title: `${quoted(rfp.title)} was cancelled by the issuer`,
    objectRef: { type: 'rfp', id: rfp.rfp_id, project_id: projectId, url: rfpUrl(projectId, rfp.rfp_id) },
  }));
}

/** project.invitation.accepted → the inviter org. */
export function invitationAcceptedTargets(evt) {
  const orgId = evt.data?.invited_by_org_id;
  if (!orgId || !evt.project_id) return [];
  return [{
    orgId,
    audience: 'project',
    category: 'invitations',
    title: 'Your invitation to this build was accepted',
    objectRef: { type: 'project', id: evt.project_id, project_id: evt.project_id, url: projectUrl(evt.project_id) },
  }];
}

/**
 * The orgs a variation digest goes to: the port's audience (owner + client of
 * the row), each narrowed by its own subscription when it has one, plus orgs
 * that subscribed to this kind (doc 08: variation subscriptions).
 * `subscriptions`: [{org_id, kinds[]}] for the project.
 */
export function variationDigestOrgs(audience, subscriptions = []) {
  if (!audience) return [];
  const byOrg = new Map(subscriptions.map((s) => [s.org_id, s.kinds ?? []]));
  const orgs = new Set();
  for (const orgId of audience.org_ids ?? []) {
    const kinds = byOrg.get(orgId);
    if (!kinds || kinds.includes(audience.kind)) orgs.add(orgId);
  }
  for (const [orgId, kinds] of byOrg) {
    if (kinds.includes(audience.kind)) orgs.add(orgId);
  }
  return [...orgs];
}

/** The digest row's link: the plan, where the changes are drawn (PRD-13). */
export function variationDigestRef(projectId) {
  return { type: 'project', id: projectId, project_id: projectId, url: `${projectUrl(projectId)}/plan` };
}

// ── task files and deliverables (PRD-05 F-11, F-13..F-15) ───────────────────

const filesRef = (projectId, taskId, type, id) => ({
  type, id, project_id: projectId, url: planTaskUrl(projectId, taskId, 'files'),
});

/**
 * planning.deliverable.submitted → the client side of the task (the planning
 * port's reviewers: owner / clients up the branch chain, minus the assignee
 * and the submitter).
 */
export function deliverableSubmittedTargets(evt, audience) {
  if (!audience) return [];
  const projectId = audience.project_id ?? evt.project_id;
  return [...new Set(audience.reviewer_org_ids ?? [])].map((orgId) => ({
    orgId,
    audience: 'project',
    category: 'files',
    title: `${quoted(audience.title)} was submitted for your review`,
    objectRef: filesRef(projectId, audience.task_id, 'deliverable', audience.deliverable_id),
  }));
}

/**
 * planning.deliverable.approved / .changes_requested → the submitting org and
 * the task's assignee org, never the deciding org.
 */
export function deliverableDecidedTargets(evt, audience) {
  if (!audience) return [];
  const projectId = audience.project_id ?? evt.project_id;
  const decider = evt.data?.decided_by_org_id ?? evt.actor?.org_id ?? null;
  const approved = evt.type === 'planning.deliverable.approved';
  const orgs = new Set([evt.data?.submitted_by_org_id, audience.assignee_org_id].filter(Boolean));
  orgs.delete(decider);
  return [...orgs].map((orgId) => ({
    orgId,
    audience: 'project',
    category: 'files',
    title: approved
      ? `${quoted(audience.title)} was approved`
      : `Changes were requested on ${quoted(audience.title)}`,
    objectRef: filesRef(projectId, audience.task_id, 'deliverable', audience.deliverable_id),
  }));
}

/**
 * documents.version.uploaded with linked tasks → the owner of every task that
 * uses the file (planning `taskOwners`), minus the uploader's org. One target
 * per org, linked to the first of its tasks.
 */
export function newVersionTargets(evt, owners = []) {
  const uploader = evt.actor?.org_id ?? null;
  const seen = new Set();
  const out = [];
  for (const o of owners) {
    if (!o.org_id || o.org_id === uploader || seen.has(o.org_id)) continue;
    seen.add(o.org_id);
    const projectId = o.project_id ?? evt.project_id;
    out.push({
      orgId: o.org_id,
      audience: 'project',
      category: 'files',
      title: `A new version of ${quoted(evt.data?.title)} (v${evt.data?.version_no ?? '?'}) is on a task you own`,
      objectRef: filesRef(projectId, o.task_id, 'document', evt.data?.document_id),
    });
  }
  return out;
}

/** Plain-text + HTML e-mail for one notification; the link is not a secret. */
export function notificationEmail({ title, url }, { baseUrl = '' } = {}) {
  const href = `${String(baseUrl).replace(/\/$/, '')}${url ?? ''}`;
  const safe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return {
    subject: title,
    text: `${title}\n\nOpen it in LinkNMS: ${href}\n\nYou can change which e-mails you get in Settings.`,
    html: `<p>${safe(title)}</p><p><a href="${safe(href)}">Open it in LinkNMS</a></p>`
      + '<p style="color:#666">You can change which e-mails you get in Settings.</p>',
  };
}

function activeBidderOrgs(rfp) {
  return [...new Set((rfp.bidders ?? []).filter((b) => b.active && b.org_id).map((b) => b.org_id))];
}
