// Collaboration-module event consumers (doc 10 §Notification centre, PRD-12
// N-1). Collaboration OWNS the notifications table, so it is this module that
// turns other modules' domain events into per-person rows — but it never reads
// another module's tables to find WHO: each owning module publishes an
// audience port, injected here by the composition root.
//
//   tendering.proposal.submitted     → issuer org ("bids in", Tender tab)
//   tendering.clarification.answered → bidder orgs still in the tender
//   tendering.rfp.awarded            → winner + every other bidder
//   tendering.rfp.cancelled          → bidder orgs still in the tender
//   tendering.bid_request.requested  → issuer org ("asking to bid", PRD-04)
//   tendering.bid_request.approved / .declined
//                                    → the asking company (D-47)
//   planning.variation.recorded/.updated
//     → 15-MINUTE DIGEST to owner + client of the row (planning port),
//       narrowed/extended by collaboration.variation_subscription
//   project.invitation.accepted      → the inviter org
//   planning.plan.imported           → the project owner (PRD-09 O-12)
//   collaboration.question.*         → addressee / asker org
//   quality.nonconformity.raised     → the assigned org
//   planning.deliverable.submitted   → client side of the task (planning port)
//   planning.deliverable.approved / .changes_requested
//                                    → the submitter org + the task's assignee
//   documents.version.uploaded       → owners of the tasks linking the file
//                                      (planning taskOwners; PRD-05 F-11)
//   documents.model.edited           → the model's author (not the editor) +
//                                      owners of the tasks whose elements
//                                      changed (PRD-07 M-12)
//
// People inside an org: identity.projectAudience (they work the project) or
// identity.orgAudience (role holds a permission — bidders are not staffed).
// Delivery is at-least-once: person-level dedupe is the DB's partial unique
// index (person_id, event_id); a replay inserts nothing and so mails nothing.
// Nothing here is ledgered — notifications are housekeeping, not the record.
import {
  bidSubmittedTargets, clarificationAnsweredTargets, awardedTargets, cancelledTargets,
  invitationAcceptedTargets, variationDigestOrgs, variationDigestRef, projectUrl, notificationEmail,
  deliverableSubmittedTargets, deliverableDecidedTargets, newVersionTargets, modelEditedTargets,
  bidRequestedTargets, bidRequestDecidedTargets, planImportedTargets,
} from '../domain/notifications.mjs';

const NO_PEOPLE = Object.freeze({ projectAudience: async () => [], orgAudience: async () => [] });

/**
 * @param {object} store collaboration pg-store
 * @param {{
 *   identity?: { projectAudience: Function, orgAudience: Function },
 *   tendering?: { rfpAudience: Function },
 *   planning?: { variationAudience: Function, deliverableAudience?: Function, taskOwners?: Function },
 *   mail?: { sender: { send: Function }, baseUrl?: string|(() => string) },
 *   logger?: { error: Function },
 * }} [ports]
 */
