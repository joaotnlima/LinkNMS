// Postgres part of the tendering store for clarifications and the tendering
// home (PRD-08). Spread into createTenderingStore's object, so callers still
// see ONE store; split out only to keep pg-store.mjs from growing further.
//
// Same rules as pg-store: every write appends its ledger entry and, where
// doc 10 lists an event, publishes it on the SAME client before commit
// (invariants §6.3/§6.4). The asker of a question is stored, never projected.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';

/**
 * @param {import('pg').Pool} pool
 * @param {(fn: (client: object) => Promise<any>) => Promise<any>} tx
 */
export function clarificationQueries(pool, tx) {
  return {
    async clarificationsOf(rfpId) {
      const { rows } = await pool.query(
        'SELECT * FROM tendering.clarification WHERE rfp_id = $1 ORDER BY asked_at, id',
        [rfpId],
      );
      return rows;
    },

    async getClarification(clarificationId) {
      const { rows } = await pool.query('SELECT * FROM tendering.clarification WHERE id = $1', [clarificationId]);
      return rows[0] ?? null;
    },

    /**
     * Record a question. `askedByOrgId` (authed ask, or a link whose recipient
     * row carries an org) and/or `askedByRecipientId` (a personal-link ask):
     * at least one, the DB checks it.
     */
    async askClarification({ id, rfpId, projectId, askedByOrgId = null, askedByRecipientId = null, question, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO tendering.clarification (id, rfp_id, asked_by_org_id, asked_by_recipient_id, question)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [id, rfpId, askedByOrgId, askedByRecipientId, question],
        );
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.clarification.asked',
          // rfp_private: the ASKER must stay invisible to other bidders (V8);
          // the ledger keeps who asked, the wire never shows it.
          scope: { type: 'rfp_private', id: rfpId },
          object: { type: 'clarification', id },
          payload: { rfp_id: rfpId, question },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    async answerClarification({ clarificationId, rfpId, projectId, answer, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.clarification
              SET answer = $2, answered_at = now(), status = 'answered'
            WHERE id = $1 AND status = 'open' RETURNING *`,
          [clarificationId, answer],
        );
        if (!rows.length) return null;
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.clarification.answered',
          scope: { type: 'project', id: projectId },
          object: { type: 'clarification', id: clarificationId },
          payload: { rfp_id: rfpId, answer },
          channel: actor.channel,
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'tendering.clarification.answered',
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'project', id: projectId },
          data: { rfp_id: rfpId, clarification_id: clarificationId },
        });
        return rows[0];
      });
    },

    /**
     * The bidders of an RFP with no platform org — the ones only email can
     * reach (PRD-08 H-8). A revoked link, a bounced address and a bidder who
     * declined are dropped. A `queued` one stays: on a published RFP its link
     * was minted at publish and only the invite mail failed — the notice is
     * harmless and may be what reaches them.
     */
    async tokenOnlyRecipients(rfpId) {
      const { rows } = await pool.query(
        `SELECT id, email FROM tendering.rfp_recipient
          WHERE rfp_id = $1 AND org_id IS NULL AND revoked_at IS NULL
            AND status NOT IN ('bounced', 'declined')
          ORDER BY id`,
        [rfpId],
      );
      return rows;
    },

    /**
     * The tendering home (listProjectRfps, PRD-08 H-1) in ONE statement: every
     * RFP of the project the org issued (drafts too), plus every non-draft one
     * it was invited to or holds a lane on — with the package roots named from
     * the snapshot, the package row count, the lane-status histogram, the open
     * questions, the winner, and the org's own lane. The domain decides which
     * of these a bidder may read (V8); the SQL only decides which RFPs.
     */
    async projectRfps(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT r.*,
                coalesce((SELECT array_agg(x.task_id ORDER BY x.task_id) FROM tendering.rfp_root x
                           WHERE x.rfp_id = r.id), '{}') AS root_task_ids,
                coalesce((SELECT jsonb_agg(jsonb_build_object('task_id', pr.task_id, 'name', pr.name)
                                           ORDER BY pr.position)
                            FROM tendering.rfp_package_row pr
                            JOIN tendering.rfp_root rt ON rt.rfp_id = r.id AND rt.task_id = pr.task_id
                           WHERE pr.rfp_id = r.id AND pr.package_version = r.package_version), '[]'::jsonb) AS covers,
                (SELECT count(*)::int FROM tendering.rfp_package_row pr
                  WHERE pr.rfp_id = r.id AND pr.package_version = r.package_version) AS covered_task_count,
                coalesce((SELECT jsonb_object_agg(s.status, s.n)
                            FROM (SELECT p.status, count(*)::int AS n FROM tendering.proposal p
                                   WHERE p.rfp_id = r.id GROUP BY p.status) s), '{}'::jsonb) AS lane_counts,
                (SELECT count(*)::int FROM tendering.clarification c
                  WHERE c.rfp_id = r.id AND c.status = 'open') AS open_question_count,
                ap.bidder_org_id AS awarded_org_id,
                coalesce(arec.company_name, arec.email) AS awarded_recipient_name,
                mine.id AS my_proposal_id,
                mine.status AS my_proposal_status
           FROM tendering.rfp r
           LEFT JOIN tendering.proposal ap ON ap.id = r.awarded_proposal_id
           LEFT JOIN tendering.rfp_recipient arec ON arec.id = ap.recipient_id
           LEFT JOIN LATERAL (SELECT p.id, p.status FROM tendering.proposal p
                               WHERE p.rfp_id = r.id AND p.bidder_org_id = $2
                               ORDER BY p.id LIMIT 1) mine ON true
          WHERE r.project_id = $1
            AND (r.issuer_org_id = $2
              OR (r.status <> 'draft'
                  AND (EXISTS (SELECT 1 FROM tendering.rfp_recipient rec
                                WHERE rec.rfp_id = r.id AND rec.org_id = $2)
                    OR mine.id IS NOT NULL)))
          ORDER BY r.created_at DESC, r.id DESC`,
        [projectId, orgId],
      );
      return rows;
    },
  };
}
