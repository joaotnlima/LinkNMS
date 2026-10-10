// Postgres part of the tendering store for the notification audience port
// (PRD-12 N-1). Spread into createTenderingStore's object like
// pg-clarifications.mjs. Read-only: who issued an RFP, which rows it covers
// and which bidder ORGANISATIONS hold a lane — never a price, never an email
// (token-only recipients are tendering's own mail concern, PRD-08 H-8).

/** @param {import('pg').Pool} pool */
export function audienceQueries(pool) {
  return {
    async rfpAudienceRows(rfpId) {
      const { rows: rfps } = await pool.query(
        `SELECT r.id, r.project_id, r.issuer_org_id, r.title, r.status, r.awarded_proposal_id,
                coalesce(array_agg(rr.task_id ORDER BY rr.task_id) FILTER (WHERE rr.task_id IS NOT NULL), '{}') AS root_task_ids
           FROM tendering.rfp r
           LEFT JOIN tendering.rfp_root rr ON rr.rfp_id = r.id
          WHERE r.id = $1
          GROUP BY r.id`,
        [rfpId],
      );
      if (!rfps.length) return null;
      const { rows: bidders } = await pool.query(
        `SELECT rc.org_id, rc.status AS recipient_status, p.id AS proposal_id, p.status AS proposal_status
           FROM tendering.rfp_recipient rc
           LEFT JOIN tendering.proposal p ON p.recipient_id = rc.id
          WHERE rc.rfp_id = $1 AND rc.org_id IS NOT NULL AND rc.revoked_at IS NULL
          ORDER BY rc.org_id`,
        [rfpId],
      );
      return { rfp: rfps[0], bidders };
    },
  };
}
