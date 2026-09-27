// Clerk session → ViewerContext, the /api/v2 edge of the access model
// (to-be doc 16). This is the ONLY file on the v2 surface that touches Clerk;
// everything below the http layer receives the pure context object and stays
// testable without a session.
import { auth } from '@clerk/nextjs/server';

import { createViewerContext } from '@platform/viewer-context.mjs';
import { createIdentityStore } from '@modules/identity/infra/pg-store.mjs';

import { getPool } from './registry';

// One store instance over the shared pool. registry.ts owns the pool and does
// NOT import this file, so this import is not a cycle.
let identityStore: ReturnType<typeof createIdentityStore> | null = null;
function store() {
  if (!identityStore) identityStore = createIdentityStore(getPool());
  return identityStore;
}

// Doc 16 §5 — the custom-permission catalogue, spelled out. Clerk's `has()`
// answers from the session token; we materialise the answers once per request
// so the context stays a value, not a live closure over the session.
const PERMISSIONS = [
  'org:projects:create', 'org:projects:staff',
  'org:plan:edit', 'org:progress:report',
  'org:quality:verify', 'org:quality:inspect',
  'org:money:view', 'org:costs:edit',
  'org:variations:acknowledge',
  'org:changes:propose', 'org:changes:decide',
  'org:tendering:issue', 'org:tendering:bid',
  'org:contracts:sign',
  'org:measurements:submit', 'org:measurements:approve',
  'org:payments:declare', 'org:payments:confirm',
  'org:profile:manage', 'org:reviews:write', 'org:templates:publish',
  'org:members:manage', 'org:billing:manage',
] as const;

export type ViewerContext = ReturnType<typeof createViewerContext>;

/** Null means: not signed in — the route answers problem+json 401. */
export async function viewerFromClerk(): Promise<ViewerContext | null> {
  const session = await auth();
  if (!session.userId) return null;

  // Resolve the LOCAL identity from the Clerk webhook mirror (phase-1). The
  // access rule is `allow = permission ∧ relationship ∧ staffing ∧ entitlement`,
  // and the last three are looked up by these ids — a null personId/orgId makes
  // every scoped handler blind, so we resolve them here, once per request.
  //
  // FAIL CLOSED, never auto-provision: a userId with no mirrored person (webhook
  // not yet delivered) resolves to a viewer whose personId stays null, so scoped
  // handlers DENY rather than leak or invent a party. The mirror is Clerk's to
  // fill; the viewer only reads it.
  const clerkOrgId = session.orgId ?? null;
  const [person, org] = await Promise.all([
    store().getPersonByClerkId(session.userId),
    clerkOrgId ? store().getOrgByClerkId(clerkOrgId) : Promise.resolve(null),
  ]);

  return createViewerContext({
    clerkUserId: session.userId,
    personId: person?.id ?? null,
    orgId: org?.id ?? null,
    clerkOrgId,
    orgKind: org?.kind ?? null,
    // Clerk spells roles `org:admin`; the domain vocabulary (doc 16 §4, the
    // ledger's actor_org_role column) uses the bare key.
    orgRole: session.orgRole ? session.orgRole.replace(/^org:/, '') : null,
    permissions: session.orgId
      ? PERMISSIONS.filter((p) => session.has({ permission: p }))
      : [],
    channel: 'ui',
  });
}
