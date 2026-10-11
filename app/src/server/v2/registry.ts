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
import { createPlanningTaskPort } from '@modules/planning/application/task-port.mjs';
import { createPlanningOverviewPort } from '@modules/planning/application/overview-port.mjs';
import { xlsxWorkbooks } from '@modules/planning/infra/xlsx-reader.mjs';
import { createCostPort } from '@modules/contracting/application/cost-port.mjs';
import { createContractPartyPort } from '@modules/contracting/application/party-port.mjs';
import { createOrgPort } from '@modules/identity/application/org-port.mjs';
import { createQualityFactsPort } from '@modules/quality/application/project-facts-port.mjs';
import { registerQuality } from '@modules/quality/http/register.mjs';
import { createQualityStore } from '@modules/quality/infra/pg-store.mjs';
import { createNonConformityPort } from '@modules/quality/application/nonconformity-port.mjs';
import { registerTendering } from '@modules/tendering/http/register.mjs';
import { createTenderingStore } from '@modules/tendering/infra/pg-store.mjs';
import { createMailSender } from '@modules/tendering/infra/mail-sender.mjs';
import { createContractFromAward } from '@modules/contracting/application/award.mjs';
import { registerDocuments } from '@modules/documents/http/register.mjs';
import { createDocumentsStore } from '@modules/documents/infra/pg-store.mjs';
import { createDocumentsPort } from '@modules/documents/application/port.mjs';
import { createShareFilesPort } from '@modules/documents/application/share-port.mjs';
import { createR2ObjectStorage } from '@modules/documents/infra/storage.mjs';
import { registerCollaboration } from '@modules/collaboration/http/register.mjs';
import { createCollaborationStore } from '@modules/collaboration/infra/pg-store.mjs';
import { createQuestionPort } from '@modules/collaboration/application/question-port.mjs';
import { registerBilling } from '@modules/billing/http/register.mjs';
import { createBillingStore } from '@modules/billing/infra/pg-store.mjs';
import { createEntitlements } from '@modules/billing/application/entitled.mjs';
import { registerRecord } from '@modules/record/http/register.mjs';
import { registerDirectory } from '@modules/directory/http/register.mjs';
import { createDirectoryStore } from '@modules/directory/infra/pg-store.mjs';
import { createSpecialtyPort } from '@modules/directory/application/specialty-port.mjs';
import { createCompanyPort } from '@modules/directory/application/company-port.mjs';
import { createBuildPort } from '@modules/project/application/build-port.mjs';
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

  // Member management (PRD-12 N-9). Free tier (D-38): Clerk knows org:admin /
  // org:member; the catalogue role rides on public_metadata.org_role, which the
  // membership webhook mirrors (modules/identity/domain/mirror.mjs).
  async createOrganizationInvitation(args: {
    clerkOrgId: string; emailAddress: string; role: string;
    inviterClerkUserId: string; publicMetadata: Record<string, unknown>;
  }) {
    const client = await clerkClient();
    const inv = await client.organizations.createOrganizationInvitation({
      organizationId: args.clerkOrgId,
      emailAddress: args.emailAddress,
      role: args.role,
      inviterUserId: args.inviterClerkUserId,
      publicMetadata: args.publicMetadata,
    });
    return { id: inv.id };
  },

  async updateMembership(args: {
    clerkOrgId: string; clerkUserId: string; role: string; publicMetadata: Record<string, unknown>;
  }) {
    const client = await clerkClient();
    await client.organizations.updateOrganizationMembership({
      organizationId: args.clerkOrgId, userId: args.clerkUserId, role: args.role,
    });
    await client.organizations.updateOrganizationMembershipMetadata({
      organizationId: args.clerkOrgId, userId: args.clerkUserId, publicMetadata: args.publicMetadata,
    });
  },

  async deleteMembership(args: { clerkOrgId: string; clerkUserId: string }) {
    const client = await clerkClient();
    await client.organizations.deleteOrganizationMembership({
      organizationId: args.clerkOrgId, userId: args.clerkUserId,
    });
  },
};

