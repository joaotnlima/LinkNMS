// Directory event consumers.
//
// 1. The "On the record" read model (PRD-03 R-11, D-46; to-be/10 §Directory
//    read model). The directory never reads contracting, planning or
//    tendering tables: it keeps its own record_* rows from their events.
//    Delivery is at-least-once and ordered (platform/outbox.mjs), so the store
//    applies each event's operations in ONE transaction together with its
//    event_id in directory.consumed_event — a replay finds the id and changes
//    nothing.
// 2. Unclaimed profiles for e-mail invitees (PRD-04 X-2): when an RFP is sent
//    (tendering.rfp.published) or more invitees are added to a sent one
//    (tendering.rfp.recipients_added), every address-only invitee gets an
//    unclaimed profile it can later claim. The addresses come from tendering's
//    published invitee port. Seeding is idempotent per address (the seeder
//    returns the existing unclaimed profile), so a replay adds nothing.
import { RECORD_EVENT_TYPES, recordOps } from '../domain/record-events.mjs';
import { unclaimedNameFor } from '../domain/unclaimed.mjs';
import { createUnclaimedProfileSeeder } from './claims.mjs';

/**
 * @param {{ applyRecordEvent: Function }} store directory store
 * @param {{ invitees?: { emailInviteesOf: Function }, logger?: { error: Function } }} [ports]
 */
export function directoryConsumers(store, ports = {}) {
  const handle = async (evt) => {
    const ops = recordOps(evt);
    if (!ops.length) return;
    await store.applyRecordEvent({ eventId: evt.event_id, type: evt.type, ops });
  };
  const consumers = Object.fromEntries(RECORD_EVENT_TYPES.map((type) => [type, handle]));
  if (!ports.invitees) return consumers;

  const seeder = createUnclaimedProfileSeeder(store);
  const seed = async (evt) => {
    const rfpId = evt.data?.rfp_id;
    if (!rfpId) return;
    const { emails = [], specialty_codes: specialties = [] } = await ports.invitees.emailInviteesOf(rfpId) ?? {};
    for (const email of emails) {
      const displayName = unclaimedNameFor(email);
      if (!displayName) continue; // a personal-mail address names no company
      await seeder.ensureUnclaimed({ displayName, contactEmail: email, specialties });
    }
  };
  for (const type of ['tendering.rfp.published', 'tendering.rfp.recipients_added']) {
    const prior = consumers[type];
    consumers[type] = prior ? async (evt) => { await prior(evt); await seed(evt); } : seed;
  }
  return consumers;
}
