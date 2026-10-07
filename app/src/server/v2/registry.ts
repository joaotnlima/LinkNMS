// The one /api/v2 route table. Each module's http layer exports a
// `register(router)` and is mounted here — nowhere else — so this file is the
// complete answer to "what is live on v2" and stays diffable against
// cowork/documentation/api/v2/openapi.yaml.
import { Pool } from 'pg';
import { clerkClient } from '@clerk/nextjs/server';

import { createRouter } from '@platform/router.mjs';
import { registerIdentity } from '@modules/identity/http/register.mjs';
import { createIdentityStore } from '@modules/identity/infra/pg-store.mjs';
import { registerProject } from '@modules/project/http/register.mjs';
import { createProjectStore } from '@modules/project/infra/pg-store.mjs';
import { registerContracting } from '@modules/contracting/http/register.mjs';
import { createContractingStore } from '@modules/contracting/infra/pg-store.mjs';
import { registerPlanning } from '@modules/planning/http/register.mjs';
import { createPlanningStore } from '@modules/planning/infra/pg-store.mjs';
import { registerQuality } from '@modules/quality/http/register.mjs';
import { createQualityStore } from '@modules/quality/infra/pg-store.mjs';
import { registerTendering } from '@modules/tendering/http/register.mjs';
import { createTenderingStore } from '@modules/tendering/infra/pg-store.mjs';
import { createMailSender } from '@modules/tendering/infra/mail-sender.mjs';
import { createContractFromAward } from '@modules/contracting/application/award.mjs';
import { registerDocuments } from '@modules/documents/http/register.mjs';
import { createDocumentsStore } from '@modules/documents/infra/pg-store.mjs';
import { createR2ObjectStorage } from '@modules/documents/infra/storage.mjs';
import { registerCollaboration } from '@modules/collaboration/http/register.mjs';
import { createCollaborationStore } from '@modules/collaboration/infra/pg-store.mjs';
import { registerBilling } from '@modules/billing/http/register.mjs';
import { createBillingStore } from '@modules/billing/infra/pg-store.mjs';
import { registerRecord } from '@modules/record/http/register.mjs';
import { createRecordStore } from '@modules/record/infra/pg-store.mjs';

let router: ReturnType<typeof createRouter> | null = null;
let pool: Pool | null = null;

// One pool for the v2 surface, for now. The per-module least-privilege DB
// roles of doc 02 arrive with the module GRANTs (phase 2+); handlers already
// go through their module's store, so tightening later is a wiring change.
// Exported for dispatcher.ts — the outbox consumers run on the same pool.
export function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return pool;
}

// Clerk gateway port of the identity module — the only place besides
// viewer.ts where the v2 surface talks to Clerk.
const clerkGateway = {
  async createOrganization(args: {
    name: string; createdBy: string; publicMetadata: Record<string, unknown>;
  }) {
    const client = await clerkClient();
    const org = await client.organizations.createOrganization({
      name: args.name,
      createdBy: args.createdBy,
      publicMetadata: args.publicMetadata,
    });
    return { clerkOrgId: org.id };
  },
};

export function getRouter() {
  if (router) return router;
  router = createRouter();

  // Phase 1 — Identity & Access (AGENT-INDEX §5).
  registerIdentity(router, {
    store: createIdentityStore(getPool()),
    clerk: clerkGateway,
    webhookSecret: () => process.env.CLERK_WEBHOOK_SIGNING_SECRET,
  });

  // Phase 2 — Project (brief, lifecycle, locations, participants,
  // invitations, calendar, share links).
  registerProject(router, {
    store: createProjectStore(getPool()),
    shareBaseUrl: () =>
      process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://portal.linknms.com'),
  });

  // Phases 3 + 5 — Contracting: core (contract tree, signature, V2/V3
  // projection) plus the money flow (sponsor, reception, termination,
  // change orders, measurements, payments, cash-flow).
  registerContracting(router, { store: createContractingStore(getPool()) });

  // Phases 4 + 5 — Planning: the WBS plan (rows, links, working-day
  // propagation, D-26 deltas, D-33 edit scope, baseline binding on
  // signature) plus execution (progress, variations, cost lines).
  // Templates and imports land with later phases.
  registerPlanning(router, { store: createPlanningStore(getPool()) });

  // Phase 5 — Quality (verification, non-conformities, inspections).
  registerQuality(router, { store: createQualityStore(getPool()) });

  // The R2 object store is shared by Documents and by the token-scoped
  // proposal attachments Tendering exposes (LINA-370) — one private bucket,
  // presigned both ways.
  const objectStorage = createR2ObjectStorage();

  // Documents store (phase 7) is built up-front: Tendering injects it for the
  // RFP BIM model (LINA-409 / doc 24 — the model is a documents.document;
  // tendering owns the RFP authorization, documents owns persistence), and
  // Record reuses the same instance for its export artefact.
  const documentsStore = createDocumentsStore(getPool());

  // Phase 6 — Tendering (RFPs, lanes, comparison, award). The award
  // transaction runs contracting's award port on the same client so the
  // contract draft exists the instant the RFP says awarded.
  registerTendering(router, {
    store: createTenderingStore(getPool()),
    storage: objectStorage,
    documentsStore,
    contractingAward: createContractFromAward,
    // The invite email goes through the MailSender port (LINA-412). No
    // transactional provider is chosen yet (LINA-406, founder-gated), so the
    // default is no-op/log, selected by MAIL_PROVIDER; nothing hits the wire in
    // dev. The secure link is built on the same origin the project share links
    // use.
    mailSender: createMailSender(),
    linkBaseUrl: () =>
      process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://portal.linknms.com'),
  });

  // Phase 7 — Documents (versioned files on R2 behind presigned tickets,
  // sha256 proven in the ledger, downloads gated by V6 scope visibility).
  // The store is created above (shared into Tendering and Record).
  registerDocuments(router, {
    store: documentsStore,
    storage: objectStorage,
  });

  // Phase 7 — Collaboration (threads with addressed questions, meeting
  // minutes, the activity feed, notifications). The event consumers that
  // FILL notifications run with the outbox dispatcher, not here.
  registerCollaboration(router, { store: createCollaborationStore(getPool()) });

  // Phase 8 — Billing (plan catalogue, one subscription per org, usage,
  // add-ons). The entitlements PORT other modules consume is
  // createEntitlements(store) in modules/billing/application/entitled.mjs —
  // reads are never gated (doc 04 §4). No charging provider is wired (open
  // question 17): subscriptions run in manual mode (provider_ref null) and
  // /billing/webhooks/{provider} answers 404 for every provider name.
  registerBilling(router, { store: createBillingStore(getPool()) });

  // Record — the audit ledger, read side (LINA-359/LINA-374). Writers live in
  // every producing module (they ledger inside their own transaction, invariant
  // §6.4); this projects (V7-redacted), verifies the hash chain, and exports a
  // self-proving Document artefact. The export persists through the Documents
  // module above (createDocument + the shared R2 bucket).
  registerRecord(router, {
    store: createRecordStore(getPool()),
    documents: { store: documentsStore, storage: objectStorage },
  });

  // Module registrations land phase by phase (AGENT-INDEX §5): directory …

  return router;
}