export function getRouter() {
  if (router) return router;
  router = createRouter();

  // Phase 1 — Identity & Access (AGENT-INDEX §5).
  const identityStore = createIdentityStore(getPool());
  // Identity's organisation port: names and staffed people for Planning,
  // Tendering and Project (none of them reads identity.*).
  const orgs = createOrgPort(identityStore);
  registerIdentity(router, {
    store: identityStore,
    clerk: clerkGateway,
    // Billing's published entitlements port: the `seats` check on inviteMember
    // (doc 16 conjunction, D-05).
    entitlements: createEntitlements(createBillingStore(getPool())),
    webhookSecret: () => process.env.CLERK_WEBHOOK_SIGNING_SECRET,
  });

  // Phase 2 — Project (brief, lifecycle, locations, participants,
  // invitations, calendar, share links).
  const projectStore = createProjectStore(getPool());
  // PRD-09 O-1: the build home reads the owning modules' published query
  // ports (plan facts, client-side cost, quality facts, open questions) —
  // never their tables. O-4/O-5: an invitation's trade is checked and named
  // through the directory's taxonomy port.
  const directoryStore = createDirectoryStore(getPool());
  const planningStore = createPlanningStore(getPool());
  // Documents store and the shared R2 bucket are built up-front: Project's
  // share links (PRD-12 N-12) name and serve the build's files through the
  // documents share-files port; Planning, Tendering, Documents and Record
  // below reuse the same instances.
  const documentsStore = createDocumentsStore(getPool());
  const objectStorage = createR2ObjectStorage();
  const contractingStore = createContractingStore(getPool());
  registerProject(router, {
    store: projectStore,
    orgs,
    documents: createShareFilesPort(documentsStore, objectStorage),
    specialties: createSpecialtyPort(directoryStore),
    facts: {
      planning: createPlanningOverviewPort(planningStore),
      contracting: createCostPort(contractingStore),
      // Pending verifications hang on the build's rows: planning's task port.
      quality: createQualityFactsPort(createQualityStore(getPool()), createPlanningTaskPort(planningStore)),
      questions: createQuestionPort(createCollaborationStore(getPool())),
    },
    shareBaseUrl: () =>
      process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://portal.linknms.com'),
  });

  // Phases 3 + 5 — Contracting: core (contract tree, signature, V2/V3
  // projection) plus the money flow (sponsor, reception, termination,
  // change orders, measurements, payments, cash-flow).
  registerContracting(router, { store: contractingStore });

  // Documents store (phase 7, created above): Planning reads it through
  // the documents query port (PRD-05 deliverables bind a proven version),
  // Tendering injects it for the RFP BIM model (LINA-409 / doc 24 — the model
  // is a documents.document; tendering owns the RFP authorization, documents
  // owns persistence), and Record reuses the same instance for its export.

  // Phases 4 + 5 — Planning: the WBS plan (rows, links, working-day
  // propagation, D-26 deltas, D-33 edit scope, baseline binding on
  // signature) plus execution (progress, variations, cost lines) and the
  // deliverables of a task with the D-48 done gate (PRD-05).
  // Templates and imports land with later phases.
  // PRD-03 R-2: a row's specialty_code is checked through the directory's
  // taxonomy port (planning never reads directory.*).
  // PRD-09 O-6..O-11: the Excel import reads .xlsx through the exceljs reader
  // (planning infra) and maps the Trade column through the same taxonomy port.
  // Location names come from the project's build port, the prime contractor
  // from contracting's party port, organisation names from identity's port.
  registerPlanning(router, {
    store: planningStore,
    documents: createDocumentsPort(documentsStore),
    specialties: createSpecialtyPort(directoryStore),
    workbooks: xlsxWorkbooks,
    builds: createBuildPort(projectStore),
    contracts: createContractPartyPort(contractingStore),
    orgs,
  });

  // Phase 5 — Quality (verification, non-conformities, inspections). PRD-12
  // N-3/N-4: a non-conformity's or an inspection's locations are checked
  // through the project's build port, its photos through the documents query
  // port — quality reads neither module's tables.
  registerQuality(router, {
    store: createQualityStore(getPool()),
    builds: createBuildPort(projectStore),
    documents: createDocumentsPort(documentsStore),
  });

  // The R2 object store (created above) is shared by Documents, the share
  // links and the token-scoped proposal attachments Tendering exposes
  // (LINA-370) — one private bucket, presigned both ways.

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
    // PRD-04: the directory's company port (a profile's contact for an invite,
    // proof lines, a company's bidding profile) and the project's build port
    // (build name, municipality and point for the company inbox) — tendering
    // reads neither module's tables.
    directory: createCompanyPort(directoryStore),
    builds: createBuildPort(projectStore),
    // Identity's organisation port names a winner on the tendering home.
    orgs,
  });

  // Phase 7 — Documents (versioned files on R2 behind presigned tickets,
  // sha256 proven in the ledger, downloads gated by V6 scope visibility).
  // The store is created above (shared into Tendering and Record).
  // PRD-05: task links + task/project file reads; "also on sub-tasks" asks
  // the planning task port for a row's descendants.
  // PRD-06: a drawing markup that became a question or an issue is checked
  // through the Collaboration and Quality query ports (never their tables).
  registerDocuments(router, {
    store: documentsStore,
    storage: objectStorage,
    planning: createPlanningTaskPort(planningStore),
    questions: createQuestionPort(createCollaborationStore(getPool())),
    nonconformities: createNonConformityPort(createQualityStore(getPool())),
  });

  // Phase 7 — Collaboration (threads with addressed questions, meeting
  // minutes, the activity feed, notifications). The event consumers that
  // FILL notifications run with the outbox dispatcher, not here.
  // PRD-12 N-5: a scope-gap question is routed to the build's owner, named
  // through the project's build port (never project.*).
  registerCollaboration(router, { store: createCollaborationStore(getPool()), builds: createBuildPort(projectStore) });

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

  // Phase 9 — Directory (PRD-03): the specialty taxonomy, public search and
  // profiles (anonymous GETs — see the /api/v2 route), the company-side
  // editor, the claim path and the owner's consent. The build's point and
  // ownership come from the project module's build port; the "On the record"
  // read model is filled by the directory consumers in dispatcher.ts. Claim
  // links go out through the shared MailSender port.
  registerDirectory(router, {
    store: directoryStore,
    builds: createBuildPort(projectStore),
    mail: {
      sender: createMailSender({ provider: process.env.NOTIFICATIONS_MAIL_PROVIDER || undefined }),
      baseUrl: () =>
        process.env.NEXT_PUBLIC_APP_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://portal.linknms.com'),
    },
  });

  // Module registrations land phase by phase (AGENT-INDEX §5): reputation …

  return router;
}
