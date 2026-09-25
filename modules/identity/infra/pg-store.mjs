// Postgres store for the identity module (schema: identity.*, db/v2/0001).
//
// Owns its transactions. Project-scoped writes (staffing) append their ledger
// entry on the SAME client before commit — invariant §6.4. Mirror writes
// (person/org/membership) are convergent upserts: replaying a Clerk webhook
// is always safe.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { withIdempotency } from '../../../platform/idempotency.mjs';

/** @param {{ query: Function, connect: Function }} pool node-postgres Pool */
export function createIdentityStore(pool) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    // ── reads ────────────────────────────────────────────────────────────
    async getPersonByClerkId(clerkUserId) {
      const { rows } = await pool.query('SELECT * FROM identity.person WHERE clerk_user_id = $1', [clerkUserId]);
      return rows[0] ?? null;
    },

    async getOrgByClerkId(clerkOrgId) {
      const { rows } = await pool.query('SELECT * FROM identity.organization WHERE clerk_org_id = $1', [clerkOrgId]);
      return rows[0] ?? null;
    },

    async listOrgsForPerson(personId) {
      const { rows } = await pool.query(
        `SELECT o.*, m.org_role
           FROM identity.org_membership m
           JOIN identity.organization o ON o.id = m.org_id
          WHERE m.person_id = $1 AND m.status = 'active'
          ORDER BY o.created_at`,
        [personId],
      );
      return rows.map(({ org_role, ...org }) => ({ org, org_role }));
    },

    async listMembers(orgId, { cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT p.*, m.org_role
           FROM identity.org_membership m
           JOIN identity.person p ON p.id = m.person_id
          WHERE m.org_id = $1 AND m.status = 'active' AND ($2::uuid IS NULL OR p.id > $2::uuid)
          ORDER BY p.id
          LIMIT $3`,
        [orgId, cursor, limit + 1],
      );
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
    },

    async getActiveMembership(orgId, personId) {
      const { rows } = await pool.query(
        `SELECT org_role FROM identity.org_membership
          WHERE org_id = $1 AND person_id = $2 AND status = 'active'`,
        [orgId, personId],
      );
      return rows[0] ?? null;
    },

    async isProjectParticipant(projectId, orgId) {
      const { rows } = await pool.query(
        'SELECT 1 FROM project.participation WHERE project_id = $1 AND org_id = $2',
        [projectId, orgId],
      );
      return rows.length > 0;
    },

    async orgHasSignedContracts(orgId) {
      // Live signed paper blocks deletion; closed/terminated builds do not —
      // the mirror row is kept either way, so attribution never breaks.
      const { rows } = await pool.query(
        `SELECT 1 FROM contracting.contract
          WHERE (client_org_id = $1 OR supplier_org_id = $1)
            AND status IN ('signed','active','provisionally_received')
          LIMIT 1`,
        [orgId],
      );
      return rows.length > 0;
    },

    async mirrorReady(clerkOrgId, clerkUserId) {
      const { rows } = await pool.query(
        `SELECT (SELECT count(*) FROM identity.organization WHERE clerk_org_id = $1)
              + (SELECT count(*) FROM identity.person WHERE clerk_user_id = $2) AS n`,
        [clerkOrgId, clerkUserId],
      );
      return Number(rows[0].n) === 2;
    },

    // ── mirror writes (webhook + createOrganization) ─────────────────────
    async upsertPerson({ clerkUserId, email, name, phone, platformRole }) {
      const { rows } = await pool.query(
        `INSERT INTO identity.person (id, clerk_user_id, email, name, phone, platform_role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clerk_user_id) DO UPDATE
           SET email = excluded.email, name = excluded.name,
               phone = excluded.phone, platform_role = excluded.platform_role
         RETURNING *`,
        [randomUUID(), clerkUserId, email, name, phone ?? null, platformRole ?? null],
      );
      return rows[0];
    },

    async upsertOrganization({ clerkOrgId, orgKind, legalName, nif, approvalPolicy }) {
      const { rows } = await pool.query(
        `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name, nif, approval_policy)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clerk_org_id) DO UPDATE
           SET legal_name = excluded.legal_name, nif = excluded.nif,
               approval_policy = excluded.approval_policy
         RETURNING *`,
        // kind is deliberately NOT updated on conflict: it decides the role
        // set and visibility; changing it is a support operation, not a sync.
        [randomUUID(), clerkOrgId, orgKind, legalName, nif ?? null, approvalPolicy],
      );
      return rows[0];
    },

    async upsertMembership({ clerkOrgId, clerkUserId, orgRole }) {
      const { rows } = await pool.query(
        `INSERT INTO identity.org_membership (org_id, person_id, org_role, status, synced_at)
         SELECT o.id, p.id, $3, 'active', now()
           FROM identity.organization o, identity.person p
          WHERE o.clerk_org_id = $1 AND p.clerk_user_id = $2
         ON CONFLICT (org_id, person_id) DO UPDATE
           SET org_role = excluded.org_role, status = 'active', synced_at = now()
         RETURNING *`,
        [clerkOrgId, clerkUserId, orgRole],
      );
      return rows[0] ?? null;
    },

    async removeMembership({ clerkOrgId, clerkUserId }) {
      // Doc 16 §8 "remove someone from the company": membership goes, their
      // project staffing goes, their past actions stay in the ledger.
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE identity.org_membership m
              SET status = 'removed', synced_at = now()
             FROM identity.organization o, identity.person p
            WHERE o.clerk_org_id = $1 AND p.clerk_user_id = $2
              AND m.org_id = o.id AND m.person_id = p.id
           RETURNING m.org_id, m.person_id`,
          [clerkOrgId, clerkUserId],
        );
        if (!rows.length) return false;
        const { org_id, person_id } = rows[0];
        const { rows: staffed } = await client.query(
          'DELETE FROM identity.project_staffing WHERE org_id = $1 AND person_id = $2 RETURNING project_id',
          [org_id, person_id],
        );
        for (const { project_id } of staffed) {
          await appendAuditEvent(client, {
            projectId: project_id,
            actor: { personId: null, orgId: org_id, orgRole: null },
            category: 'identity',
            type: 'identity.staffing.removed',
            scope: { type: 'project', id: project_id },
            object: { type: 'person', id: person_id },
            payload: { org_id, person_id, cause: 'membership_removed' },
            channel: 'system',
          });
        }
        return true;
      });
    },

    // ── staffing (project-scoped, ledgered) ──────────────────────────────
    async staff({ projectId, orgId, personId, staffedBy, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO identity.project_staffing (project_id, org_id, person_id, staffed_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id, org_id, person_id) DO NOTHING
           RETURNING *`,
          [projectId, orgId, personId, staffedBy],
        );
        if (!rows.length) {
          // Already staffed: idempotent replay, no second ledger entry.
          const { rows: existing } = await client.query(
            'SELECT * FROM identity.project_staffing WHERE project_id = $1 AND org_id = $2 AND person_id = $3',
            [projectId, orgId, personId],
          );
          return existing[0];
        }
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'identity',
          type: 'identity.staffing.added',
          scope: { type: 'project', id: projectId },
          object: { type: 'person', id: personId },
          payload: { org_id: orgId, person_id: personId, staffed_by: staffedBy },
          channel: 'ui',
        });
        return rows[0];
      });
    },

    async unstaff({ projectId, orgId, personId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          'DELETE FROM identity.project_staffing WHERE project_id = $1 AND org_id = $2 AND person_id = $3 RETURNING *',
          [projectId, orgId, personId],
        );
        if (!rows.length) return false;
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'identity',
          type: 'identity.staffing.removed',
          scope: { type: 'project', id: projectId },
          object: { type: 'person', id: personId },
          payload: { org_id: orgId, person_id: personId, cause: 'unstaffed' },
          channel: 'ui',
        });
        return true;
      });
    },

    // ── idempotency (POST /organizations) ────────────────────────────────
    async idempotent(meta, fn) {
      if (!meta.key) return fn();
      return tx((client) => withIdempotency(client, meta, fn));
    },
  };
}
