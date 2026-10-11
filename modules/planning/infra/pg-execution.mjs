// Postgres part of the planning store for running the plan (PRD-10): the
// baselines the plan header lists and compares against (E-1), the location
// names of the site calendar (E-10) and the daily log (E-7..E-9). Spread into
// createPlanningStore's object.
//
// The daily log write ledgers and publishes `planning.daily_log.recorded` on
// the SAME client as the entries (invariant §6.4). Cross-schema READS:
// project.location (names, and "is it a location of this build") — the same
// read-port discipline the plan snapshot uses for project.*.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';

const D = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const ENTRY_SELECT = `
  SELECT id, project_id, ${D('log_date')} AS log_date, kind, org_id, headcount, weather, temperature_c,
         task_id, location_id, document_id, version_no, percent, note,
         recorded_by_person_id, recorded_by_org_id, recorded_at
    FROM planning.daily_log_entry`;

/** @param {import('pg').Pool} pool @param {(fn: Function) => Promise<any>} tx */
export function executionQueries(pool, tx) {
  return {
    // ── baselines (E-1) ────────────────────────────────────────────────────
    async listBaselines(projectId) {
      // A change-order baseline records no roots of its own: it labels the
      // same branch, so its roots are those of the latest earlier version.
      const { rows } = await pool.query(
        `SELECT b.id, b.contract_id, b.version, b.reason, b.change_order_id,
                b.taken_by_person_id, b.taken_by_org_id,
                to_char(b.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS taken_at_iso,
                coalesce((SELECT array_agg(r.task_id ORDER BY t.position)
                            FROM planning.baseline_root r
                            LEFT JOIN planning.task t ON t.id = r.task_id
                           WHERE r.baseline_id = src.root_baseline_id), '{}') AS root_task_ids,
                coalesce((SELECT array_agg(t.name ORDER BY t.position)
                            FROM planning.baseline_root r
                            JOIN planning.task t ON t.id = r.task_id
                           WHERE r.baseline_id = src.root_baseline_id), '{}') AS root_names,
                (SELECT count(*)::int FROM planning.baseline_task bt WHERE bt.baseline_id = b.id) AS row_count
           FROM planning.baseline b
           LEFT JOIN LATERAL (
             SELECT b0.id AS root_baseline_id
               FROM planning.baseline b0
              WHERE b0.contract_id = b.contract_id AND b0.version <= b.version
                AND EXISTS (SELECT 1 FROM planning.baseline_root r0 WHERE r0.baseline_id = b0.id)
              ORDER BY b0.version DESC LIMIT 1
           ) src ON true
          WHERE b.project_id = $1
          ORDER BY b.taken_at DESC, b.version DESC`,
        [projectId],
      );
      return rows;
    },

    /** One baseline with its dated snapshot rows; null when not of this project. */
    async getBaselineSnapshot(projectId, baselineId) {
      const { rows } = await pool.query(
        `SELECT id, contract_id, version, reason,
                to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS taken_at_iso
           FROM planning.baseline WHERE id = $1 AND project_id = $2`,
        [baselineId, projectId],
      );
      if (!rows[0]) return null;
      const { rows: snap } = await pool.query(
        `SELECT task_id, ${D('start')} AS start, ${D('finish')} AS finish
           FROM planning.baseline_task WHERE baseline_id = $1`,
        [baselineId],
      );
      return { ...rows[0], rows: snap };
    },

    // ── locations of the build (project.location, read port) ──────────────
    async locationNames(projectId) {
      const { rows } = await pool.query(
        'SELECT id, name FROM project.location WHERE project_id = $1', [projectId],
      );
      return new Map(rows.map((r) => [r.id, r.name]));
    },

    // ── daily log (E-7..E-9) ──────────────────────────────────────────────
    async getDailyLogEntries(ids) {
      if (!ids.length) return [];
      const { rows } = await pool.query(`${ENTRY_SELECT} WHERE id = ANY($1::uuid[])`, [ids]);
      return rows;
    },

    async listDailyLogDay(projectId, date) {
      const { rows } = await pool.query(
        `${ENTRY_SELECT} WHERE project_id = $1 AND log_date = $2::date ORDER BY recorded_at, id`,
        [projectId, date],
      );
      return rows;
    },

    async listDailyLogWindow(projectId, from, to) {
      const { rows } = await pool.query(
        `${ENTRY_SELECT} WHERE project_id = $1 AND log_date BETWEEN $2::date AND $3::date
          ORDER BY log_date, recorded_at, id`,
        [projectId, from, to],
      );
      return rows;
    },

    async listTaskDailyLog(taskId, limit = 200) {
      const { rows } = await pool.query(
        `${ENTRY_SELECT} WHERE task_id = $1 ORDER BY log_date DESC, recorded_at DESC LIMIT $2`,
        [taskId, limit],
      );
      return rows;
    },

    /**
     * Insert one capture, ledger it and publish planning.daily_log.recorded —
     * one transaction. Entries whose id already exists are skipped (the use
     * case decided they are identical replays). Returns the inserted ids.
     */
    async insertDailyLogEntries({ projectId, date, entries, actor }) {
      return tx(async (client) => {
        const inserted = [];
        for (const e of entries) {
          const { rowCount } = await client.query(
            `INSERT INTO planning.daily_log_entry
               (id, project_id, log_date, kind, org_id, headcount, weather, temperature_c, task_id, location_id,
                document_id, version_no, percent, note, recorded_by_person_id, recorded_by_org_id)
             VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (id) DO NOTHING`,
            [e.id, projectId, date, e.kind, e.orgId, e.headcount, e.weather, e.temperatureC, e.taskId,
              e.locationId, e.documentId, e.versionNo ?? null, e.percent, e.note, actor.personId, actor.orgId],
          );
          if (rowCount) inserted.push(e);
        }
        if (!inserted.length) return [];
        const kinds = {};
        for (const e of inserted) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
        const taskIds = [...new Set(inserted.map((e) => e.taskId).filter(Boolean))];
        const data = { date, entry_ids: inserted.map((e) => e.id), kinds, task_ids: taskIds };
        const photos = inserted.filter((e) => e.kind === 'photo')
          .map((e) => ({ document_id: e.documentId, version_no: e.versionNo }));
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'planning',
          type: 'planning.daily_log.recorded',
          scope: { type: 'project', id: projectId },
          object: { type: 'daily_log_entry', id: inserted[0].id },
          payload: { ...data, ...(photos.length ? { photos } : {}) },
          channel: actor.channel ?? 'ui',
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'planning.daily_log.recorded',
          project_id: projectId,
          actor: { person_id: actor.personId ?? null, org_id: actor.orgId ?? null },
          scope: { type: 'project', id: projectId },
          data,
        });
        return inserted.map((e) => e.id);
      });
    },
  };
}
