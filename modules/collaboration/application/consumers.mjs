// Collaboration-module event consumers (doc 10). Collaboration OWNS the
// notifications table, so it is this module that turns other modules' domain
// events into per-person rows:
//
//   collaboration.question.opened    → the addressee org's staffed people
//   collaboration.question.answered  → the asker (directly when known,
//                                      else the asker org's staffed people)
//   collaboration.question.resolved  → the addressee org's staffed people
//   quality.nonconformity.raised     → the assigned org's staffed people
//   tendering.clarification.answered → every bidder org named on the event
//   planning.variation.recorded/.updated
//     → 15-MINUTE DIGEST (doc 10: "owner digest, 15 min window") to the
//       owner org's staffed people plus subscribed orgs (doc 08): the first
//       variation of a window opens ONE unread notification; every further
//       variation folds into it (count in object_ref), so a re-planning
//       session reads as one line, not forty.
//
// Delivery is at-least-once: person-level dedupe is the DB's partial unique
// index (person_id, event_id); folded digest events are absorbed by the
// event_ids list inside object_ref. Nothing here is ledgered — notifications
// are housekeeping, not the build record.
export function collaborationConsumers(store) {
  async function notifyOrg({ evt, orgId, category, title, objectRef }) {
    if (!orgId || !evt.project_id) return;
    const personIds = await store.staffedPersons(evt.project_id, orgId);
    if (!personIds.length) return;
    await store.notifyPersons({ personIds, category, title, objectRef, eventId: evt.event_id });
  }

  async function digest(evt) {
    if (!evt.project_id) return;
    const kind = evt.data?.kind ?? null;
    const orgs = new Set(await store.variationSubscribers(evt.project_id, kind));
    const owner = await store.ownerOrgOf(evt.project_id);
    if (owner) orgs.add(owner);
    const personIds = [];
    for (const orgId of orgs) {
      personIds.push(...await store.staffedPersons(evt.project_id, orgId));
    }
    if (!personIds.length) return;
    await store.digestVariation({ personIds, projectId: evt.project_id, eventId: evt.event_id });
  }

  return {
    'collaboration.question.opened': (evt) => notifyOrg({
      evt,
      orgId: evt.data?.addressee_org_id,
      category: 'questions',
      title: 'A question was addressed to your organisation',
      objectRef: { type: 'comment', id: evt.data?.comment_id },
    }),

    'collaboration.question.answered': (evt) => notifyOrg({
      evt,
      orgId: evt.data?.asker_org_id,
      category: 'questions',
      title: 'Your question was answered',
      objectRef: { type: 'comment', id: evt.data?.comment_id },
    }),

    'collaboration.question.resolved': (evt) => notifyOrg({
      evt,
      orgId: evt.data?.addressee_org_id,
      category: 'questions',
      title: 'A question you answered was resolved',
      objectRef: { type: 'comment', id: evt.data?.comment_id },
    }),

    'quality.nonconformity.raised': (evt) => notifyOrg({
      evt,
      orgId: evt.data?.assigned_to_org_id,
      category: 'quality',
      title: 'A non-conformity was assigned to your organisation',
      objectRef: { type: 'nonconformity', id: evt.data?.nonconformity_id ?? evt.scope?.id },
    }),

    'tendering.clarification.answered': async (evt) => {
      for (const orgId of evt.data?.bidder_org_ids ?? []) {
        await notifyOrg({
          evt,
          orgId,
          category: 'tendering',
          title: 'A clarification was answered on an RFP you are bidding',
          objectRef: { type: 'rfp', id: evt.data?.rfp_id ?? evt.scope?.id },
        });
      }
    },

    'planning.variation.recorded': digest,
    'planning.variation.updated': digest,
  };
}
