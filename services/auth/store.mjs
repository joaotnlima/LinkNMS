// Auth — persistence port + an in-memory reference implementation (LINA-143).
//
// The auth service (JIT provisioning, Clerk webhook sync, `can()` resolver) is
// written against this PORT, not against Postgres. The Postgres adapter
// (./pg-store.mjs, schema `authz`, migrations/000{1,2}_authz_rbac.sql) wraps
// exactly these methods with schema-qualified `authz.*` SQL and the same
// invariants. This in-memory store lets the service run and be adversarially
// tested with zero dependencies (the same discipline as services/identity/store.mjs).
//
// PORT — reads:
//   getUserByClerkId(clerkUserId) -> user|null
//   getOrgByClerkId(clerkOrgId)   -> org|null
//   getMembership(userId, orgId)  -> { roleId, roleKey } | null
//   getRolePermissions(roleId)    -> string[] (permission keys)
//   getResourceAcls(userId, resourceType, resourceId) -> [{key,effect}]
//   isSetupComplete(clerkUserId) -> boolean
// PORT — sync writes (webhook + JIT):
//   upsertUser({clerkUserId,email,displayName}) -> user
//   upsertOrg({clerkOrgId,name}) -> org
//   setUserStatus(userId, 'active'|'disabled') -> user
//   setMembership({userId,orgId,roleKey}) -> member  (idempotent upsert)
//   removeMembership({clerkUserId,clerkOrgId}) -> void
// PORT — account-setup (LINA-137):
//   completeProfile({clerkUserId,clerkOrgId,displayName,language,roleKey})
//     -> { status: 'ok'|'already_setup'|'not_found'|'bad_role', roleId? }  
//     Atomic: profile + membership in one unit of work.
//
// All rows are returned as fresh shallow copies so callers cannot mutate stored
// state by holding a reference (the DB gives you copies too).

export function createMemoryAuthStore() {
  /** @type {Map<string, any>} */ const users = new Map();   // by clerk_user_id
  /** @type {Map<string, any>} */ const orgs = new Map();    // by clerk_org_id
  /** @type {Map<string, any>} */ const memberships = new Map(); // key: userId|orgId
  /** @type {Map<string, string[]>} */ const rolePerms = new Map(); // roleKey -> perm keys
  /** @type {Map<string, Array<{key,effect}>>} */ const acls = new Map(); // key: userId|type|id

  const copy = (o) => (o ? { ...o } : null);

  // ---- seeded system roles for the reference (mirror the 0002 seed) ----
  rolePerms.set('owner', [
    'project.create', 'project.read', 'project.update', 'project.delete',
    'project.invite', 'member.invite', 'decision.create', 'decision.read',
    'change_order.create', 'change_order.read', 'change_order.decide',
    'budget.read', 'schedule.read', 'schedule.update', 'task.assign',
  ]);
  rolePerms.set('gc', [
    'project.read', 'decision.create', 'decision.read', 'change_order.create',
    'change_order.read', 'change_order.decide', 'budget.read', 'schedule.read',
    'schedule.update', 'progress.report', 'plan.upload', 'task.assign',
  ]);
  rolePerms.set('subcontractor', [
    'project.read', 'change_order.read', 'budget.read', 'schedule.read',
    'progress.report', 'task.assign',
  ]);

  return {
    // ── reads ──
    async getUserByClerkId(clerkUserId) { return copy(users.get(clerkUserId) ?? null); },
    async getOrgByClerkId(clerkOrgId) { return copy(orgs.get(clerkOrgId) ?? null); },
    async getMembership(userId, orgId) {
      return copy(memberships.get(`${userId}|${orgId}`) ?? null);
    },
    async getRolePermissions(roleId) {
      return [...(rolePerms.get(roleId) ?? [])];
    },
    async getResourceAcls(userId, resourceType, resourceId) {
      return [...(acls.get(`${userId}|${resourceType}|${resourceId}`) ?? [])].map(copy);
    },
    async isSetupComplete(clerkUserId) {
      return users.get(clerkUserId)?.setupComplete ?? false;
    },

    // ── account-setup (LINA-137) ──
    async completeProfile({ clerkUserId, clerkOrgId, displayName, language, roleKey }) {
      const user = users.get(clerkUserId);
      if (!user) return { status: 'not_found' };
      if (user.setupComplete) return { status: 'already_setup' };
      if (!rolePerms.has(roleKey)) return { status: 'bad_role' };

      user.displayName = displayName;
      user.language = language;
      user.setupComplete = true;

      let roleId = null;
      if (clerkOrgId) {
        const org = orgs.get(clerkOrgId) ?? (await this.upsertOrg({ clerkOrgId }));
        const key = `${user.id}|${org.id}`;
        memberships.set(key, { userId: user.id, orgId: org.id, roleId: roleKey, roleKey });
        roleId = roleKey;
      }
      return { status: 'ok', roleId };
    },

    // ── sync writes (webhook + JIT) ──
    async upsertUser({ clerkUserId, email, displayName }) {
      const existing = users.get(clerkUserId);
      const row = {
        id: existing?.id ?? `u-${clerkUserId}`,
        clerkUserId,
        email: (email ?? existing?.email ?? '').toLowerCase(),
        displayName: displayName ?? existing?.displayName ?? null,
        status: existing?.status ?? 'active',
        language: existing?.language ?? 'en',
        setupComplete: existing?.setupComplete ?? false,
      };
      users.set(clerkUserId, row);
      return copy(row);
    },
    async upsertOrg({ clerkOrgId, name }) {
      const existing = orgs.get(clerkOrgId);
      const row = {
        id: existing?.id ?? `o-${clerkOrgId}`,
        clerkOrgId,
        name: name ?? existing?.name ?? 'Unnamed org',
      };
      orgs.set(clerkOrgId, row);
      return copy(row);
    },
    async setUserStatus(clerkUserId, status) {
      const row = users.get(clerkUserId);
      if (!row) return null;
      row.status = status;
      return copy(row);
    },
    async setMembership({ clerkUserId, clerkOrgId, roleKey }) {
      const user = users.get(clerkUserId) ?? (await this.upsertUser({ clerkUserId }));
      const org = orgs.get(clerkOrgId) ?? (await this.upsertOrg({ clerkOrgId }));
      if (!rolePerms.has(roleKey)) {
        throw new Error(`unknown role key "${roleKey}"`);
      }
      const key = `${user.id}|${org.id}`;
      memberships.set(key, { userId: user.id, orgId: org.id, roleId: roleKey, roleKey });
      return copy(memberships.get(key));
    },
    async removeMembership({ clerkUserId, clerkOrgId }) {
      const user = users.get(clerkUserId);
      const org = orgs.get(clerkOrgId);
      if (!user || !org) return;
      memberships.delete(`${user.id}|${org.id}`);
    },
  };
}
