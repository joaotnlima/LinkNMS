// Quality-module event consumers (doc 10). Quality OWNS the verification
// queue, so when planning announces a progress report that marked a row
// `done` it is this module that opens the request the client chain (or an
// invited inspector) will decide:
//   planning.progress.reported (status=done) → quality.verification_request
//   (pending), criteria snapshotted from the event.
// Creating the request is LEDGER-ONLY — doc 10 lists no outbox event for it;
// the events of this module are the decisions (.accepted / .rejected).
// Idempotent: at-least-once delivery is absorbed by the one-pending-request-
// per-task rule — a replay (or a second `done` while one is open) finds the
// pending row and does nothing.
import { randomUUID } from 'node:crypto';

export function qualityConsumers(store) {
  return {
    'planning.progress.reported': async (evt) => {
      if (evt.data?.status !== 'done') return;
      const taskId = evt.data.task_id ?? null;
      if (!taskId) return; // nothing to verify without a row
      const requestedByOrgId = evt.actor?.org_id ?? evt.data.org_id ?? null;
      if (!requestedByOrgId) return; // NOT NULL in the schema: no org, no request
      await store.createVerificationRequest({
        id: randomUUID(),
        taskId,
        projectId: evt.project_id,
        requestedByOrgId,
        criteria: evt.data.criteria ?? null,
        actor: {
          personId: evt.actor?.person_id ?? null,
          orgId: evt.actor?.org_id ?? null,
          channel: 'system',
        },
      });
    },
  };
}
