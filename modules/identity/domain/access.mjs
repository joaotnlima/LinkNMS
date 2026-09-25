// The access catalogue of to-be doc 16 — role sets (§4) and the permission
// matrix (§5) as pure data. This file is the single in-repo spelling of what
// gets provisioned into Clerk (scripts/provision-clerk.mjs reads it) and what
// the tests assert; if the doc changes, this file changes in the same PR.
//
// None of this DECIDES a request by itself: at runtime the answer comes from
// the Clerk session token (`viewer.has()`). This catalogue exists so the
// provisioning, the docs and the tests cannot drift apart.

/** Doc 16 §4 — 7 of the 10 role slots Clerk allows. Keys are the bare form;
 * Clerk spells them `org:<key>`. */
export const ROLES = Object.freeze([
  'admin', 'manager', 'representative', 'site_lead', 'finance', 'member', 'inspector',
]);

/** Doc 16 §4 — which roles an org of each kind can hand out. */
export const ROLE_SETS = Object.freeze({
  household: Object.freeze(['admin', 'representative', 'finance', 'member']),
  contractor: Object.freeze(['admin', 'manager', 'site_lead', 'finance', 'member']),
  consultant: Object.freeze(['admin', 'manager', 'inspector', 'member']),
});

/** Doc 16 §5 — permission → roles that hold it, row by row, verbatim. */
export const PERMISSION_MATRIX = Object.freeze({
  'org:projects:create':        ['admin', 'manager', 'representative'],
  'org:projects:staff':         ['admin', 'manager', 'representative'],
  'org:plan:edit':              ['admin', 'manager', 'representative', 'site_lead'],
  'org:progress:report':        ['admin', 'manager', 'representative', 'site_lead', 'member'],
  'org:quality:verify':         ['admin', 'manager', 'representative', 'site_lead', 'inspector'],
  'org:quality:inspect':        ['admin', 'manager', 'representative', 'site_lead', 'inspector'],
  'org:money:view':             ['admin', 'manager', 'representative', 'finance'],
  'org:costs:edit':             ['admin', 'manager'],
  'org:variations:acknowledge': ['admin', 'manager', 'representative'],
  'org:changes:propose':        ['admin', 'manager', 'representative'],
  'org:changes:decide':         ['admin', 'manager', 'representative'],
  'org:tendering:issue':        ['admin', 'manager', 'representative'],
  'org:tendering:bid':          ['admin', 'manager'],
  'org:contracts:sign':         ['admin', 'manager', 'representative'],
  'org:measurements:submit':    ['admin', 'manager', 'representative', 'finance'],
  'org:measurements:approve':   ['admin', 'manager', 'representative', 'finance'],
  'org:payments:declare':       ['admin', 'representative', 'finance'],
  'org:payments:confirm':       ['admin', 'representative', 'finance'],
  'org:profile:manage':         ['admin', 'manager'],
  'org:reviews:write':          ['admin', 'manager', 'representative'],
  'org:templates:publish':      ['admin', 'manager'],
  'org:members:manage':         ['admin'],
  'org:billing:manage':         ['admin', 'finance'],
});

export const PERMISSIONS = Object.freeze(Object.keys(PERMISSION_MATRIX));

/** Would this role hold this permission? (Provisioning + tests; runtime uses the token.) */
export function roleHolds(role, permission) {
  const holders = PERMISSION_MATRIX[permission];
  if (!holders) throw new Error(`unknown permission: ${permission}`);
  return holders.includes(role);
}

/** The permission list a role gets in Clerk. */
export function permissionsForRole(role) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  return PERMISSIONS.filter((p) => roleHolds(role, p));
}

/** May an org of this kind hand out this role? ('supplier' has no role set yet — doc 16 §6.) */
export function kindAllowsRole(kind, role) {
  const set = ROLE_SETS[kind];
  return Boolean(set && set.includes(role));
}
