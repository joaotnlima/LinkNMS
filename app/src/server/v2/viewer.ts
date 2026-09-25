// Clerk session → ViewerContext, the /api/v2 edge of the access model
// (to-be doc 16). This is the ONLY file on the v2 surface that touches Clerk;
// everything below the http layer receives the pure context object and stays
// testable without a session.
import { auth } from '@clerk/nextjs/server';

import { createViewerContext } from '@platform/viewer-context.mjs';

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

  return createViewerContext({
    clerkUserId: session.userId,
    // identity.person / identity.organization ids come from the phase-1 mirror
    // (Clerk webhook → identity schema); until that lands the v2 surface knows
    // the Clerk ids only, and handlers that need the local ids must resolve
    // them through the identity module.
    personId: null,
    orgId: null,
    clerkOrgId: session.orgId ?? null,
    orgKind: null,
    // Clerk spells roles `org:admin`; the domain vocabulary (doc 16 §4, the
    // ledger's actor_org_role column) uses the bare key.
    orgRole: session.orgRole ? session.orgRole.replace(/^org:/, '') : null,
    permissions: session.orgId
      ? PERMISSIONS.filter((p) => session.has({ permission: p }))
      : [],
    channel: 'ui',
  });
}
