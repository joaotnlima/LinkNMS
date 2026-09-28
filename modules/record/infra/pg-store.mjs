// Record store — reads the shared hash-chained ledger (record.audit_event,
// db/v2/0001) as a project participant sees it (V7). This module never WRITES
// the ledger: platform/ledger.mjs is the sole writer and every domain module
// appends its own entry inside its own transaction (invariant §6.4). Here we
// only project it for reading, so the store takes a pool and owns no tx.
//
// Cross-schema reads are deliberate and mirror the documents module's V6
// resolvers: deciding whether an entry is in scope needs the contract parties
// (contracting) and the tendering ownership (issuer / bidder), which live in
// other schemas. The projection redacts out-of-scope payloads in SQL so a
// withheld payload never crosses the store boundary.

/**
 * @param {import('pg').Pool} pool
 */
export function createRecordStore(pool) {
  return {
    // ── relationship (project.participant) ────────────────────────────────
    async getProject(projectId) {
      const { rows } = await pool.query(
        'SELECT id, owner_org_id, created_by_org_id FROM project.project WHERE id = $1',
        [projectId],
      );
      return rows[0] ?? null;
    },

    async isParticipant(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM project.participation
          WHERE project_id = $1 AND org_id = $2 AND status = 'active'`,
        [projectId, orgId],
      );
      return rows.length > 0;
    },

    // staffing gate (doc 16 §4) — same query the project store uses.
    async isStaffed(projectId, orgId, personId) {
      const { rows } = await pool.query(
        'SELECT 1 FROM identity.project_staffing WHERE project_id = $1 AND org_id = $2 AND person_id = $3',
        [projectId, orgId, personId],
      );
      return rows.length > 0;
    },

    async getPersonByClerkId(clerkUserId) {
      const { rows } = await pool.query(
        'SELECT id FROM identity.person WHERE clerk_user_id = $1',
        [clerkUserId],
      );
      return rows[0] ?? null;
    },

    // ── the projection (V7) ───────────────────────────────────────────────
    /**
     * The ledger of one project as `orgId` is entitled to read it, newest
     * first. An entry is in scope — payload shown — when it is project-scoped,
     * or contract-scoped on a contract the org is a party to, or the org's own
     * org_private scope, or an rfp_private scope the org issued or bid on.
     * Everything else keeps its seq, type and hashes but its payload is nulled
     * and `redacted` is true, so the chain the client verifies stays complete.
     *
     * Cursor is the seq of the last row of the previous page; the next page is
     * the entries strictly below it.
     */
    async listAuditEntries(projectId, orgId, { objectType, objectId, cursor, limit }) {
      const visible = `(
        e.scope_type = 'project'
        OR (e.scope_type = 'contract' AND e.scope_id IN (
              SELECT id FROM contracting.contract
               WHERE client_org_id = $2 OR supplier_org_id = $2))
        OR (e.scope_type = 'org_private' AND e.scope_id = $2)
        OR (e.scope_type = 'rfp_private' AND (
              e.scope_id IN (SELECT id FROM tendering.proposal WHERE bidder_org_id = $2)
           OR e.scope_id IN (SELECT id FROM tendering.rfp WHERE issuer_org_id = $2)
           OR e.scope_id IN (
                SELECT p.id FROM tendering.proposal p
                  JOIN tendering.rfp r ON r.id = p.rfp_id
                 WHERE r.issuer_org_id = $2)))
      )`;
      const { rows } = await pool.query(
        `SELECT e.seq, e.occurred_at, e.category, e.type,
                e.actor_person_id, e.actor_org_id, e.actor_org_role,
                e.object_type, e.object_id,
                encode(e.entry_hash, 'hex') AS entry_hash,
                encode(e.prev_hash, 'hex')  AS prev_hash,
                CASE WHEN ${visible} THEN e.payload ELSE NULL END AS payload,
                NOT ${visible} AS redacted
           FROM record.audit_event e
          WHERE e.project_id = $1
            AND ($3::text IS NULL OR e.object_type = $3)
            AND ($4::uuid IS NULL OR e.object_id = $4)
            AND ($5::bigint IS NULL OR e.seq < $5)
          ORDER BY e.seq DESC
          LIMIT $6`,
        [projectId, orgId, objectType, objectId, cursor, limit + 1],
      );
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? String(items[items.length - 1].seq) : null;
      return { items, nextCursor };
    },
  };
}
