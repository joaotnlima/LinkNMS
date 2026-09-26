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

let router: ReturnType<typeof createRouter> | null = null;
let pool: Pool | null = null;

// One pool for the v2 surface, for now. The per-module least-privilege DB
// roles of doc 02 arrive with the module GRANTs (phase 2+); handlers already
// go through their module's store, so tightening later is a wiring change.
function getPool() {
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

  // Module registrations land phase by phase (AGENT-INDEX §5): tendering,
  // documents, collaboration, notifications, billing …

  return router;
}
