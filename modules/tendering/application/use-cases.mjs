// Tendering module use cases (phase 6) — one function per operationId:
//   createRfp, getRfp, updateRfp, addRecipients, listRecipients, publishRfp,
//   addAddendum, closeRfp, cancelRfp, browseOpenRfps, listMyRfps,
//   askClarification, answerClarification, listProposalLanes, getProposal,
//   putProposal, submitProposal, withdrawProposal, recordOfflineProposal,
//   getComparison, shortlistProposal, awardRfp.
//
// Authorization is the doc-16 conjunction, in order:
//   permission (viewer.has, token-only) ∧ relationship ∧ staffing.
// Relationships (openapi x-relationship, docs 04/06):
//   issuer      — the org that created the RFP;
//   recipient   — an org invited on it (or holding a lane);
//   author      — the bidder org of a proposal (its lane, V8);
//   edit scope ∋ roots — createRfp: project owner at owner level, supplier
//                 of the live contract whose branch holds every root at sub
//                 level (R1); the level is DERIVED from this, never posted.
// publishRfp and awardRfp are x-human-only (doc 19): the MCP channel is
// answered forbidden{reason:'human_only'} before anything else.
// Entitlements (rfp.publish, rfp.open_listing, proposal.submit_open) are the
// billing module's port — phase 8; not enforced yet, documented in CHANGELOG.
//
// The store owns transactions AND writes ledger + outbox inside them
// (invariants §6.3/§6.4); a use case never half-commits. Proposal-scoped
// entries carry scope rfp_private (V7/V8).
import { ProblemError } from '../../../platform/errors.mjs';
import { visibilityOf, contractBody } from '../../contracting/domain/lifecycle.mjs';
import { rfpTransition, proposalTransition } from '../domain/lifecycle.mjs';
import {
  rfpBody, packageBody, recipientBody, clarificationBody, laneBody, proposalBody,
} from '../domain/wire.mjs';
import { comparisonMatrix, missingLineCount } from '../domain/comparison.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const VISIBILITIES = new Set(['invite_only', 'open']);
const ANCHORS = new Set(['start', 'end']);
const ROW_KINDS = new Set(['task', 'summary', 'milestone']);

// ── RFP lifecycle (issuer side) ─────────────────────────────────────────────

/** operationId: createRfp — package = subtrees + docs + quantities, no prices. */
export async function createRfp({ viewer, store, projectId, body, idempotencyKey }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { project } = await requireParticipant({ viewer, store, projectId });

  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (typeof body?.title !== 'string' || !body.title.trim()) errors.title = 'required';
  const roots = body?.root_task_ids;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((t) => !UUID.test(t ?? ''))) {
    errors.root_task_ids = 'a non-empty list of task ids';
  }
  if (body?.visibility !== undefined && !VISIBILITIES.has(body.visibility)) {
    errors.visibility = 'invite_only or open';
  }
  validateDeadlines(body, errors, { submissionRequired: true });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const uniqueRoots = [...new Set(roots)];
  const known = await store.tasksOfProject(projectId, uniqueRoots);
  const missing = uniqueRoots.filter((t) => !known.has(t));
  if (missing.length) {
    throw new ProblemError('validation_failed', null, { errors: { root_task_ids: `not rows of this project: ${missing.join(', ')}` } });
  }

  // Relationship: edit scope ∋ roots — and the LEVEL follows from it (D-35):
  // the owner tenders at owner level; a supplier tenders INSIDE its own live
  // branch (R1) and nowhere else.
  let level = null;
  let parentContractId = null;
  if (project.owner_org_id === viewer.orgId) {
    level = 'owner';
  } else {
    const branches = await store.branchContractsOf(uniqueRoots);
    const distinct = [...new Set(branches.map((b) => b.branch_contract_id ?? null))];
    if (distinct.length !== 1 || !distinct[0]) {
      throw new ProblemError('forbidden', 'the tendered rows are not inside one contract branch of yours', { reason: 'relationship' });
    }
    const contract = await store.getContract(distinct[0]);
    if (!contract || contract.supplier_org_id !== viewer.orgId
        || !['signed', 'active'].includes(contract.status)) {
      throw new ProblemError('forbidden', 'only the supplier of the live contract over these rows tenders inside it', { reason: 'relationship' });
    }
    level = 'sub';
    parentContractId = contract.id;
  }

  const snapshot = await store.snapshotPackage(projectId, uniqueRoots);
  const actor = await requireActor(store, viewer);
  return store.idempotent({ key: idempotencyKey, caller: viewer.clerkUserId, operationId: 'createRfp', body }, async () => {
    const created = await store.createRfp({
      id: body.id,
      projectId,
      issuerOrgId: viewer.orgId,
      level,
      parentContractId,
      title: body.title.trim(),
      scopeText: body.scope_text ?? null,
      visibility: body.visibility ?? 'invite_only',
      questionsDeadline: body.questions_deadline ?? null,
      submissionDeadline: body.submission_deadline,
      rootTaskIds: uniqueRoots,
      packageRows: snapshot.rows,
      packageItems: snapshot.items,
      actor: actorOf(actor, viewer),
    });
    return { status: 201, body: rfpBody(created) };
  });
}

