// Postgres part of the planning store for the variation notification
// audience (PRD-12 N-1). Spread into createPlanningStore's object. Read-only.
//
// Planning's own facts only: the variation and the row's branch contract id.
// Who the contract's client is and who owns the build come from the plan
// snapshot (application/audience.mjs) — no read of contracting.* or project.*
// here.

/** @param {import('pg').Pool} pool */
export function audienceQueries(pool) {
  return {
    async variationAudienceRow(variationId) {
      const { rows } = await pool.query(
        `SELECT v.id, v.project_id, v.task_id, v.kind, v.scope_type, v.scope_id,
                t.branch_contract_id
           FROM planning.variation v
           LEFT JOIN planning.task t ON t.id = v.task_id
          WHERE v.id = $1`,
        [variationId],
      );
      return rows[0] ?? null;
    },
  };
}
