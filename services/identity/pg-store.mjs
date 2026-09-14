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

const mapParty = (r) => r && {
  id: r.id,
  displayName: r.display_name,
  email: r.email ?? null,
  role: r.role,
  // 0011: null until the party has been through first-login setup. `?? null`
  // rather than a default so "never asked" stays distinguishable from a choice.
  language: r.language ?? null,
  setupComplete: r.setup_complete === true,
};

const mapProject = (r) => r && {
  id: r.id,
  name: r.name,
  ownerPartyId: r.owner_party_id,
  baselineBudgetCents: Number(r.baseline_budget_cents),
  operatingModel: r.operating_model ?? null,
  status: r.status,
  // Basics descriptive fields (LINA-219, migration 0014); null on legacy rows.
  siteAddress: r.site_address ?? null,
  buildType: r.build_type ?? null,
  expectedStart: r.expected_start ?? null,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
};
const mapMembership = (r) => r && {
  id: r.id,
  projectId: r.project_id,
  partyId: r.party_id,
  role: r.role,
  joinedAt: r.joined_at instanceof Date ? r.joined_at.toISOString() : r.joined_at,
  // Present only where the query joins identity.party (listMemberships). The UI
  // must render "who decided this" as a NAME, and party ids never leave this
  // schema — decision and change_order live in their own schemas and cannot join
  // to it. Every decision author and change-order proposer is by construction a
  // project member, so the membership list is the one place that lookup can and
  // should exist. Spread conditionally so the field is simply absent (rather
  // than an misleading explicit null) on the queries that do not join.
  ...(r.display_name === undefined ? {} : { displayName: r.display_name }),
};
const mapInvitation = (r) => r && {
  id: r.id,
  projectId: r.project_id,
  tokenHash: r.token_hash,
  email: r.email ?? null, // LINA-84: null on the out-of-band (token-only) path
  inviteeName: r.invitee_name ?? null, // LINA-222: the Name/company field, or null
  scopeNote: r.scope_note ?? null, // LINA-222: the Scope note, or null
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
  // GET /me backbone — resolve a party UUID to its identity.party row
  // (display_name, email, role). The party is the acting session's own, so this
  // read is scoped to the authenticated caller; there is no list endpoint.
  async function getParty(id) {
    return mapParty(await one('select * from identity.party where id = $1', [id]));
  }
  // Constructor selection (LINA-280, ADR-0023 §3): resolve the awarded RFP
  // recipient's identity.party row by email. NULL when the contractor has not
  // yet created an account — selection fails with contractor_not_seated instead
  // of materialising a zombie party (Q3, still open with the founder).
  async function getPartyByEmail(email) {
    return mapParty(await one('select * from identity.party where lower(email) = lower($1)', [email]));
  }
  // First-login account setup (POST /me/profile, LINA-189). A single
  // conditional UPDATE, and that is the whole concurrency story:
  //
  //   * `where setup_complete = false` makes it idempotent AND race-safe. Two
  //     concurrent first-login submits both target one row; Postgres serialises
  //     them, the first flips the flag, the second matches zero rows and gets
  //     'already_setup'. No read-then-write window, no advisory lock.
  //   * All three fields move together in one statement, so there is no state
  //     where the record says "Owner" but still shows the email-local-part name
  //     the Clerk bridge invented. The contract's atomicity requirement is the
  //     statement itself, not a transaction wrapped around several writes.
  //
  // No ledger append. The ledger is the PROJECT record's hash chain — every
  // event on it is scoped to a build — and account setup happens before the
  // party has a build. Writing a chain entry with no project would either
  // require a nullable project_id (weakening the thing the chain exists to
  // guarantee) or a synthetic one (a lie in an audit log). What this write
  // affects downstream — the display name on every future decision — is
  // captured at the moment it is used, by the events that carry it.
  async function completeProfile({ partyId, displayName, role, language }) {
    const { rows } = await pool.query(
      `update identity.party
          set display_name = $2, role = $3, language = $4,
              setup_complete = true, updated_at = now()
        where id = $1 and setup_complete = false
        returning *`,
      [partyId, displayName, role, language],
    );
    if (rows.length > 0) return { status: 'ok', party: mapParty(rows[0]) };
    // Zero rows is two different facts. Distinguish them, because one is a
    // success the client continues past (409) and the other is a dead session.
    const existing = await getParty(partyId);
    return existing ? { status: 'already_setup' } : { status: 'not_found' };
  }

  async function getMembership(projectId, partyId) {
    return mapMembership(await one(
      'select * from identity.membership where project_id = $1 and party_id = $2',
      [projectId, partyId],
    ));
  }
  async function listMemberships(projectId) {
    const { rows } = await pool.query(
      `select m.*, p.display_name
         from identity.membership m
         left join identity.party p on p.id = m.party_id
        where m.project_id = $1
        order by (m.role <> 'owner'), m.joined_at, m.id`,
      [projectId],
    );
    return rows.map(mapMembership);
  }
  // The portfolio read (GET /projects, ADR-0012 §A1). Membership-scoped: only the
  // projects the acting party belongs to — owner or counterparty, draft or active
  // — never all org projects. TWO queries, never N+1: one for the party's
  // projects (membership → project), one for every member row across those
  // projects (joined to identity.party for display names). The caller shapes it
  // into cards and reads budgets from the Ledger port in the same batch.
  async function listProjectsForParty(partyId) {
    const projectRows = await pool.query(
      `select p.*
         from identity.membership m
         join identity.project p on p.id = m.project_id
        where m.party_id = $1
        order by p.created_at desc, p.id`,
      [partyId],
    );
    const projects = projectRows.rows.map(mapProject);
    if (projects.length === 0) return [];

    const memberRows = await pool.query(
      `select m.*, p.display_name
         from identity.membership m
         left join identity.party p on p.id = m.party_id
        where m.project_id = any($1)
        order by (m.role <> 'owner'), m.joined_at, m.id`,
      [projects.map((p) => p.id)],
    );
    const byProject = new Map();
    for (const m of memberRows.rows.map(mapMembership)) {
      const list = byProject.get(m.projectId) ?? [];
      list.push(m);
      byProject.set(m.projectId, list);
    }
    return projects.map((p) => ({ ...p, members: byProject.get(p.id) ?? [] }));
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
              `insert into identity.project
                 (id, name, owner_party_id, baseline_budget_cents, operating_model, status,
                  site_address, build_type, expected_start, created_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
              [
                p.id, p.name, p.ownerPartyId, p.baselineBudgetCents, p.operatingModel ?? null, p.status,
                p.siteAddress ?? null, p.buildType ?? null, p.expectedStart ?? null, p.createdAt,
              ],
            );
            return mapProject(rows[0]);
          } catch (e) { throw asConflict(e); }
        },
        // Band B wizard projection writes (ADR-0011). These run through the
        // column-scoped GRANT UPDATE (operating_model, status) issued in 0009 —
        // identity_app can drive the wizard but can never rewrite
        // baseline_budget_cents or owner_party_id (0009 header, ADR-0002 intent).
        async updateProjectOperatingModel(projectId, operatingModel) {
          const { rows } = await client.query(
            `update identity.project set operating_model = $2
              where id = $1 returning *`,
            [projectId, operatingModel],
          );
          return mapProject(rows[0] ?? null);
        },
        async updateProjectStatus(projectId, status) {
          const { rows } = await client.query(
            `update identity.project set status = $2
              where id = $1 returning *`,
            [projectId, status],
          );
          return mapProject(rows[0] ?? null);
        },
        // ADR-0016 §4: stamp the homeowner onto a GC-founded build, ONCE. The
        // column-scoped GRANT UPDATE (owner_party_id) from 0015 is the least-
        // privilege leg; the `WHERE owner_party_id IS NULL` guard is the one-way
        // leg — an existing owner is immutable at the SQL layer (never re-pointed),
        // so a lost race stamps zero rows and surfaces as a conflict, not a silent
        // overwrite of a real owner.
        async stampOwnerParty(projectId, partyId) {
          const { rows } = await client.query(
            `update identity.project set owner_party_id = $2
              where id = $1 and owner_party_id is null returning *`,
            [projectId, partyId],
          );
          if (rows.length === 0) throw conflict('project already has an owner');
          return mapProject(rows[0]);
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
                 (id, project_id, token_hash, email, invitee_name, scope_note, role, status, invited_by_party_id, created_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
              [i.id, i.projectId, i.tokenHash, i.email ?? null, i.inviteeName ?? null,
                i.scopeNote ?? null, i.role, i.status, i.invitedByPartyId, i.createdAt],
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
    listProjectsForParty,
    getInvitationByTokenHash,
    listPendingInvitations,
    getParty,
   getPartyByEmail,
    completeProfile,
    transaction,
  };
}
