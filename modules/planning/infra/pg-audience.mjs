// Postgres part of the planning store for the variation notification
// audience (PRD-12 N-1). Spread into createPlanningStore's object. Read-only.
//
// The organisations a variation concerns are the project owner and the CLIENT
// of the contract the row belongs to: the contract the variation is scoped to
// (cost/material) or the row's branch contract (time/scope). The supplier is
// the one changing its own plan, so it is not told about itself. Contract
// parties are read the same way the digest rows read them (recordVariationDigest).

/** @param {import('pg').Pool} pool */
export function audienceQueries(pool) {
  return {
    async variationAudienceRow(variationId) {
      const { rows } = await pool.query(
        `SELECT v.id, v.project_id, v.task_id, v.kind,
                pr.owner_org_id,
                (SELECT c.client_org_id FROM contracting.contract c
                  WHERE c.id = CASE WHEN v.scope_type = 'contract' THEN v.scope_id ELSE t.branch_contract_id END
                ) AS client_org_id
           FROM planning.variation v
           LEFT JOIN planning.task t ON t.id = v.task_id
           LEFT JOIN project.project pr ON pr.id = v.project_id
          WHERE v.id = $1`,
        [variationId],
      );
      return rows[0] ?? null;
    },
  };
}
