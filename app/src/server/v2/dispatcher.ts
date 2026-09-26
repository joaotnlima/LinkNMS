// Runtime outbox dispatcher (phase 0 closes here). Assembles every module's
// event consumers over the shared pool and drains platform.outbox.
//
// Two triggers, both call dispatchOutbox():
//  - after() in the /api/v2 route: every successful write schedules a tick
//    once the response is sent, so consumers run seconds behind the commit.
//  - /api/internal/dispatch (cron): the at-least-once safety net for rows a
//    crashed instance left behind. Vercel cron, CRON_SECRET-guarded.
//
// Delivery semantics live in @platform/outbox.mjs: ordered, at-least-once,
// advisory-locked so overlapping triggers don't routinely double-deliver.
// Consumer maps are COMBINED, never object-merged — two modules subscribe to
// the same types (see combineConsumers).
import { combineConsumers, runDispatchTick } from '@platform/outbox.mjs';
import { projectConsumers } from '@modules/project/application/consumers.mjs';
import { contractingConsumers } from '@modules/contracting/application/consumers.mjs';
import { planningConsumers } from '@modules/planning/application/consumers.mjs';
import { qualityConsumers } from '@modules/quality/application/consumers.mjs';
import { collaborationConsumers } from '@modules/collaboration/application/consumers.mjs';
import { createProjectStore } from '@modules/project/infra/pg-store.mjs';
import { createContractingStore } from '@modules/contracting/infra/pg-store.mjs';
import { createPlanningStore } from '@modules/planning/infra/pg-store.mjs';
import { createQualityStore } from '@modules/quality/infra/pg-store.mjs';
import { createCollaborationStore } from '@modules/collaboration/infra/pg-store.mjs';

import { getPool } from './registry';

type Handlers = ReturnType<typeof combineConsumers>;
let handlers: Handlers | null = null;

function getHandlers(): Handlers {
  if (!handlers) {
    const pool = getPool();
    handlers = combineConsumers(
      projectConsumers(createProjectStore(pool)),
      contractingConsumers(createContractingStore(pool)),
      planningConsumers(createPlanningStore(pool)),
      qualityConsumers(createQualityStore(pool)),
      collaborationConsumers(createCollaborationStore(pool)),
    );
  }
  return handlers;
}

/**
 * Drain pending outbox rows once. Never throws: a failing consumer leaves its
 * row undispatched (the cron tick retries it in order) and is logged here —
 * the triggering request already succeeded and must not be failed after the
 * fact by its side effects.
 */
export async function dispatchOutbox(): Promise<number> {
  try {
    return await runDispatchTick(getPool(), getHandlers());
  } catch (err) {
    console.error('[v2 outbox] dispatch tick failed; rows stay pending for the cron retry', err);
    return 0;
  }
}
