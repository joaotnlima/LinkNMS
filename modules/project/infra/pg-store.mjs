// Postgres store for the project module (schema: project.*, db/v2/0001+0003).
//
// Owns its transactions. Every project-scoped write appends its ledger entry
// on the SAME client before commit — invariant §6.4. Cross-schema READS
// (identity.person for the actor, contracting.contract for guards and the
// D-35 derivation, planning.task for the location-in-use guard) are the
// module's query ports; it never WRITES outside project.* + the ledger.
import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { withIdempotency } from '../../../platform/idempotency.mjs';

export function createProjectStore(pool) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    // ── reads ────────────────────────────────────────────────────────────
    async getPersonByClerkId(clerkUserId) {
      const { rows } = await pool.query('SELECT * FROM identity.person WHERE clerk_user_id = $1', [clerkUserId]);
      return rows[0] ?? null;
    },

    async getProject(projectId) {
      const { rows } = await pool.query('SELECT * FROM project.project WHERE id = $1', [projectId]);
      return rows[0] ?? null;
    },

    async isParticipant(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM project.participation WHERE project_id = $1 AND org_id = $2 AND status = 'active'`,
        [projectId, orgId],
      );
      return rows.length > 0;
    },

    async isStaffed(projectId, orgId, personId) {
      const { rows } = await pool.query(
        'SELECT 1 FROM identity.project_staffing WHERE project_id = $1 AND org_id = $2 AND person_id = $3',
        [projectId, orgId, personId],
      );
      return rows.length > 0;
    },

    async isPrimeSupplier(projectId, orgId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM contracting.contract
          WHERE project_id = $1 AND supplier_org_id = $2 AND kind = 'prime'
            AND status IN ('signed','active','provisionally_received')
          LIMIT 1`,
        [projectId, orgId],
      );
      return rows.length > 0;
    },

    async hasSignedContracts(projectId) {
      const { rows } = await pool.query(
        `SELECT 1 FROM contracting.contract
          WHERE project_id = $1 AND status <> 'draft' LIMIT 1`,
        [projectId],
      );
      return rows.length > 0;
    },

    async countOpenOwnerContracts(projectId) {
      // Owner-level = prime/direct/service where the client is the owner org.
      const { rows } = await pool.query(
        `SELECT count(*) AS n
           FROM contracting.contract c
           JOIN project.project p ON p.id = c.project_id
          WHERE c.project_id = $1 AND c.client_org_id = p.owner_org_id
            AND c.status NOT IN ('draft','closed','terminated')`,
        [projectId],
      );
      return Number(rows[0].n);
    },

    /** D-35: derived from signed owner-level contracts. */
    async getOperatingModel(projectId) {
      const { rows } = await pool.query(
        `SELECT
           count(*) FILTER (WHERE kind = 'prime')  AS prime,
           count(*) FILTER (WHERE kind = 'direct') AS direct
         FROM contracting.contract
         WHERE project_id = $1 AND status IN ('signed','active','provisionally_received','closed')`,
        [projectId],
      );
      const { prime, direct } = rows[0];
      if (Number(prime) > 0 && Number(direct) > 0) return 'hybrid';
      if (Number(prime) > 0) return 'turnkey';
      if (Number(direct) > 0) return 'direct';
      return 'undetermined';
    },

    async listProjectsForOrg({ orgId, personId, status, capacity, cursor, limit }) {
      // Portfolio = projects the org owns, created, or participates in;
      // personId non-null applies the staffing gate (doc 16 §4).
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (p.id) p.*,
                COALESCE(pa.capacity, CASE WHEN p.owner_org_id = $1 THEN 'owner' END) AS my_capacity
           FROM project.project p
           LEFT JOIN project.participation pa
             ON pa.project_id = p.id AND pa.org_id = $1 AND pa.status = 'active'
          WHERE (pa.org_id IS NOT NULL OR p.owner_org_id = $1 OR p.created_by_org_id = $1)
            AND ($2::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM identity.project_staffing s
                   WHERE s.project_id = p.id AND s.org_id = $1 AND s.person_id = $2))
            AND ($3::text IS NULL OR p.status = $3)
            AND ($4::text IS NULL OR pa.capacity = $4)
            AND ($5::uuid IS NULL OR p.id > $5::uuid)
          ORDER BY p.id
          LIMIT $6`,
        [orgId, personId, status, capacity, cursor, limit + 1],
      );
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
    },

    async getLocation(locationId) {
      const { rows } = await pool.query('SELECT * FROM project.location WHERE id = $1', [locationId]);
      return rows[0] ?? null;
    },

    async listLocations(projectId, { cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT * FROM project.location
          WHERE project_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
          ORDER BY id LIMIT $3`,
        [projectId, cursor, limit + 1],
      );
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
    },

    async locationInUse(locationId) {
      const { rows } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM project.location WHERE parent_id = $1)
             OR EXISTS (SELECT 1 FROM planning.task WHERE location_id = $1) AS used`,
        [locationId],
      );
      return rows[0].used;
    },

    async listParticipants(projectId, { cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT pa.project_id, pa.org_id, pa.capacity, pa.source, pa.contract_id,
                pa.invite_capacity, o.kind AS org_kind, o.legal_name, o.nif
           FROM project.participation pa
           JOIN identity.organization o ON o.id = pa.org_id
          WHERE pa.project_id = $1 AND pa.status = 'active'
            AND ($2::uuid IS NULL OR pa.org_id > $2::uuid)
          ORDER BY pa.org_id, pa.capacity
          LIMIT $3`,
        [projectId, cursor, limit + 1],
      );
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].org_id : null };
    },

    async getInvitationByTokenHash(tokenHash) {
      const { rows } = await pool.query('SELECT * FROM project.project_invitation WHERE token_hash = $1', [tokenHash]);
      return rows[0] ?? null;
    },

    async getCalendar(projectId) {
      const { rows } = await pool.query('SELECT * FROM project.calendar WHERE project_id = $1', [projectId]);
      if (!rows.length) return null;
      return { work_days: rows[0].work_days, closures: closuresOf(rows[0].closures) };
    },

    async listHolidays(municipalityCode) {
      const { rows } = await pool.query(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, name
           FROM platform.holiday
          WHERE scope = 'national' OR scope = $1
          ORDER BY date`,
        [municipalityCode],
      );
      return rows;
    },

    // ── writes (all ledgered on the same client — §6.4) ──────────────────
    async createProject({ id, name, address, municipalityCode, typology, grossAreaM2,
      indicativeBudgetCents, ownerOrgId, pendingOwnerEmail, createdByOrgId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO project.project
             (id, owner_org_id, created_by_org_id, name, address, municipality_code,
              typology, gross_area_m2, indicative_budget_cents, pending_owner_email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [id, ownerOrgId, createdByOrgId, name, address, municipalityCode,
            typology, grossAreaM2, indicativeBudgetCents, pendingOwnerEmail],
        );
        if (ownerOrgId) {
          await client.query(
            `INSERT INTO project.participation (project_id, org_id, capacity, source)
             VALUES ($1, $2, 'owner', 'project')`,
            [id, ownerOrgId],
          );
        }
        await appendAuditEvent(client, {
          projectId: id,
          actor,
          category: 'project',
          type: 'project.created',
          scope: { type: 'project', id },
          object: { type: 'project', id },
          payload: {
            name, municipality_code: municipalityCode,
            owner_org_id: ownerOrgId, created_by_org_id: createdByOrgId,
            on_behalf: Boolean(pendingOwnerEmail),
          },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    async updateProjectBrief({ projectId, expectedVersion, patch, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE project.project SET
             name = COALESCE($3, name),
             address = CASE WHEN $4::boolean THEN $5 ELSE address END,
             municipality_code = COALESCE($6, municipality_code),
             typology = CASE WHEN $7::boolean THEN $8 ELSE typology END,
             gross_area_m2 = CASE WHEN $9::boolean THEN $10::numeric ELSE gross_area_m2 END,
             indicative_budget_cents = CASE WHEN $11::boolean THEN $12::bigint ELSE indicative_budget_cents END,
             version = version + 1
           WHERE id = $1 AND version = $2
           RETURNING *`,
          [projectId, expectedVersion,
            patch.name ?? null,
            patch.address !== undefined, patch.address ?? null,
            patch.municipalityCode ?? null,
            patch.typology !== undefined, patch.typology ?? null,
            patch.grossAreaM2 !== undefined, patch.grossAreaM2 ?? null,
            patch.indicativeBudgetCents !== undefined, patch.indicativeBudgetCents ?? null],
        );
        if (!rows.length) return null; // version raced — the caller answers 409
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.brief.updated',
          scope: { type: 'project', id: projectId },
          object: { type: 'project', id: projectId },
          payload: { version: rows[0].version, changed: Object.keys(patch).filter((k) => patch[k] !== undefined) },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    async claimProject({ projectId, ownerOrgId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE project.project
              SET owner_org_id = $2, pending_owner_email = NULL, version = version + 1
            WHERE id = $1 AND owner_org_id IS NULL
            RETURNING *`,
          [projectId, ownerOrgId],
        );
        if (!rows.length) throw new Error('claim raced: project already owned');
        await client.query(
          `INSERT INTO project.participation (project_id, org_id, capacity, source)
           VALUES ($1, $2, 'owner', 'project')
           ON CONFLICT (project_id, org_id, capacity) DO NOTHING`,
          [projectId, ownerOrgId],
        );
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.claimed',
          scope: { type: 'project', id: projectId },
          object: { type: 'project', id: projectId },
          payload: { owner_org_id: ownerOrgId },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    async setStatus({ projectId, from, to, action, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE project.project SET status = $3, version = version + 1
            WHERE id = $1 AND status = $2
            RETURNING *`,
          [projectId, from, to],
        );
        if (!rows.length) throw new Error(`status raced: project left ${from}`);
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: `project.${action}`,
          scope: { type: 'project', id: projectId },
          object: { type: 'project', id: projectId },
          payload: { from, to },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    async createLocation({ id, projectId, parentId, kind, name, position, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO project.location (id, project_id, parent_id, kind, name, position)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [id, projectId, parentId, kind, name, position],
        );
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.location.added',
          scope: { type: 'project', id: projectId },
          object: { type: 'location', id },
          payload: { kind, name, parent_id: parentId },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    async updateLocation({ locationId, patch, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE project.location SET
             kind = COALESCE($2, kind),
             name = COALESCE($3, name),
             position = COALESCE($4, position)
           WHERE id = $1 RETURNING *`,
          [locationId, patch.kind ?? null, patch.name ?? null, patch.position ?? null],
        );
        const location = rows[0];
        await appendAuditEvent(client, {
          projectId: location.project_id,
          actor,
          category: 'project',
          type: 'project.location.updated',
          scope: { type: 'project', id: location.project_id },
          object: { type: 'location', id: locationId },
          payload: { changed: Object.keys(patch).filter((k) => patch[k] !== undefined) },
          channel: actor.channel,
        });
        return location;
      });
    },

    async deleteLocation({ locationId, projectId, actor }) {
      return tx(async (client) => {
        await client.query('DELETE FROM project.location WHERE id = $1', [locationId]);
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.location.removed',
          scope: { type: 'project', id: projectId },
          object: { type: 'location', id: locationId },
          payload: { location_id: locationId },
          channel: actor.channel,
        });
      });
    },

    async createInvitation({ id, projectId, invitedByOrgId, email, capacity, tokenHash, expiresAt, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO project.project_invitation
             (id, project_id, invited_by_org_id, email, capacity, token_hash, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [id, projectId, invitedByOrgId, email, capacity, tokenHash, expiresAt],
        );
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.invitation.sent',
          scope: { type: 'project', id: projectId },
          object: { type: 'project_invitation', id },
          // The ledger records THAT an email was invited, hashed elsewhere;
          // the token itself never touches the record.
          payload: { email, capacity: rows[0].capacity, invited_by_org_id: invitedByOrgId },
          channel: actor.channel,
        });
        return rows[0];
      });
    },

    async acceptInvitation({ invitationId, projectId, orgId, inviteCapacity, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE project.project_invitation
              SET status = 'accepted', org_id = $2
            WHERE id = $1 AND status = 'pending'
            RETURNING *`,
          [invitationId, orgId],
        );
        if (!rows.length) throw new Error('invitation raced: no longer pending');
        await client.query(
          `INSERT INTO project.participation
             (project_id, org_id, capacity, source, invite_capacity)
           VALUES ($1, $2, 'consultant', 'invitation', $3)
           ON CONFLICT (project_id, org_id, capacity) DO UPDATE
             SET status = 'active', invite_capacity = excluded.invite_capacity`,
          [projectId, orgId, inviteCapacity],
        );
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.invitation.accepted',
          scope: { type: 'project', id: projectId },
          object: { type: 'project_invitation', id: invitationId },
          payload: { org_id: orgId, invite_capacity: inviteCapacity },
          channel: actor.channel,
        });
        const { rows: participant } = await client.query(
          `SELECT pa.project_id, pa.org_id, pa.capacity, pa.source, pa.contract_id,
                  pa.invite_capacity, o.kind AS org_kind, o.legal_name, o.nif
             FROM project.participation pa
             JOIN identity.organization o ON o.id = pa.org_id
            WHERE pa.project_id = $1 AND pa.org_id = $2 AND pa.capacity = 'consultant'`,
          [projectId, orgId],
        );
        return participant[0];
      });
    },

    async putCalendar({ projectId, workDays, closures, actor }) {
      return tx(async (client) => {
        const ranges = closures.map(({ from, to }) => `[${from},${to}]`);
        const { rows } = await client.query(
          `INSERT INTO project.calendar (project_id, work_days, closures)
           VALUES ($1, $2, $3::daterange[])
           ON CONFLICT (project_id) DO UPDATE
             SET work_days = excluded.work_days, closures = excluded.closures
           RETURNING *`,
          [projectId, workDays, ranges],
        );
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.calendar.updated',
          scope: { type: 'project', id: projectId },
          object: { type: 'calendar', id: projectId },
          payload: { work_days: workDays, closures },
          channel: actor.channel,
        });
        return { work_days: rows[0].work_days, closures: closuresOf(rows[0].closures) };
      });
    },

    async createShareLink({ id, projectId, createdByPersonId, audience, documentIds, taskIds, tokenHash, expiresAt, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO project.share_link
             (id, project_id, created_by_person_id, audience, document_ids, task_ids, token_hash, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [id, projectId, createdByPersonId, audience, documentIds, taskIds, tokenHash, expiresAt],
        );
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'project',
          type: 'project.share_link.created',
          scope: { type: 'project', id: projectId },
          object: { type: 'share_link', id },
          payload: {
            audience, expires_at: expiresAt,
            document_count: documentIds.length, task_count: taskIds.length,
          },
          channel: actor.channel,
        });
        const link = rows[0];
        return { ...link, expires_at: link.expires_at.toISOString?.() ?? link.expires_at };
      });
    },

    /**
     * Consumer write (application/consumers.mjs): the supplier of a signed
     * contract becomes a participant. Not ledgered here — the signature is
     * the ledgered fact (contracting); this row is a projection of it.
     * Idempotent for at-least-once outbox delivery.
     */
    async addContractParticipation({ projectId, orgId, capacity, contractId }) {
      await pool.query(
        `INSERT INTO project.participation (project_id, org_id, capacity, source, contract_id)
         VALUES ($1, $2, $3, 'contract', $4)
         ON CONFLICT (project_id, org_id, capacity) DO UPDATE
           SET status = 'active', contract_id = excluded.contract_id`,
        [projectId, orgId, capacity, contractId],
      );
    },

    // ── idempotency (POST /projects) ─────────────────────────────────────
    async idempotent(meta, fn) {
      if (!meta.key) return fn();
      return tx((client) => withIdempotency(client, meta, fn));
    },
  };
}

/**
 * pg has no parser for daterange[] and hands the whole column back as one
 * array literal, e.g. '{"[2026-08-01,2026-08-16)"}'. Split it into ranges,
 * then map each to inclusive from/to (pg normalises to exclusive upper).
 */
function closuresOf(column) {
  if (Array.isArray(column)) return column.map(rangeToClosure);
  if (typeof column !== 'string') return [];
  return [...column.matchAll(/[[(](\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})([\])])/g)].map(rangeToClosure);
}

function rangeToClosure(raw) {
  const m = typeof raw === 'string'
    ? /([[(])(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})([\])])/.exec(raw)
    : raw; // matchAll entry: [full, from, to, closer]
  if (!m) return { from: String(raw), to: String(raw) };
  const [from, to, closer] = typeof raw === 'string' ? [m[2], m[3], m[4]] : [m[1], m[2], m[3]];
  return { from, to: closer === ')' ? isoMinusDays(to, 1) : to };
}

function isoMinusDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
