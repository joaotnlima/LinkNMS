// Directory store — the "On the record" read model (db/v2 0022): the event
// consumer's writes, the search candidates and a profile's builds.
//
// Reads and writes ONLY directory.* (no cross-schema joins): the facts come
// from events (application/consumers.mjs). Amounts never enter these tables.
const PROFILE_COLUMNS = `p.org_id, p.slug, p.display_name, p.kind, p.claimed, p.description, p.specialties, p.tags,
  p.service_areas, p.team_size_band, p.founded_year, p.declared_impic_number, p.declared_impic_class,
  p.declared_insurance, p.listed, p.base_municipality_code, p.base_lat, p.base_lng, p.service_radius_km,
  to_char(p.available_from, 'YYYY-MM-DD') AS available_from, p.created_at`;

// The on-record counts of one profile row `p`. A task counts only under a
// contract whose SUPPLIER is the task's assignee — i.e. work for a client
// verified by the platform (D-46). Withdrawn change orders were never raised.
const RECORD_FACTS = `
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT rc.client_org_id) AS verified_clients,
           count(DISTINCT rc.project_id)    AS builds
      FROM directory.record_contract rc WHERE rc.supplier_org_id = p.org_id
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS tasks_finished,
           count(*) FILTER (WHERE rt.actual_finish <= rt.baseline_finish) AS tasks_on_time
      FROM directory.record_task rt
      JOIN directory.record_contract rc
        ON rc.contract_id = rt.contract_id AND rc.supplier_org_id = rt.assignee_org_id
     WHERE rt.assignee_org_id = p.org_id
       AND rt.baseline_finish IS NOT NULL AND rt.actual_finish IS NOT NULL
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS change_orders_raised,
           count(*) FILTER (WHERE co.status = 'approved') AS change_orders_approved
      FROM directory.record_change_order co
      JOIN directory.record_contract rc ON rc.contract_id = co.contract_id
     WHERE rc.supplier_org_id = p.org_id AND co.status <> 'withdrawn'
  ) o ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS portfolio_count FROM directory.portfolio_entry pe
     WHERE pe.org_id = p.org_id AND (pe.source = 'declared' OR pe.owner_consent)
  ) pf ON true`;

const FACT_COLUMNS = `coalesce(c.verified_clients, 0) AS verified_clients, coalesce(c.builds, 0) AS builds,
  coalesce(t.tasks_finished, 0) AS tasks_finished, coalesce(t.tasks_on_time, 0) AS tasks_on_time,
  coalesce(o.change_orders_raised, 0) AS change_orders_raised,
  coalesce(o.change_orders_approved, 0) AS change_orders_approved,
  coalesce(pf.portfolio_count, 0) AS portfolio_count`;