export function collaborationConsumers(store, ports = {}) {
  const identity = ports.identity ?? NO_PEOPLE;
  const logger = ports.logger ?? console;

  async function peopleOf(target, projectId) {
    return target.audience === 'org'
      ? identity.orgAudience(target.orgId, target.permission)
      : identity.projectAudience(projectId, target.orgId);
  }

  /** E-mail the people a row was just created for, unless they turned it off. */
  async function mailNew(inserted, people, { category, title, url }) {
    const sender = ports.mail?.sender;
    if (!sender || !inserted.length) return;
    const off = new Set(await store.emailDisabled(inserted, category));
    const baseUrl = typeof ports.mail.baseUrl === 'function' ? ports.mail.baseUrl() : (ports.mail.baseUrl ?? '');
    const message = notificationEmail({ title, url }, { baseUrl });
    for (const person of people) {
      if (!inserted.includes(person.person_id) || off.has(person.person_id) || !person.email) continue;
      try {
        await sender.send({ to: person.email, ...message });
      } catch (err) {
        // Best-effort: the in-app row is the notification; a failed mail must
        // not hold the outbox (a retry would insert nothing and mail nothing).
        logger.error?.('[collaboration.notify] e-mail failed', { category, status: err?.status ?? null });
      }
    }
  }

  async function deliver(evt, targets) {
    for (const t of targets) {
      const projectId = t.objectRef.project_id ?? evt.project_id;
      const people = await peopleOf(t, projectId);
      if (!people.length) continue;
      const inserted = await store.notifyPersons({
        personIds: people.map((p) => p.person_id),
        category: t.category,
        title: t.title,
        objectRef: t.objectRef,
        eventId: evt.event_id,
      });
      await mailNew(inserted, people, { category: t.category, title: t.title, url: t.objectRef.url });
    }
  }

  const onProject = (category, title, orgOf, refOf) => async (evt) => {
    if (!evt.project_id) return;
    await deliver(evt, [{
      orgId: orgOf(evt),
      audience: 'project',
      category,
      title,
      objectRef: { ...refOf(evt), project_id: evt.project_id, url: projectUrl(evt.project_id) },
    }].filter((t) => t.orgId));
  };

  const rfpEvent = (decide) => async (evt) => {
    if (!ports.tendering) return;
    const rfpId = evt.data?.rfp_id ?? null;
    if (!rfpId) return;
    const rfp = await ports.tendering.rfpAudience(rfpId);
    await deliver(evt, decide(evt, rfp));
  };

  async function digest(evt) {
    if (!evt.project_id || !ports.planning || !evt.data?.variation_id) return;
    const audience = await ports.planning.variationAudience(evt.data.variation_id);
    if (!audience) return;
    const orgs = variationDigestOrgs(audience, await store.variationSubscriptions(evt.project_id));
    const people = [];
    for (const orgId of orgs) people.push(...await identity.projectAudience(evt.project_id, orgId));
    if (!people.length) return;
    const ref = variationDigestRef(evt.project_id);
    const inserted = await store.digestVariation({
      personIds: people.map((p) => p.person_id), projectId: evt.project_id, eventId: evt.event_id, objectRef: ref,
    });
    // Only the row that OPENS a window is mailed; later events fold silently.
    await mailNew(inserted, people, { category: 'variations', title: 'A variation was recorded on this build', url: ref.url });
  }

  const deliverableEvent = (decide) => async (evt) => {
    if (!ports.planning?.deliverableAudience || !evt.data?.deliverable_id) return;
    const audience = await ports.planning.deliverableAudience(evt.data.deliverable_id, {
      submitterOrgId: evt.data.submitted_by_org_id ?? null,
    });
    await deliver(evt, decide(evt, audience));
  };

  async function newVersion(evt) {
    const taskIds = evt.data?.linked_task_ids ?? [];
    if (!ports.planning?.taskOwners || !evt.project_id || !taskIds.length || (evt.data?.version_no ?? 1) < 2) return;
    await deliver(evt, newVersionTargets(evt, await ports.planning.taskOwners(taskIds)));
  }

  async function modelEdited(evt) {
    if (!evt.project_id) return;
    const taskIds = evt.data?.task_ids ?? [];
    const owners = taskIds.length && ports.planning?.taskOwners ? await ports.planning.taskOwners(taskIds) : [];
    await deliver(evt, modelEditedTargets(evt, owners));
  }

  return {
    'tendering.proposal.submitted': rfpEvent(bidSubmittedTargets),
    'tendering.clarification.answered': rfpEvent(clarificationAnsweredTargets),
    'tendering.rfp.awarded': rfpEvent(awardedTargets),
    'tendering.rfp.cancelled': rfpEvent(cancelledTargets),
    'tendering.bid_request.requested': rfpEvent(bidRequestedTargets),
    'tendering.bid_request.approved': rfpEvent(bidRequestDecidedTargets),
    'tendering.bid_request.declined': rfpEvent(bidRequestDecidedTargets),

    'project.invitation.accepted': (evt) => deliver(evt, invitationAcceptedTargets(evt)),
    'planning.plan.imported': (evt) => deliver(evt, planImportedTargets(evt)),

    'collaboration.question.opened': onProject(
      'questions', 'A question was addressed to your organisation',
      (evt) => evt.data?.addressee_org_id, (evt) => ({ type: 'comment', id: evt.data?.comment_id }),
    ),
    'collaboration.question.answered': onProject(
      'questions', 'Your question was answered',
      (evt) => evt.data?.asker_org_id, (evt) => ({ type: 'comment', id: evt.data?.comment_id }),
    ),
    'collaboration.question.resolved': onProject(
      'questions', 'A question you answered was resolved',
      (evt) => evt.data?.addressee_org_id, (evt) => ({ type: 'comment', id: evt.data?.comment_id }),
    ),
    'quality.nonconformity.raised': onProject(
      'quality', 'A non-conformity was assigned to your organisation',
      (evt) => evt.data?.assigned_to_org_id,
      (evt) => ({ type: 'nonconformity', id: evt.data?.nonconformity_id ?? evt.scope?.id }),
    ),

    'planning.variation.recorded': digest,
    'planning.variation.updated': digest,

    'planning.deliverable.submitted': deliverableEvent(deliverableSubmittedTargets),
    'planning.deliverable.approved': deliverableEvent(deliverableDecidedTargets),
    'planning.deliverable.changes_requested': deliverableEvent(deliverableDecidedTargets),
    'documents.version.uploaded': newVersion,
    'documents.model.edited': modelEdited,
  };
}
