// Directory event consumers — the "On the record" read model (PRD-03 R-11,
// D-46; to-be/10 §Directory read model).
//
// The directory never reads contracting, planning or tendering tables: it
// keeps its own record_* rows from their events. Delivery is at-least-once
// and ordered (platform/outbox.mjs), so the store applies each event's
// operations in ONE transaction together with its event_id in
// directory.consumed_event — a replay finds the id and changes nothing.
import { RECORD_EVENT_TYPES, recordOps } from '../domain/record-events.mjs';

/** @param {{ applyRecordEvent: Function }} store directory store */
export function directoryConsumers(store) {
  const handle = async (evt) => {
    const ops = recordOps(evt);
    if (!ops.length) return;
    await store.applyRecordEvent({ eventId: evt.event_id, type: evt.type, ops });
  };
  return Object.fromEntries(RECORD_EVENT_TYPES.map((type) => [type, handle]));
}
