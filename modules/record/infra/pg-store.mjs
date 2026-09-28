// Postgres store for the record module (schema: record.audit_event).
//
// The record surface is READ-ONLY: the ledger is written by every producing
// module inside its own transaction (platform/ledger.mjs, invariant §6.4), so
// this store never calls record.append_event — it projects and verifies what is
// already there. Its only writes would be an export artefact (deferred).
//
// Two cross-schema READS carry the whole module:
//   • listEvents — the ledger for a project, each row tagged with a `visible`
//     flag computed by the V7 scope-visibility join (project ⇒ every
//     participant; contract ⇒ its parties; org_private ⇒ that org; rfp_private
//     ⇒ the RFP issuer + the bidder). Redaction itself is pure and lives in
//     domain/redaction.mjs; the join lives here, next to the data.
//   • verifyChain — recompute the entire hash chain IN SQL. It must be SQL:
//     record.append_event() hashes `payload::text` (jsonb canonical form) and
//     `occurred_at::text` (timestamptz), neither of which JS can reproduce
//     byte-for-byte, so the only faithful recomputation is the database's own.
//
// The four authz reads (person, project, participation, staffing) mirror the
// project store so listRecord can enforce the same project.participant ∧
// staffing conjunction without importing another module's store.

/** @param {import('pg').Pool} pool */
export function createRecordStore(pool) {
  return {
    // ── authz reads (mirror modules/project/infra/pg-store.mjs) ────────────
    async getPersonByClerkId(clerkUserId) {
      const { rows } = await pool.query(
        'SELECT * FROM identity.person WHERE clerk_user_id = $1', [clerkUserId]);
      return rows[0] ?? null;
    },

    async getProject(projectId) {
      const { rows } = await pool.query(
        'SELECT * FROM project.project WHERE id = $1', [projectId]);
      return rows[0] ?? null;
    },

    async isParticipant(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM project.participation
          WHERE project_id = $1 AND org_id = $2 AND status = 'active'`,
        [projectId, orgId]);
      return rows.length > 0;
    },

    async isStaffed(projectId, orgId, personId) {
      const { rows } = await pool.query(
        'SELECT 1 FROM identity.project_staffing WHERE project_id = $1 AND org_id = $2 AND person_id = $3',
        [projectId, orgId, personId]);
      return rows.length > 0;
    },

    // ── the ledger, projected ──────────────────────────────────────────────
    /**
     * A page of the project's ledger, newest first, each row carrying a
     * `visible` boolean for V7 redaction. `orgId` is the viewer's active org —
     * the scope-visibility join keys off it.
     *
     * @returns {Promise<{rows: object[], nextCursor: string|null}>}
     */
    async listEvents({ projectId, orgId, objectType = null, objectId = null, cursorSeq = null, limit = 50 }) {
      const params = [projectId, orgId];
      let where = 'ae.project_id = $1';
      if (objectType) { params.push(objectType); where += ` AND ae.object_type = $${params.length}`; }
      if (objectId) { params.push(objectId); where += ` AND ae.object_id = $${params.length}::uuid`; }
      if (cursorSeq != null) { params.push(cursorSeq); where += ` AND ae.seq < $${params.length}::bigint`; }
      params.push(limit + 1); // fetch one extra to know whether a next page exists

      const { rows } = await pool.query(
        `SELECT ae.seq, ae.occurred_at, ae.category, ae.type,
                ae.actor_person_id, ae.actor_org_id, ae.actor_org_role,
                ae.object_type, ae.object_id, ae.payload,
                encode(ae.entry_hash, 'hex') AS entry_hash,
                encode(ae.prev_hash,  'hex') AS prev_hash,
                CASE ae.scope_type
                  WHEN 'project'     THEN true
                  WHEN 'org_private' THEN ae.scope_id = $2
                  WHEN 'contract'    THEN EXISTS (
                     SELECT 1 FROM contracting.contract c
                      WHERE c.id = ae.scope_id
                        AND $2 IN (c.client_org_id, c.supplier_org_id, c.sponsored_by_org_id))
                  WHEN 'rfp_private' THEN (
                     EXISTS (SELECT 1 FROM tendering.proposal p
                               JOIN tendering.rfp r ON r.id = p.rfp_id
                              WHERE p.id = ae.scope_id AND $2 IN (p.bidder_org_id, r.issuer_org_id))
                     OR EXISTS (SELECT 1 FROM tendering.rfp r
                                 WHERE r.id = ae.scope_id AND r.issuer_org_id = $2))
                  ELSE false
                END AS visible
           FROM record.audit_event ae
          WHERE ${where}
          ORDER BY ae.seq DESC
          LIMIT $${params.length}`,
        params);

      let nextCursor = null;
      if (rows.length > limit) {
        rows.length = limit;
        nextCursor = String(rows[rows.length - 1].seq);
      }
      return { rows, nextCursor };
    },

    /**
     * Recompute the whole per-project hash chain in the database and compare
     * each entry to what is stored. An empty ledger is trivially valid.
     *
     * @returns {Promise<{valid: boolean, length: number, head: string|null,
     *                     first_invalid_seq: number|null}>}
     */
    async verifyChain(projectId) {
      const { rows } = await pool.query(
        `WITH RECURSIVE ev AS (
           SELECT seq, occurred_at, scope_type, scope_id, entry_hash,
                  sha256(convert_to(payload::text, 'UTF8')) AS ph,
                  row_number() OVER (ORDER BY seq) AS rn
             FROM record.audit_event
            WHERE project_id = $1
         ),
         chain AS (
           SELECT e.rn, e.seq, e.entry_hash AS stored,
                  sha256(e.ph || convert_to(
                    e.seq::text || '|' || e.occurred_at::text || '|'
                    || e.scope_type || ':' || e.scope_id::text, 'UTF8')) AS calc
             FROM ev e WHERE e.rn = 1
           UNION ALL
           SELECT e.rn, e.seq, e.entry_hash,
                  sha256(c.calc || e.ph || convert_to(
                    e.seq::text || '|' || e.occurred_at::text || '|'
                    || e.scope_type || ':' || e.scope_id::text, 'UTF8'))
             FROM ev e JOIN chain c ON e.rn = c.rn + 1
         )
         SELECT count(*)::int AS length,
                bool_and(calc = stored) AS valid,
                encode((SELECT calc FROM chain ORDER BY rn DESC LIMIT 1), 'hex') AS head,
                (SELECT min(seq) FROM chain WHERE calc <> stored) AS first_invalid_seq
           FROM chain`,
        [projectId]);

      const r = rows[0];
      const length = Number(r.length ?? 0);
      return {
        length,
        valid: length === 0 ? true : Boolean(r.valid),
        head: r.head ?? null,
        first_invalid_seq: r.first_invalid_seq == null ? null : Number(r.first_invalid_seq),
      };
    },
  };
}
