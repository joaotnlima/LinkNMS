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
import { documentsConsumers } from '@modules/documents/application/consumers.mjs';
import { createDocumentsStore } from '@modules/documents/infra/pg-store.mjs';
import { createR2ObjectStorage } from '@modules/documents/infra/storage.mjs';
import { selectDwgConverter } from '@modules/documents/infra/dwg-converters.mjs';
// Published notification audience ports (PRD-12 N-1, doc 10 §Notification
// centre): collaboration names recipients through these, never other tables.
import { createIdentityAudience } from '@modules/identity/application/audience.mjs';
import { createIdentityStore } from '@modules/identity/infra/pg-store.mjs';
import { createTenderingAudience } from '@modules/tendering/application/audience.mjs';
import { createTenderingStore } from '@modules/tendering/infra/pg-store.mjs';
import { createPlanningAudience } from '@modules/planning/application/audience.mjs';
import { createMailSender } from '@modules/tendering/infra/mail-sender.mjs';

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
      // PRD-06: DWG/DXF previews. The converter is a port chosen by
      // DWG_CONVERTER (default `none` → download only, reason
      // converter_not_configured); LibreDWG (GPL) is never bundled — D-49 legal
      // check pending, see to-be/08 §Documents.
      documentsConsumers(createDocumentsStore(pool), {
        storage: createR2ObjectStorage(),
        converter: selectDwgConverter(process.env),
      }),
      collaborationConsumers(createCollaborationStore(pool), {
        identity: createIdentityAudience(createIdentityStore(pool)),
        tendering: createTenderingAudience(createTenderingStore(pool)),
        planning: createPlanningAudience(createPlanningStore(pool)),
        // Notification e-mails reuse the one MailSender port (LINA-412): same
        // provider selection, same never-log-the-body rule. NOTIFICATIONS_MAIL_PROVIDER
        // can hold them back (e.g. `noop`) independently of tender invites.
        mail: {
          sender: createMailSender({ provider: process.env.NOTIFICATIONS_MAIL_PROVIDER || undefined }),
          baseUrl: () =>
            process.env.NEXT_PUBLIC_APP_URL
            ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://portal.linknms.com'),
        },
      }),
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
