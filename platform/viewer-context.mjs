// ViewerContext — who is acting, resolved ONCE per request (to-be doc 16).
//
// The rule of the access model is
//     allow = permission ∧ relationship ∧ staffing ∧ entitlement
// and this object carries the FIRST factor plus the identities the other
// three are looked up by. It is pure data + `has()`: building it from a Clerk
// session lives in the app adapter (app/src/server/v2), because Clerk is an
// edge concern and everything below the http layer must be testable without it.
//
// Deliberately NOT here: project participation, branch scope, staffing —
// those are per-project DATA (doc 16 §1) answered by module queries, never
// cached on the session object where they would go stale mid-request-stream.

export const ORG_ROLES = Object.freeze([
  'admin', 'manager', 'representative', 'site_lead', 'finance', 'member', 'inspector',
]);
export const ORG_KINDS = Object.freeze(['household', 'contractor', 'consultant', 'supplier']);
export const CHANNELS = Object.freeze(['ui', 'mcp', 'api', 'import', 'system']);

/**
 * @param {{
 *   clerkUserId: string,
 *   personId: string|null,        // identity.person.id — null until phase-1 mirror resolves it
 *   orgId: string|null,           // identity.organization.id of the ACTIVE org (null: personal session)
 *   clerkOrgId: string|null,
 *   orgKind: string|null,
 *   orgRole: string|null,
 *   permissions: Iterable<string>, // org:<feature>:<action> from the session token
 *   platformRole?: 'support'|'admin'|null,
 *   channel?: 'ui'|'mcp'|'api'
 * }} init
 */
export function createViewerContext(init) {
  const {
    clerkUserId, personId = null, orgId = null, clerkOrgId = null,
    orgKind = null, orgRole = null, permissions = [],
    platformRole = null, channel = 'ui',
  } = init;
  if (!clerkUserId) throw new Error('viewer context needs a clerkUserId');
  if (orgRole !== null && !ORG_ROLES.includes(orgRole)) {
    throw new Error(`unknown org role: ${orgRole}`);
  }
  if (orgKind !== null && !ORG_KINDS.includes(orgKind)) {
    throw new Error(`unknown org kind: ${orgKind}`);
  }
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel: ${channel}`);

  const perms = new Set(permissions);
  return Object.freeze({
    clerkUserId,
    personId,
    orgId,
    clerkOrgId,
    orgKind,
    orgRole,
    platformRole,
    channel,
    /** `has('org:plan:edit')` — the Clerk custom-permission check, token-only. */
    has: (permission) => perms.has(permission),
    /** For the ledger's actor columns (person, org, role at the moment of the action). */
    actor: () => ({ personId, orgId, orgRole }),
  });
}