/** operationId: getRfp — issuer: full; recipient: package + clarifications. */
export async function getRfp({ viewer, store, rfpId }) {
  const { rfp, isIssuer } = await requireRfpRead({ viewer, store, rfpId });
  const pkg = await store.packageOf(rfpId, rfp.package_version);
  // The asker is anonymised for everyone (V8); bidders additionally only see
  // what was PUBLISHED to all of them — answered questions and their own.
  const clarifications = (await store.clarificationsOf(rfpId))
    .filter((c) => isIssuer || c.status === 'answered' || c.asked_by_org_id === viewer.orgId)
    .map(clarificationBody);
  return {
    status: 200,
    body: { ...rfpBody(rfp), package: packageBody(pkg.rows, pkg.items), clarifications },
  };
}

/** operationId: updateRfp — draft only, If-Match on version. */
export async function updateRfp({ viewer, store, rfpId, body, ifMatch }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  requireVersionMatch(ifMatch, rfp.version);
  if (rfp.status !== 'draft') {
    throw new ProblemError('invalid_transition', 'after publication the package changes only by an addendum');
  }
  const errors = {};
  if (body?.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) errors.title = 'required';
  if (body?.visibility !== undefined && !VISIBILITIES.has(body.visibility)) errors.visibility = 'invite_only or open';
  validateDeadlines(body, errors, { submissionRequired: false });
  if (body?.root_task_ids !== undefined) {
    const roots = body.root_task_ids;
    if (!Array.isArray(roots) || roots.length === 0 || roots.some((t) => !UUID.test(t ?? ''))) {
      errors.root_task_ids = 'a non-empty list of task ids';
    }
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  let snapshot = null;
  let roots = null;
  if (body?.root_task_ids !== undefined) {
    roots = [...new Set(body.root_task_ids)];
    const known = await store.tasksOfProject(rfp.project_id, roots);
    const missing = roots.filter((t) => !known.has(t));
    if (missing.length) {
      throw new ProblemError('validation_failed', null, { errors: { root_task_ids: `not rows of this project: ${missing.join(', ')}` } });
    }
    snapshot = await store.snapshotPackage(rfp.project_id, roots);
  }

  const actor = await requireActor(store, viewer);
  const updated = await store.updateRfp({
    rfpId,
    expectedVersion: rfp.version,
    set: {
      title: body?.title?.trim(),
      scopeText: body?.scope_text,
      visibility: body?.visibility,
      questionsDeadline: body?.questions_deadline,
      submissionDeadline: body?.submission_deadline,
    },
    rootTaskIds: roots,
    packageRows: snapshot?.rows ?? null,
    packageItems: snapshot?.items ?? null,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('version_conflict', 'the RFP changed under you — re-read it');
  return { status: 200, body: rfpBody(updated) };
}

/** operationId: addRecipients — each opens a lane; one personal token each. */
export async function addRecipients({ viewer, store, rfpId, body }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  if (!['draft', 'published'].includes(rfp.status)) {
    throw new ProblemError('invalid_transition', `cannot invite on a ${rfp.status} RFP`);
  }
  const list = body?.recipients;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ProblemError('validation_failed', null, { errors: { recipients: 'a non-empty list' } });
  }
  const errors = {};
  list.forEach((r, i) => {
    if (r?.org_id !== undefined && !UUID.test(r.org_id ?? '')) errors[`recipients[${i}].org_id`] = 'an organisation id';
    if (r?.org_id === undefined && !EMAIL.test(r?.email ?? '')) errors[`recipients[${i}].email`] = 'org_id or a valid email required';
    if (r?.email !== undefined && !EMAIL.test(r.email)) errors[`recipients[${i}].email`] = 'a valid email';
  });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const resolved = [];
  for (const r of list) {
    if (r.org_id) {
      const org = await store.getOrganization(r.org_id);
      if (!org) {
        throw new ProblemError('validation_failed', null, { errors: { recipients: `unknown organisation ${r.org_id}` } });
      }
      if (org.id === rfp.issuer_org_id) {
        throw new ProblemError('validation_failed', null, { errors: { recipients: 'the issuer cannot invite itself' } });
      }
      resolved.push({ orgId: org.id, email: r.email ?? org.billing_email ?? org.contact_email ?? null, name: org.legal_name });
      if (!resolved[resolved.length - 1].email) {
        throw new ProblemError('validation_failed', null, { errors: { recipients: `organisation ${org.id} has no contact email — pass one` } });
      }
    } else {
      resolved.push({ orgId: null, email: r.email, name: null });
    }
  }

  const actor = await requireActor(store, viewer);
  const created = await store.addRecipients({
    rfpId,
    projectId: rfp.project_id,
    recipients: resolved,
    actor: actorOf(actor, viewer),
  });
  return {
    status: 201,
    body: {
      items: created.map(({ recipient, token }) => recipientBody(recipient, { token })),
      next_cursor: null,
    },
  };
}

/** operationId: listRecipients — per-recipient delivery status, issuer only. */
export async function listRecipients({ viewer, store, rfpId, query }) {
  await requireIssuer({ viewer, store, rfpId });
  const { items, nextCursor } = await store.listRecipients(rfpId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map((r) => recipientBody(r)), next_cursor: nextCursor } };
}

/** operationId: publishRfp — human-only; one individual email per recipient. */
export async function publishRfp({ viewer, store, rfpId }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId, humanOnly: 'publishing an RFP' });
  const outcome = rfpTransition(rfp.status, 'publish');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const recipients = await store.recipientCount(rfpId);
  if (recipients === 0 && rfp.visibility === 'invite_only') {
    throw new ProblemError('validation_failed', null, { errors: { recipients: 'invite at least one recipient before publishing' } });
  }
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionRfp({
    rfpId, from: rfp.status, to: outcome.to,
    eventType: 'tendering.rfp.published',
    projectId: rfp.project_id,
    data: { visibility: rfp.visibility, submission_deadline: iso(rfp.submission_deadline), specialties: rfp.specialties ?? [] },
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this RFP first');
  return { status: 200, body: rfpBody(updated) };
}

/**
 * operationId: addAddendum — R2: after publication the package changes only
 * by a versioned addendum; all bidders are notified, deadlines may extend.
 */
export async function addAddendum({ viewer, store, rfpId, body }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  if (rfp.status !== 'published') {
    throw new ProblemError('invalid_transition', 'an addendum amends a published RFP');
  }
  const errors = {};
  const summary = (body?.scope_text ?? body?.title ?? '').trim();
  if (!summary) errors.scope_text = 'describe what the addendum changes';
  validateDeadlines(body, errors, { submissionRequired: false });
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // The package is re-snapshotted from the live plan rows (the issuer edits
  // the plan first, then issues the addendum that carries the change).
  const snapshot = await store.snapshotPackage(rfp.project_id, rfp.root_task_ids);
  const actor = await requireActor(store, viewer);
  const updated = await store.addAddendum({
    rfpId,
    projectId: rfp.project_id,
    packageVersion: rfp.package_version + 1,
    summary,
    submissionDeadline: body?.submission_deadline ?? null,
    questionsDeadline: body?.questions_deadline ?? null,
    packageRows: snapshot.rows,
    packageItems: snapshot.items,
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: rfpBody(updated) };
}

/** operationId: closeRfp — close early (the deadline close is the same move). */
export async function closeRfp({ viewer, store, rfpId }) {
  return transitionRfpOp({ viewer, store, rfpId, action: 'close', eventType: 'tendering.rfp.closed' });
}

/** operationId: cancelRfp. */
export async function cancelRfp({ viewer, store, rfpId }) {
  return transitionRfpOp({ viewer, store, rfpId, action: 'cancel', eventType: 'tendering.rfp.cancelled' });
}

async function transitionRfpOp({ viewer, store, rfpId, action, eventType }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId });
  const outcome = rfpTransition(rfp.status, action);
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionRfp({
    rfpId, from: rfp.status, to: outcome.to,
    eventType,
    projectId: rfp.project_id,
    data: {},
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this RFP first');
  return { status: 200, body: rfpBody(updated) };
}

// ── discovery (bidder side) ────────────────────────────────────────────────

/** operationId: browseOpenRfps — open listing (D-15), published only. */
export async function browseOpenRfps({ viewer, store, query }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { items, nextCursor } = await store.browseOpenRfps({
    specialty: query?.specialty ?? null,
    municipality: query?.municipality ?? null,
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(rfpBody), next_cursor: nextCursor } };
}

/** operationId: listMyRfps — RFPs my org was invited to or applied to. */
export async function listMyRfps({ viewer, store, query }) {
  requireActiveOrg(viewer);
  const { items, nextCursor } = await store.listMyRfps(viewer.orgId, {
    cursor: query?.cursor ?? null, limit: clampLimit(query?.limit),
  });
  return { status: 200, body: { items: items.map(rfpBody), next_cursor: nextCursor } };
}

// ── clarifications ─────────────────────────────────────────────────────────

/** operationId: askClarification — recipient only; question stays open. */
export async function askClarification({ viewer, store, rfpId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const rfp = await store.getRfp(rfpId);
  if (!rfp) throw new ProblemError('not_found');
  if (!(await store.isRecipient(rfpId, viewer.orgId))) throw new ProblemError('not_found');
  if (rfp.status !== 'published') {
    throw new ProblemError('invalid_transition', 'questions are asked while the RFP is published');
  }
  if (rfp.questions_deadline && new Date(rfp.questions_deadline) < new Date()) {
    throw new ProblemError('invalid_transition', 'the questions deadline has passed');
  }
  const errors = {};
  if (!UUID.test(body?.id ?? '')) errors.id = 'client-generated UUIDv7 required';
  if (typeof body?.question !== 'string' || !body.question.trim()) errors.question = 'required';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const existing = await store.getClarification(body.id);
  if (existing) {
    if (existing.rfp_id === rfpId && existing.asked_by_org_id === viewer.orgId) {
      return { status: 201, body: clarificationBody(existing) };
    }
    throw new ProblemError('idempotency_mismatch', 'this id was already used by a different request');
  }

  const actor = await requireActor(store, viewer);
  const created = await store.askClarification({
    id: body.id,
    rfpId,
    projectId: rfp.project_id,
    askedByOrgId: viewer.orgId,
    question: body.question.trim(),
    actor: actorOf(actor, viewer),
  });
  return { status: 201, body: clarificationBody(created) };
}

/** operationId: answerClarification — published to all bidders, asker anonymised. */
export async function answerClarification({ viewer, store, clarificationId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const clarification = await store.getClarification(clarificationId);
  if (!clarification) throw new ProblemError('not_found');
  const rfp = await store.getRfp(clarification.rfp_id);
  if (rfp.issuer_org_id !== viewer.orgId) throw new ProblemError('not_found');
  await requireStaffing({ viewer, store, projectId: rfp.project_id });
  if (clarification.status !== 'open') {
    throw new ProblemError('invalid_transition', 'this question was already answered');
  }
  const answer = (body?.answer ?? '').trim();
  if (!answer) throw new ProblemError('validation_failed', null, { errors: { answer: 'required' } });

  const actor = await requireActor(store, viewer);
  const updated = await store.answerClarification({
    clarificationId,
    rfpId: rfp.id,
    projectId: rfp.project_id,
    answer,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'this question was already answered');
  return { status: 200, body: clarificationBody(updated) };
}

// ── proposals / lanes ──────────────────────────────────────────────────────

/** operationId: listProposalLanes — issuer: all lanes; bidder: only its own (V8). */
export async function listProposalLanes({ viewer, store, taskId, query }) {
  requireActiveOrg(viewer);
  const task = await store.getTask(taskId);
  if (!task) throw new ProblemError('not_found');
  await requireStaffing({ viewer, store, projectId: task.project_id });
  const { items, nextCursor } = await store.lanesForTask(taskId, {
    viewerOrgId: viewer.orgId,
    cursor: query?.cursor ?? null,
    limit: clampLimit(query?.limit),
  });
  const seesMoney = viewer.has('org:money:view');
  return { status: 200, body: { items: items.map((l) => laneBody(l, { seesMoney })), next_cursor: nextCursor } };
}

/** operationId: getProposal — issuer | author only (V8, 404 for anyone else). */
export async function getProposal({ viewer, store, proposalId }) {
  const { proposal } = await requireLane({ viewer, store, proposalId });
  const doc = await store.proposalDoc(proposalId);
  const seesMoney = viewer.has('org:money:view');
  return { status: 200, body: proposalBody(proposal, { ...doc, seesMoney }) };
}

/** operationId: putProposal — the bidder builds ITS plan in ITS lane (D-36). */
export async function putProposal({ viewer, store, proposalId, body, ifMatch }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isAuthor } = await requireLane({ viewer, store, proposalId });
  if (!isAuthor) throw new ProblemError('forbidden', 'only the bidder writes in its lane', { reason: 'relationship' });
  requireVersionMatch(ifMatch, proposal.version);
  if (proposal.rfp_status !== 'published') {
    throw new ProblemError('invalid_transition', 'proposals are edited while the RFP is published');
  }
  if (new Date(proposal.submission_deadline) < new Date()) {
    throw new ProblemError('invalid_transition', 'the submission deadline has passed');
  }
  const outcome = proposalTransition(proposal.status, 'start_draft');
  // A submitted proposal is revised in place until the deadline (doc 09) —
  // the revision counter only moves on :submit.
  const nextStatus = proposal.status === 'submitted' ? 'submitted' : (outcome.ok ? outcome.to : null);
  if (!nextStatus) throw new ProblemError('invalid_transition', outcome.reason);

  const parsed = parseProposalDoc(body, { packageVersion: proposal.package_version });
  const itemIds = parsed.lines.filter((l) => l.rfpItemId).map((l) => l.rfpItemId);
  if (itemIds.length) {
    const known = await store.itemsOfRfp(proposal.rfp_id, itemIds);
    const missing = itemIds.filter((i) => !known.has(i));
    if (missing.length) {
      throw new ProblemError('validation_failed', null, { errors: { lines: `not items of this RFP: ${missing.join(', ')}` } });
    }
  }

  const actor = await requireActor(store, viewer);
  const updated = await store.replaceProposalDoc({
    proposalId,
    expectedVersion: proposal.version,
    status: nextStatus,
    rows: parsed.rows,
    links: parsed.links,
    lines: parsed.lines,
    conditions: parsed.conditions,
    validityUntil: parsed.validityUntil,
    documentIds: parsed.documentIds,
    totalCents: parsed.totalCents,
    durationWd: parsed.durationWd,
    start: parsed.start,
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('version_conflict', 'the proposal changed under you — re-read it');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

/** operationId: submitProposal — new revision; the latest submitted counts. */
export async function submitProposal({ viewer, store, proposalId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isAuthor } = await requireLane({ viewer, store, proposalId });
  if (!isAuthor) throw new ProblemError('forbidden', 'only the bidder submits its lane', { reason: 'relationship' });
  if (proposal.rfp_status !== 'published') {
    throw new ProblemError('invalid_transition', 'the RFP is not open for submissions');
  }
  if (new Date(proposal.submission_deadline) < new Date()) {
    throw new ProblemError('invalid_transition', 'the submission deadline has passed');
  }
  if (proposal.channel === 'platform' && proposal.summary_total_cents == null) {
    throw new ProblemError('validation_failed', null, { errors: { lines: 'price the proposal before submitting' } });
  }
  const outcome = proposalTransition(proposal.status, 'submit');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  const updated = await store.submitProposal({
    proposalId,
    from: proposal.status,
    revision: proposal.current_revision + 1,
    totalCents: proposal.summary_total_cents ?? 0,
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    bidderOrgId: viewer.orgId,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

/** operationId: withdrawProposal — bidder, before award. */
export async function withdrawProposal({ viewer, store, proposalId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:bid')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isAuthor } = await requireLane({ viewer, store, proposalId });
  if (!isAuthor) throw new ProblemError('forbidden', 'only the bidder withdraws its lane', { reason: 'relationship' });
  const outcome = proposalTransition(proposal.status, 'withdraw');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionProposal({
    proposalId, from: proposal.status, to: outcome.to,
    eventType: 'tendering.proposal.withdrawn',
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

/** operationId: recordOfflineProposal — the issuer records an emailed answer. */
export async function recordOfflineProposal({ viewer, store, proposalId, body }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isIssuer } = await requireLane({ viewer, store, proposalId });
  if (!isIssuer) throw new ProblemError('forbidden', 'only the issuer records an emailed answer', { reason: 'relationship' });
  if (proposal.rfp_status !== 'published' && proposal.rfp_status !== 'closed') {
    throw new ProblemError('invalid_transition', 'the RFP is no longer receiving answers');
  }
  const errors = {};
  const docs = body?.document_ids;
  if (!Array.isArray(docs) || docs.length === 0 || docs.some((d) => !UUID.test(d ?? ''))) {
    errors.document_ids = 'the received documents (at least one id)';
  }
  if (!Number.isInteger(body?.total?.amount_cents) || body.total.amount_cents < 0) {
    errors.total = 'Money {amount_cents, currency}';
  } else if (body.total.currency !== 'EUR') errors.total = 'currency must be EUR';
  if (body?.duration_wd !== undefined && (!Number.isInteger(body.duration_wd) || body.duration_wd < 0)) {
    errors.duration_wd = 'working days ≥ 0';
  }
  if (body?.start !== undefined && !DATE_ONLY.test(body.start ?? '')) errors.start = 'YYYY-MM-DD';
  if (body?.validity_until !== undefined && !DATE_ONLY.test(body.validity_until ?? '')) errors.validity_until = 'YYYY-MM-DD';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // doc 09: invited → submitted directly when the issuer records the answer.
  const outcome = proposalTransition(proposal.status, 'submit');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);

  const actor = await requireActor(store, viewer);
  const updated = await store.recordOfflineProposal({
    proposalId,
    from: proposal.status,
    revision: proposal.current_revision + 1,
    totalCents: body.total.amount_cents,
    durationWd: body.duration_wd ?? null,
    start: body.start ?? null,
    conditions: body.conditions ?? null,
    validityUntil: body.validity_until ?? null,
    documentIds: [...new Set(docs)],
    recordedByPersonId: actor.id,
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

// ── evaluation and award ───────────────────────────────────────────────────

/** operationId: getComparison — issuer only, behind org:money:view (16 §5). */
export async function getComparison({ viewer, store, rfpId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:money:view')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { rfp } = await requireIssuer({ viewer, store, rfpId, permission: null });
  const pkg = await store.packageOf(rfpId, rfp.package_version);
  const lanes = (await store.lanesOfRfp(rfpId))
    .filter((p) => ['submitted', 'shortlisted', 'awarded'].includes(p.status));
  const ids = lanes.map((p) => p.id);
  const lines = ids.length ? await store.linesOfProposals(ids) : [];
  const rows = ids.length ? await store.rowsOfProposals(ids) : [];
  const matrix = comparisonMatrix({ items: pkg.items, proposals: lanes, lines, rows });
  const seesMoney = true; // gated above — the comparison IS money
  return {
    status: 200,
    body: {
      proposals: lanes.map((l) => laneBody({
        ...l,
        missing_lines: missingLineCount(pkg.items, lines.filter((x) => x.proposal_id === l.id)),
        variant_lines: lines.filter((x) => x.proposal_id === l.id && x.is_variant).length,
        has_plan: rows.some((r) => r.proposal_id === l.id),
      }, { seesMoney })),
      ...matrix,
    },
  };
}

/** operationId: shortlistProposal — issuer; submitted → shortlisted. */
export async function shortlistProposal({ viewer, store, proposalId }) {
  requireActiveOrg(viewer);
  if (!viewer.has('org:tendering:issue')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const { proposal, isIssuer } = await requireLane({ viewer, store, proposalId });
  if (!isIssuer) throw new ProblemError('forbidden', 'only the issuer shortlists', { reason: 'relationship' });
  const outcome = proposalTransition(proposal.status, 'shortlist');
  if (!outcome.ok) throw new ProblemError('invalid_transition', outcome.reason);
  const actor = await requireActor(store, viewer);
  const updated = await store.transitionProposal({
    proposalId, from: proposal.status, to: outcome.to,
    eventType: null, // ledger-only: doc 10 lists no .shortlisted event
    projectId: proposal.project_id,
    rfpId: proposal.rfp_id,
    actor: actorOf(actor, viewer),
  });
  if (!updated) throw new ProblemError('invalid_transition', 'someone moved this proposal first');
  const doc = await store.proposalDoc(proposalId);
  return { status: 200, body: proposalBody(updated, { ...doc, seesMoney: viewer.has('org:money:view') }) };
}

/**
 * operationId: awardRfp — human-only. One transaction: RFP → awarded, winner
 * lane → awarded, other live lanes → declined, and the CONTRACT DRAFT is
 * written by the contracting module's code on the same client (its award
 * port), so "awarded" can never exist without its contract. The plan copy +
 * baseline stay deferred to contracting.contract.signed (D-36).
 */
export async function awardRfp({ viewer, store, rfpId, body, contractingAward }) {
  const { rfp } = await requireIssuer({ viewer, store, rfpId, humanOnly: 'awarding an RFP' });

  const errors = {};
  if (!UUID.test(body?.proposal_id ?? '')) errors.proposal_id = 'the winning proposal id';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  const lanes = await store.lanesOfRfp(rfpId);
  const winner = lanes.find((p) => p.id === body.proposal_id);
  if (!winner) throw new ProblemError('not_found');
  const winnerMove = proposalTransition(winner.status, 'award');
  if (!winnerMove.ok) throw new ProblemError('invalid_transition', winnerMove.reason);
  if (!winner.bidder_org_id) {
    // An emailed bidder signs up before award: the contract needs a supplier
    // org (C1, NOT NULL) — same limitation as phase-3 supplier_email.
    throw new ProblemError('validation_failed', null, { errors: { proposal_id: 'the bidder has no organisation on the platform yet — it must sign up before award' } });
  }

  // Guard (doc 09): status closed, or published with every invitee responded.
  const allResponded = lanes.every((p) => !['invited', 'draft'].includes(p.status));
  if (rfp.status !== 'closed' && !(rfp.status === 'published' && allResponded)) {
    throw new ProblemError('invalid_transition', 'close the RFP first (or wait for every invitee to respond)');
  }

  const actor = await requireActor(store, viewer);
  const awarded = await store.awardRfp({
    rfpId,
    from: rfp.status,
    winnerProposalId: winner.id,
    // Every other live lane closes: answered ones lose, silent invitations
    // lapse — either way `declined` is the terminal evidence of the tender.
    declineProposalIds: lanes
      .filter((p) => p.id !== winner.id && ['invited', 'draft', 'submitted', 'shortlisted'].includes(p.status))
      .map((p) => p.id),
    note: typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null,
    projectId: rfp.project_id,
    actor: actorOf(actor, viewer),
    // The contracting module's award port, run on the SAME client/transaction.
    createContract: (client) => contractingAward(client, {
      rfp,
      winner,
      actor: actorOf(actor, viewer),
    }),
  });
  if (!awarded) throw new ProblemError('invalid_transition', 'someone moved this RFP first');
  // The issuer is the CLIENT of the new draft — full view; money still only
  // with org:money:view (16 §5), exactly as contracting projects it.
  const visibility = visibilityOf(awarded.contract, viewer.orgId);
  return {
    status: 201,
    body: contractBody(
      { ...awarded, signatures: [] },
      { visibility, canSeeMoney: viewer.has('org:money:view') },
    ),
  };
}

// ── shared helpers ─────────────────────────────────────────────────────────

/** Whole-document parse of #/components/schemas/Proposal (putProposal). */
function parseProposalDoc(body, { packageVersion }) {
  const errors = {};
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const links = Array.isArray(body?.links) ? body.links : [];
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (body?.rows !== undefined && !Array.isArray(body.rows)) errors.rows = 'a list';
  if (body?.links !== undefined && !Array.isArray(body.links)) errors.links = 'a list';
  if (body?.lines !== undefined && !Array.isArray(body.lines)) errors.lines = 'a list';

  const rowIds = new Set();
  rows.forEach((r, i) => {
    if (!UUID.test(r?.id ?? '')) errors[`rows[${i}].id`] = 'client-generated UUIDv7 required';
    else if (rowIds.has(r.id)) errors[`rows[${i}].id`] = 'duplicate row id';
    else rowIds.add(r.id);
    if (typeof r?.name !== 'string' || !r.name.trim()) errors[`rows[${i}].name`] = 'required';
    if (r?.kind !== undefined && !ROW_KINDS.has(r.kind)) errors[`rows[${i}].kind`] = 'task, summary or milestone';
    if (r?.packaged_task_id != null && !UUID.test(r.packaged_task_id)) errors[`rows[${i}].packaged_task_id`] = 'a task id';
    if (r?.parent_row_id != null && !UUID.test(r.parent_row_id)) errors[`rows[${i}].parent_row_id`] = 'a row id';
    if (r?.duration_wd !== undefined && r?.duration_wd !== null
        && (!Number.isInteger(r.duration_wd) || r.duration_wd < 0)) errors[`rows[${i}].duration_wd`] = 'working days ≥ 0';
    for (const f of ['start', 'finish']) {
      if (r?.[f] != null && !DATE_ONLY.test(r[f])) errors[`rows[${i}].${f}`] = 'YYYY-MM-DD';
    }
  });
  rows.forEach((r, i) => {
    if (r?.parent_row_id != null && UUID.test(r.parent_row_id) && !rowIds.has(r.parent_row_id)) {
      errors[`rows[${i}].parent_row_id`] = 'not a row of this proposal';
    }
  });
  links.forEach((l, i) => {
    if (!rowIds.has(l?.predecessor_id)) errors[`links[${i}].predecessor_id`] = 'not a row of this proposal';
    if (!rowIds.has(l?.successor_id)) errors[`links[${i}].successor_id`] = 'not a row of this proposal';
    if (!ANCHORS.has(l?.from_anchor)) errors[`links[${i}].from_anchor`] = 'start or end';
    if (!ANCHORS.has(l?.to_anchor)) errors[`links[${i}].to_anchor`] = 'start or end';
    if (l?.lag_wd !== undefined && !Number.isInteger(l.lag_wd)) errors[`links[${i}].lag_wd`] = 'an integer';
  });
  let totalCents = 0;
  lines.forEach((l, i) => {
    if (l?.rfp_item_id != null && !UUID.test(l.rfp_item_id)) errors[`lines[${i}].rfp_item_id`] = 'an item id';
    if (l?.proposal_row_id != null && !rowIds.has(l.proposal_row_id)) errors[`lines[${i}].proposal_row_id`] = 'not a row of this proposal';
    if (!l?.is_variant && l?.rfp_item_id == null) errors[`lines[${i}].rfp_item_id`] = 'required unless the line is a variant';
    if (typeof l?.description !== 'string' || !l.description.trim()) errors[`lines[${i}].description`] = 'required';
    if (typeof l?.unit !== 'string' || !l.unit.trim()) errors[`lines[${i}].unit`] = 'required';
    const qty = Number(l?.quantity);
    if (!Number.isFinite(qty) || qty < 0) errors[`lines[${i}].quantity`] = 'a quantity ≥ 0';
    const cents = l?.unit_price?.amount_cents;
    if (!Number.isInteger(cents) || cents < 0) errors[`lines[${i}].unit_price`] = 'Money {amount_cents ≥ 0, EUR}';
    else if (l.unit_price.currency !== 'EUR') errors[`lines[${i}].unit_price`] = 'currency must be EUR';
    else if (Number.isFinite(qty)) totalCents += Math.round(qty * cents);
  });
  if (body?.validity_until !== undefined && body?.validity_until !== null
      && !DATE_ONLY.test(body.validity_until)) errors.validity_until = 'YYYY-MM-DD';
  const documentIds = body?.document_ids ?? [];
  if (!Array.isArray(documentIds) || documentIds.some((d) => !UUID.test(d ?? ''))) {
    errors.document_ids = 'a list of document ids';
  }
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  // Summary derives from the bidder's own plan rows: the envelope of dated
  // top-level rows; duration the max row duration when nothing is dated.
  const dated = rows.filter((r) => r.start && r.finish);
  const start = dated.length ? dated.map((r) => r.start).sort()[0] : null;
  const finish = dated.length ? dated.map((r) => r.finish).sort().at(-1) : null;
  const durationWd = rows.reduce((max, r) => Math.max(max, r.duration_wd ?? 0), 0) || null;

  return {
    rows: rows.map((r, i) => ({
      id: r.id,
      packagedTaskId: r.packaged_task_id ?? null,
      parentRowId: r.parent_row_id ?? null,
      kind: r.kind ?? 'task',
      name: r.name.trim(),
      durationWd: r.duration_wd ?? null,
      start: r.start ?? null,
      finish: r.finish ?? null,
      position: String(i).padStart(6, '0'),
    })),
    links: links.map((l) => ({
      predecessorRow: l.predecessor_id,
      successorRow: l.successor_id,
      fromAnchor: l.from_anchor,
      toAnchor: l.to_anchor,
      lagWd: l.lag_wd ?? 0,
    })),
    lines: lines.map((l) => ({
      rfpItemId: l.rfp_item_id ?? null,
      proposalRowId: l.proposal_row_id ?? null,
      isVariant: Boolean(l.is_variant),
      description: l.description.trim(),
      unit: l.unit.trim(),
      quantity: Number(l.quantity),
      unitPriceCents: l.unit_price.amount_cents,
    })),
    conditions: typeof body?.conditions === 'string' ? body.conditions : null,
    validityUntil: body?.validity_until ?? null,
    documentIds: [...new Set(documentIds)],
    totalCents,
    durationWd,
    start,
    finish,
    packageVersion,
  };
}

function validateDeadlines(body, errors, { submissionRequired }) {
  const ts = /^\d{4}-\d{2}-\d{2}T/;
  if (submissionRequired && !ts.test(body?.submission_deadline ?? '')) {
    errors.submission_deadline = 'an ISO timestamp';
  } else if (body?.submission_deadline !== undefined && !ts.test(body?.submission_deadline ?? '')) {
    errors.submission_deadline = 'an ISO timestamp';
  }
  if (body?.questions_deadline !== undefined && body?.questions_deadline !== null
      && !ts.test(body.questions_deadline)) {
    errors.questions_deadline = 'an ISO timestamp';
  }
  if (body?.questions_deadline && body?.submission_deadline
      && body.questions_deadline > body.submission_deadline) {
    errors.questions_deadline = 'before the submission deadline';
  }
}

/** Load an RFP as issuer (with existence hiding + staffing). */
async function requireIssuer({ viewer, store, rfpId, humanOnly = null, permission = 'org:tendering:issue' }) {
  requireActiveOrg(viewer);
  if (humanOnly && viewer.channel === 'mcp') {
    throw new ProblemError('forbidden', `${humanOnly} is human-only`, { reason: 'human_only' });
  }
  if (permission && !viewer.has(permission)) throw new ProblemError('forbidden', null, { reason: 'role' });
  const rfp = await store.getRfp(rfpId);
  // 404, not 403: a non-party never learns the RFP exists (V8).
  if (!rfp || rfp.issuer_org_id !== viewer.orgId) throw new ProblemError('not_found');
  await requireStaffing({ viewer, store, projectId: rfp.project_id });
  return { rfp };
}

/** Load an RFP as issuer OR recipient (getRfp). */
async function requireRfpRead({ viewer, store, rfpId }) {
  requireActiveOrg(viewer);
  const rfp = await store.getRfp(rfpId);
  if (!rfp) throw new ProblemError('not_found');
  const isIssuer = rfp.issuer_org_id === viewer.orgId;
  if (isIssuer) {
    await requireStaffing({ viewer, store, projectId: rfp.project_id });
    return { rfp, isIssuer };
  }
  // An open published RFP is readable by any org that could bid on it (D-15);
  // an invite-only one just by its recipients.
  const invited = await store.isRecipient(rfpId, viewer.orgId);
  const open = rfp.visibility === 'open' && rfp.status === 'published';
  if (!invited && !open) throw new ProblemError('not_found');
  return { rfp, isIssuer: false };
}

/** Load a proposal with its rfp facts; V8: issuer | author, 404 otherwise. */
async function requireLane({ viewer, store, proposalId }) {
  requireActiveOrg(viewer);
  const proposal = await store.getProposal(proposalId);
  if (!proposal) throw new ProblemError('not_found');
  const isIssuer = proposal.issuer_org_id === viewer.orgId;
  const isAuthor = proposal.bidder_org_id === viewer.orgId;
  if (!isIssuer && !isAuthor) throw new ProblemError('not_found');
  if (isIssuer) await requireStaffing({ viewer, store, projectId: proposal.project_id });
  return { proposal, isIssuer, isAuthor };
}

function requireActiveOrg(viewer) {
  if (!viewer.orgId) throw new ProblemError('forbidden', 'pick an active organisation first', { reason: 'no_active_org' });
}

function seesWholeOrg(viewer) {
  return viewer.orgRole === 'admin' || viewer.orgRole === 'manager';
}

async function requireActor(store, viewer) {
  const person = await store.getPersonByClerkId(viewer.clerkUserId);
  if (!person) throw new ProblemError('version_conflict', 'your identity mirror has not caught up yet — retry');
  return person;
}

/** Participant + staffing conjunction on the RFP's project (doc 16 §4). */
async function requireParticipant({ viewer, store, projectId }) {
  requireActiveOrg(viewer);
  const project = await store.getProject(projectId);
  if (!project) throw new ProblemError('not_found');
  const related = project.owner_org_id === viewer.orgId
    || project.created_by_org_id === viewer.orgId
    || (await store.isParticipant(projectId, viewer.orgId));
  if (!related) throw new ProblemError('not_found');
  await requireStaffing({ viewer, store, projectId });
  return { project };
}

/** Staffing only (the relationship was already proven another way). */
async function requireStaffing({ viewer, store, projectId }) {
  if (seesWholeOrg(viewer)) return;
  const actor = await requireActor(store, viewer);
  if (!(await store.isStaffed(projectId, viewer.orgId, actor.id))) {
    throw new ProblemError('not_a_participant', 'you are not staffed on this project');
  }
}

function requireVersionMatch(ifMatch, version) {
  if (ifMatch === undefined || ifMatch === null || ifMatch === '') {
    throw new ProblemError('validation_failed', null, { errors: { 'If-Match': 'required — the current version' } });
  }
  if (String(ifMatch).replaceAll('"', '') !== String(version)) {
    throw new ProblemError('version_conflict', 'the resource changed under you — re-read it');
  }
}

function actorOf(person, viewer) {
  return { personId: person.id, orgId: viewer.orgId, orgRole: viewer.orgRole, channel: viewer.channel };
}

function clampLimit(raw) {
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
