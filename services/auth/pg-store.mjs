// Auth — Postgres adapter for the authz store port (LINA-143; schema `authz`).
//
// Same surface as ./store.mjs's in-memory reference, backed by schema `authz`
// (migrations/000{1,2}_authz_rbac.sql). Connects as `authz_app` (made least-
// privilege in 0001: SELECT on catalog, SELECT/INSERT/UPDATE on the Clerk-mirror
// users/orgs/memberships; no DELETE anywhere — revocation is a status flip).
//
// JIT provisioning and the Clerk webhook both land here, idempotently:
//   * upsert on UNIQUE(clerk_user_id) / UNIQUE(clerk_org_id) — a race between
//     the webhook and a first-authenticated request settles on ONE row.
//   * setMembership is an INSERT ... ON CONFLICT (user_id, org_id) DO UPDATE,
//     so a replay / concurrent event converges on the latest role.
// All queries are schema-qualified `authz.*`; there is deliberately no
// cross-schema read anywhere (ADR-0006 §1).
import { getPool, withTransaction } from '../ledger/db.mjs';

const mapUser = (r) => r && {
  id: r.id,
  clerkUserId: r.clerk_user_id,
  email: r.email,
  displayName: r.display_name,
  status: r.status,
  language: r.language ?? 'en',
  setupComplete: r.setup_complete ?? false,
};
const mapOrg = (r) => r && { id: r.id, clerkOrgId: r.clerk_org_id, name: r.name };

/**
 * @param {Object} deps
 * @param {import('pg').Pool} [deps.pool]  authz_app connection pool
 */
export function createPgAuthStore({ pool = getPool() } = {}) {
  async function one(sql, params) {
    const { rows } = await pool.query(sql, params);
    return rows[0] ?? null;
  }
  async function all(sql, params) {
    const { rows } = await pool.query(sql, params);
    return rows ?? [];
  }

  return {
    async getUserByClerkId(clerkUserId) {
      return mapUser(await one('select * from authz.users where clerk_user_id = $1', [clerkUserId]));
    },
    async getOrgByClerkId(clerkOrgId) {
      return mapOrg(await one('select * from authz.orgs where clerk_org_id = $1', [clerkOrgId]));
    },
    async getMembership(userId, orgId) {
      return one(
        `select m.user_id as "userId", m.org_id as "orgId", m.role_id as "roleId", r.key as "roleKey"
           from authz.memberships m
           join authz.roles r on r.id = m.role_id
          where m.user_id = $1 and m.org_id = $2`,
        [userId, orgId],
      );
    },
    async getRolePermissions(roleId) {
      const rows = await all(
        `select p.key
           from authz.role_permissions rp
           join authz.permissions p on p.id = rp.permission_id
          where rp.role_id = $1`,
        [roleId],
      );
      return rows.map((r) => r.key);
    },
    async getResourceAcls(userId, resourceType, resourceId) {
      const rows = await all(
        `select p.key, a.effect
           from authz.resource_acls a
           join authz.permissions p on p.id = a.permission_id
          where a.user_id = $1 and a.resource_type = $2
            and ($3::uuid is null or a.resource_id = $3)`,
        [userId, resourceType, resourceId ?? null],
      );
      return rows.map((r) => ({ key: r.key, effect: r.effect }));
    },
    async isSetupComplete(clerkUserId) {
      const row = await one(
        'select setup_complete from authz.users where clerk_user_id = $1',
        [clerkUserId],
      );
      return row?.setup_complete ?? false;
    },

    // ── account-setup (LINA-137) ──
    // Atomic: profile write + membership grant in one transaction.
    async completeProfile({ clerkUserId, clerkOrgId, displayName, language, roleKey }) {
      return withTransaction(async (client) => {
        // Lock the user row to serialize concurrent setup attempts.
        const { rows: userRows } = await client.query(
          'select id, setup_complete from authz.users where clerk_user_id = $1 for update',
          [clerkUserId],
        );
        if (userRows.length === 0) return { status: 'not_found' };
        if (userRows[0].setup_complete) return { status: 'already_setup' };

        // Resolve the system role id (fail closed if roleKey is not seeded).
        const { rows: roleRows } = await client.query(
          'select id from authz.roles where key = $1 and org_id is null',
          [roleKey],
        );
        if (roleRows.length === 0) return { status: 'bad_role' };

        const roleId = roleRows[0].id;

        // Update the profile fields and flip the setup flag.
        await client.query(
          `update authz.users
              set display_name = $2, language = $3, setup_complete = true, updated_at = now()
            where clerk_user_id = $1`,
          [clerkUserId, displayName, language],
        );

        // Grant membership on the active org when one exists.
        let grantedRoleId = null;
        if (clerkOrgId) {
          const { rows: memRows } = await client.query(
            `insert into authz.memberships (user_id, org_id, role_id)
             select u.id, o.id, $3
               from authz.users u, authz.orgs o
              where u.clerk_user_id = $1 and o.clerk_org_id = $2
             on conflict (user_id, org_id)
             do update set role_id = excluded.role_id
             returning role_id as "roleId"`,
            [clerkUserId, clerkOrgId, roleId],
          );
          grantedRoleId = memRows[0]?.roleId ?? null;
        }

        return { status: 'ok', roleId: grantedRoleId };
      }, pool);
    },

    async upsertUser({ clerkUserId, email, displayName }) {
      const { rows } = await pool.query(
        `insert into authz.users (clerk_user_id, email, display_name)
         values ($1, $2, $3)
         on conflict (clerk_user_id)
         do update set email = coalesce(excluded.email, authz.users.email),
                       display_name = coalesce(excluded.display_name, authz.users.display_name),
                       updated_at = now()
         returning *`,
        [clerkUserId, String(email ?? '').toLowerCase(), displayName ?? null],
      );
      return mapUser(rows[0]);
    },
    async upsertOrg({ clerkOrgId, name }) {
      const { rows } = await pool.query(
        `insert into authz.orgs (clerk_org_id, name)
         values ($1, $2)
         on conflict (clerk_org_id)
         do update set name = coalesce(excluded.name, authz.orgs.name)
         returning *`,
        [clerkOrgId, name ?? 'Unnamed org'],
      );
      return mapOrg(rows[0]);
    },
    async setUserStatus(clerkUserId, status) {
      return mapUser(await one(
        `update authz.users set status = $2, updated_at = now()
          where clerk_user_id = $1 returning *`,
        [clerkUserId, status],
      ));
    },
    async setMembership({ clerkUserId, clerkOrgId, roleKey }) {
      const { rows } = await pool.query(
        `insert into authz.memberships (user_id, org_id, role_id)
         select u.id, o.id, r.id
           from authz.users u, authz.orgs o, authz.roles r
          where u.clerk_user_id = $1 and o.clerk_org_id = $2 and r.key = $3 and r.org_id is null
         on conflict (user_id, org_id)
         do update set role_id = excluded.role_id
         returning user_id as "userId", org_id as "orgId", role_id as "roleId"`,
        [clerkUserId, clerkOrgId, roleKey],
      );
      return rows[0] ?? null;
    },
    async removeMembership({ clerkUserId, clerkOrgId }) {
      await pool.query(
        `delete from authz.memberships
          where user_id = (select id from authz.users where clerk_user_id = $1)
            and org_id  = (select id from authz.orgs  where clerk_org_id = $2)`,
        [clerkUserId, clerkOrgId],
      );
    },
  };
}
