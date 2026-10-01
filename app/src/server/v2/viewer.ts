// Clerk session → ViewerContext, the /api/v2 edge of the access model
// (to-be doc 16). This is the ONLY file on the v2 surface that touches Clerk;
// everything below the http layer receives the pure context object and stays
// testable without a session.
//
// ACCESS MODEL IS RESOLVED IN-HOUSE (ADR-0026). Permissions are NOT read from
// Clerk's session token (`session.has({permission})`) — that would require
// custom org permissions/roles to be provisioned into Clerk, which is a paid
// B2B add-on. Instead we own the access model: the role lives in our Neon
// mirror (`identity.org_membership.org_role`) and the role→permission matrix is
// pure code (`@modules/identity/domain/access.mjs`). Clerk is used for
// AUTHENTICATION and org membership only — all on its free tier.
import { auth } from '@clerk/nextjs/server';

import { createViewerContext } from '@platform/viewer-context.mjs';
import { createIdentityStore } from '@modules/identity/infra/pg-store.mjs';
import { ROLES, permissionsForRole } from '@modules/identity/domain/access.mjs';

import { getPool } from './registry';

// One store instance over the shared pool. registry.ts owns the pool and does
// NOT import this file, so this import is not a cycle.
let identityStore: ReturnType<typeof createIdentityStore> | null = null;
function store() {
  if (!identityStore) identityStore = createIdentityStore(getPool());
  return identityStore;
}

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

  // The DOMAIN role is the source of truth in our own DB, not Clerk. Clerk's
  // free tier can only carry its built-in `org:admin` / `org:member` on the
  // session; the finer catalogue roles (manager, representative, site_lead,
  // finance, inspector — doc 16 §4) live only in our mirror. So we read the
  // active membership's role and FALL BACK to the session's built-in role only
  // when the mirror has no active row yet (webhook race). Prefer the mirror.
  const membership =
    org && person ? await store().getActiveMembership(org.id, person.id) : null;
  const mirrorRole = membership?.org_role ?? null;
  const sessionRole = session.orgRole ? session.orgRole.replace(/^org:/, '') : null;
  const orgRole = mirrorRole ?? sessionRole;

  // Resolve permissions from the role via the in-repo matrix. `permissionsForRole`
  // throws on an unknown role, so guard with the catalogue first — an org with a
  // role outside doc 16 §4 (should never happen; the mirror rejects those) gets
  // no permissions rather than a 500.
  const permissions =
    clerkOrgId && orgRole && (ROLES as readonly string[]).includes(orgRole)
      ? permissionsForRole(orgRole)
      : [];

  return createViewerContext({
    clerkUserId: session.userId,
    personId: person?.id ?? null,
    orgId: org?.id ?? null,
    clerkOrgId,
    orgKind: org?.kind ?? null,
    // Clerk spells roles `org:admin`; the domain vocabulary (doc 16 §4, the
    // ledger's actor_org_role column) uses the bare key.
    orgRole,
    permissions,
    channel: 'ui',
  });
}