export function createRecordStore(pool, tx) {
  return {
    /** One event's operations + its dedupe row, one transaction. */
    async applyRecordEvent({ eventId, type, ops }) {
      return tx(async (client) => {
        const { rowCount } = await client.query(
          `INSERT INTO directory.consumed_event (event_id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [eventId, type],
        );
        if (!rowCount) return { applied: false };
        for (const op of ops) await applyOp(client, op);
        return { applied: true };
      });
    },

    /** Candidate rows for a search (≤ limit), each with distance and facts. */
    async searchCandidates({ specialtyCodes, point, municipality, district, kind, canStartBy, text, limit }) {
      const like = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const { rows } = await pool.query(
        `SELECT ${PROFILE_COLUMNS}, d.km AS distance_km, ${FACT_COLUMNS}
           FROM directory.organization_profile p
           CROSS JOIN LATERAL (
             SELECT CASE WHEN $2::numeric IS NULL OR p.base_lat IS NULL THEN NULL
                         ELSE directory.distance_km($2::numeric, $3::numeric, p.base_lat, p.base_lng) END AS km
           ) d
           ${RECORD_FACTS}
          WHERE p.listed
            AND ($1::text[] IS NULL OR p.specialties && $1::text[])
            AND ($2::numeric IS NULL OR (d.km IS NOT NULL AND d.km <= $4::numeric
                 AND p.service_radius_km IS NOT NULL AND d.km <= p.service_radius_km))
            AND ($5::text IS NULL OR p.base_municipality_code = $5 OR $5 = ANY (p.service_areas)
                 OR left($5, 2) = ANY (p.service_areas))
            AND ($6::text IS NULL OR left(p.base_municipality_code, 2) = $6
                 OR EXISTS (SELECT 1 FROM unnest(p.service_areas) a WHERE left(a, 2) = $6))
            AND ($7::text IS NULL OR p.kind = $7)
            AND ($8::date IS NULL OR p.available_from IS NULL OR p.available_from <= $8::date)
            AND ($9::text IS NULL OR p.display_name ILIKE $9)
          ORDER BY d.km NULLS LAST, p.org_id
          LIMIT $10`,
        [specialtyCodes, point?.lat ?? null, point?.lng ?? null, point?.radiusKm ?? null,
          municipality, district, kind, canStartBy, like, limit],
      );
      return rows;
    },

    /**
     * Profiles by org id with their on-record facts and, given a point, the
     * distance to each base (the company port's proof lines, PRD-04).
     */
    async profilesByOrgIds(orgIds, near = null) {
      if (!orgIds.length) return [];
      const { rows } = await pool.query(
        `SELECT ${PROFILE_COLUMNS}, ${FACT_COLUMNS},
                CASE WHEN $2::numeric IS NULL OR p.base_lat IS NULL THEN NULL
                     ELSE directory.distance_km($2::numeric, $3::numeric, p.base_lat, p.base_lng) END AS distance_km
           FROM directory.organization_profile p
           ${RECORD_FACTS}
          WHERE p.org_id = ANY($1::uuid[])`,
        [orgIds, near?.lat ?? null, near?.lng ?? null],
      );
      return rows;
    },

    /** One public profile (by slug or org id) with its on-record facts. */
    async getPublicProfile({ slug = null, orgId = null }) {
      const { rows } = await pool.query(
        `SELECT ${PROFILE_COLUMNS}, ${FACT_COLUMNS}
           FROM directory.organization_profile p
           ${RECORD_FACTS}
          WHERE ($1::text IS NOT NULL AND p.slug = $1) OR ($2::uuid IS NOT NULL AND p.org_id = $2)`,
        [slug, orgId],
      );
      return rows[0] ?? null;
    },

    /**
     * The company's builds on the record, newest first: contract statuses,
     * dates, task counts — and the name only where the owner consented.
     */
    async buildsOnRecord(orgId) {
      const { rows } = await pool.query(
        `SELECT rc.project_id,
                array_agg(DISTINCT rc.status) AS statuses,
                to_char(min(rc.signed_at), 'YYYY-MM-DD') AS signed_on,
                to_char(max(rc.finished_at), 'YYYY-MM-DD') AS finished_on,
                coalesce(max(tk.finished), 0) AS tasks_finished,
                coalesce(max(tk.on_time), 0) AS tasks_on_time,
                max(pc.build_name) FILTER (WHERE pc.show_on_profiles) AS consent_name
           FROM directory.record_contract rc
           LEFT JOIN directory.portfolio_consent pc ON pc.project_id = rc.project_id
           LEFT JOIN LATERAL (
             SELECT count(*) AS finished,
                    count(*) FILTER (WHERE rt.actual_finish <= rt.baseline_finish) AS on_time
               FROM directory.record_task rt
               JOIN directory.record_contract c2
                 ON c2.contract_id = rt.contract_id AND c2.supplier_org_id = rt.assignee_org_id
              WHERE rt.assignee_org_id = $1 AND rt.project_id = rc.project_id
                AND rt.baseline_finish IS NOT NULL AND rt.actual_finish IS NOT NULL
           ) tk ON true
          WHERE rc.supplier_org_id = $1
          GROUP BY rc.project_id
          ORDER BY min(rc.signed_at) DESC, rc.project_id
          LIMIT 50`,
        [orgId],
      );
      return rows;
    },
  };
}

async function applyOp(client, op) {
  switch (op.op) {
    case 'contract_signed':
      await client.query(
        `INSERT INTO directory.record_contract
           (contract_id, project_id, kind, client_org_id, supplier_org_id, status, signed_at)
         VALUES ($1, $2, $3, $4, $5, 'signed', $6)
         ON CONFLICT (contract_id) DO NOTHING`,
        [op.contractId, op.projectId, op.kind, op.clientOrgId, op.supplierOrgId, op.at],
      );
      return;
    case 'contract_status':
      // A status change for a contract never signed (still a draft) has
      // nothing to update: only signed contracts are on the record.
      await client.query(
        `UPDATE directory.record_contract
            SET status = $2,
                finished_at = CASE WHEN $2 IN ('closed', 'terminated') THEN $3::timestamptz ELSE finished_at END
          WHERE contract_id = $1`,
        [op.contractId, op.status, op.at],
      );
      return;
    case 'change_order':
      if (op.status === 'withdrawn') {
        await client.query(
          `UPDATE directory.record_change_order SET status = 'withdrawn', updated_at = $2 WHERE change_order_id = $1`,
          [op.changeOrderId, op.at],
        );
        return;
      }
      await client.query(
        `INSERT INTO directory.record_change_order (change_order_id, contract_id, status, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (change_order_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
        [op.changeOrderId, op.contractId, op.status, op.at],
      );
      return;
    case 'task_finished':
      await client.query(
        `INSERT INTO directory.record_task
           (task_id, project_id, contract_id, assignee_org_id, baseline_finish, actual_finish, reported_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (task_id) DO UPDATE SET
           project_id = EXCLUDED.project_id, contract_id = EXCLUDED.contract_id,
           assignee_org_id = EXCLUDED.assignee_org_id, baseline_finish = EXCLUDED.baseline_finish,
           actual_finish = EXCLUDED.actual_finish, reported_at = EXCLUDED.reported_at`,
        [op.taskId, op.projectId, op.contractId, op.assigneeOrgId, op.baselineFinish, op.actualFinish, op.at],
      );
      return;
    case 'task_reopened':
      await client.query('DELETE FROM directory.record_task WHERE task_id = $1', [op.taskId]);
      return;
    case 'proposal_submitted':
      await client.query(
        `INSERT INTO directory.record_proposal (proposal_id, rfp_id, bidder_org_id, submitted_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (proposal_id) DO UPDATE SET
           bidder_org_id = coalesce(EXCLUDED.bidder_org_id, directory.record_proposal.bidder_org_id),
           submitted_at = EXCLUDED.submitted_at`,
        [op.proposalId, op.rfpId, op.bidderOrgId, op.at],
      );
      return;
    case 'proposal_awarded':
      await client.query(
        `INSERT INTO directory.record_proposal (proposal_id, rfp_id, awarded_at) VALUES ($1, $2, $3)
         ON CONFLICT (proposal_id) DO UPDATE SET awarded_at = EXCLUDED.awarded_at`,
        [op.proposalId, op.rfpId, op.at],
      );
      return;
    default:
      throw new Error(`unknown read-model op ${op.op}`);
  }
}
