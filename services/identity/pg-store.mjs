// Identity — the Postgres adapter for the store port (ADR-0006 §1, design §6).
//
// Same surface as ./store.mjs's in-memory reference, backed by schema `identity`.
// The trust-critical part is `transaction(fn)`: the project/membership projection
// writes and the `ledger.append_event(...)` call commit together on ONE pooled
// connection (identity_app), so a ledger failure can never leave a projection
// ahead of the chain. The ledger append is done through the pg ledger core's
// `append(client, …)` on that same client — hash-chain construction stays in one
// place, and identity_app holds only EXECUTE on append_event, no INSERT on
// audit_event (migrations/0002_identity.sql).
//
// Cross-schema reads never happen here: the budget summary is served by the Ledger
// port (the same `ledger` object exposes budgetSummary over its own connection).
import { withTransaction, getPool } from '../ledger/db.mjs';
import { conflict, notFound } from './errors.mjs';

const PG_UNIQUE_VIOLATION = '23505';

// Map a Postgres unique violation to a typed 409 with a caller-meaningful message.
function asConflict(err) {
  if (err?.code !== PG_UNIQUE_VIOLATION) return err;
  const c = err.constraint || '';
  if (c === 'membership_project_role_uq') return conflict('project already has a member in that role');
  if (c === 'membership_project_party_uq') return conflict('party is already a member of this project');
  if (c === 'identity_invitation_one_pending') return conflict('project already has a pending invitation');
  if (c.includes('token_hash')) return conflict('invitation token collision');
  return conflict('uniqueness constraint violated');
}

const mapProject = (r) => r && {
  id: r.id,
  name: r.name,
  ownerPartyId: r.owner_party_id,
  baselineBudgetCents: Number(r.baseline_budget_cents),
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
};
const mapMembership = (r) => r && {
  id: r.id,
  projectId: r.project_id,
  partyId: r.party_id,
  role: r.role,
  joinedAt: r.joined_at instanceof Date ? r.joined_at.toISOString() : r.joined_at,
};
const mapInvitation = (r) => r && {
  id: r.id,
  projectId: r.project_id,
  tokenHash: r.token_hash,
  role: r.role,
  status: r.status,
  invitedByPartyId: r.invited_by_party_id,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  acceptedAt: r.accepted_at instanceof Date ? r.accepted_at.toISOString() : r.accepted_at,
};

/**
 * @param {Object} deps
 * @param {import('pg').Pool} [deps.pool]  identity_app connection pool
 * @param {{ append(client, event): Promise<any> }} deps.ledger  pg ledger core
 */
export function createPgStore({ pool = getPool(), ledger }) {
  if (!ledger?.append) throw new Error('pg identity store requires a ledger with append(client, …)');

  async function one(sql, params) {
    const { rows } = await pool.query(sql, params);
    return rows[0] ?? null;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────
  async function getProject(id) {
    return mapProject(await one('select * from identity.project where id = $1', [id]));
  }
  async function getMembership(projectId, partyId) {
    return mapMembership(await one(
      'select * from identity.membership where project_id = $1 and party_id = $2',
      [projectId, partyId],
    ));
  }
  async function listMemberships(projectId) {
    const { rows } = await pool.query(
      `select * from identity.membership where project_id = $1
        order by (role <> 'owner'), joined_at, id`,
      [projectId],
    );
    return rows.map(mapMembership);
  }
  async function getInvitationByTokenHash(tokenHash) {
    return mapInvitation(await one(
      'select * from identity.invitation where token_hash = $1', [tokenHash],
    ));
  }
  async function listPendingInvitations(projectId) {
    const { rows } = await pool.query(
      `select * from identity.invitation where project_id = $1 and status = 'pending'`,
      [projectId],
    );
    return rows.map(mapInvitation);
  }

  // ── Unit of work ────────────────────────────────────────────────────────────
  function transaction(fn) {
    return withTransaction(async (client) => {
      const tx = {
        async insertProject(p) {
          try {
            const { rows } = await client.query(
              `insert into identity.project (id, name, owner_party_id, baseline_budget_cents, created_at)
               values ($1, $2, $3, $4, $5) returning *`,
              [p.id, p.name, p.ownerPartyId, p.baselineBudgetCents, p.createdAt],
            );
            return mapProject(rows[0]);
          } catch (e) { throw asConflict(e); }
        },
        async insertMembership(m) {
          try {
            const { rows } = await client.query(
              `insert into identity.membership (id, project_id, party_id, role, joined_at)
               values ($1, $2, $3, $4, $5) returning *`,
              [m.id, m.projectId, m.partyId, m.role, m.joinedAt],
            );
            return mapMembership(rows[0]);
          } catch (e) { throw asConflict(e); }
        },
        async insertInvitation(i) {
          try {
            const { rows } = await client.query(
              `insert into identity.invitation
                 (id, project_id, token_hash, role, status, invited_by_party_id, created_at)
               values ($1, $2, $3, $4, $5, $6, $7) returning *`,
              [i.id, i.projectId, i.tokenHash, i.role, i.status, i.invitedByPartyId, i.createdAt],
            );
            return mapInvitation(rows[0]);
          } catch (e) { throw asConflict(e); }
        },
        // Re-read under the tx, locking the row so a concurrent accept can't
        // double-spend the token (belt-and-braces with the status guard below).
        async getInvitationByTokenHash(tokenHash) {
          const { rows } = await client.query(
            'select * from identity.invitation where token_hash = $1 for update', [tokenHash],
          );
          return mapInvitation(rows[0] ?? null);
        },
        // Conditional update: only a pending invite flips, so a replayed accept
        // touches zero rows and we raise the same 409 the memory store does.
        async markInvitationAccepted(id, acceptedAt) {
          const { rows } = await client.query(
            `update identity.invitation set status = 'accepted', accepted_at = $2
              where id = $1 and status = 'pending' returning *`,
            [id, acceptedAt],
          );
          if (rows.length === 0) throw conflict('invitation is not pending');
          return mapInvitation(rows[0]);
        },
        async appendEvent(event) {
          const e = await ledger.append(client, event);
          return { seq: e.seq, entryHash: e.entryHash };
        },
      };
      return fn(tx);
    }, pool);
  }

  return {
    getProject,
    getMembership,
    listMemberships,
    getInvitationByTokenHash,
    listPendingInvitations,
    transaction,
  };
}
