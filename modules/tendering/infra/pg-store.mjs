// Postgres store for the tendering module (schema: tendering.*, db/v2 0001).
//
// Owns its transactions. Every write appends its ledger entry (category
// 'tendering') AND — where doc 10 lists an event — publishes it on the SAME
// client before commit (invariants §6.3/§6.4, doc 02 rule 3). Cross-schema
// READS (identity for the actor, project for guards, planning.task +
// contracting.boq_item for the package snapshot, contracting.contract for
// sub-level RFPs) are query ports; the ONE cross-module write — the contract
// draft at award — is contracting's own code run on the award client
// (modules/contracting/application/award.mjs), so it stays contracting's.
//
// Visibility is V8 (doc 04): a lane belongs to the ISSUER and its BIDDER;
// nobody else — including other participants of the project — ever reads it.
// `lanesForTask` enforces that in SQL so a handler cannot forget it.
// Proposal-scoped ledger entries carry scope `rfp_private` (V7 redacts them).
import { randomUUID, createHash, randomBytes } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';
import { withIdempotency } from '../../../platform/idempotency.mjs';

export function createTenderingStore(pool) {
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

  /** One RFP row with its roots aggregated, on any client. */
  async function loadRfp(q, rfpId) {
    const { rows } = await q.query(
      `SELECT r.*,
              coalesce((SELECT array_agg(task_id) FROM tendering.rfp_root WHERE rfp_id = r.id), '{}') AS root_task_ids
         FROM tendering.rfp r WHERE r.id = $1`,
      [rfpId],
    );
    return rows[0] ?? null;
  }

  async function insertPackage(client, { rfpId, packageVersion, packageRows, packageItems }) {
    for (const row of packageRows) {
      await client.query(
        `INSERT INTO tendering.rfp_package_row
           (rfp_id, package_version, task_id, parent_task_id, name, scope_text, specialty, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rfpId, packageVersion, row.task_id, row.parent_task_id, row.name,
          row.scope_text, row.specialty, row.position],
      );
    }
    for (const item of packageItems) {
      await client.query(
        `INSERT INTO tendering.rfp_item
           (id, rfp_id, package_version, task_id, code, description, unit, quantity, material_spec, specialty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(), rfpId, packageVersion, item.task_id, item.code,
          item.description, item.unit, item.quantity, item.material_spec, item.specialty],
      );
    }
  }

  return {
    // ── cross-schema reads (query ports) ─────────────────────────────────
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

    async getContract(contractId) {
      const { rows } = await pool.query('SELECT * FROM contracting.contract WHERE id = $1', [contractId]);
      return rows[0] ?? null;
    },

    async getOrganization(orgId) {
      const { rows } = await pool.query('SELECT * FROM identity.organization WHERE id = $1', [orgId]);
      return rows[0] ?? null;
    },

    async getTask(taskId) {
      const { rows } = await pool.query(
        `SELECT id, project_id, name, contract_id, branch_contract_id
           FROM planning.task WHERE id = $1 AND deleted_at IS NULL`,
        [taskId],
      );
      return rows[0] ?? null;
    },

    /** Which of `taskIds` are live rows of this project. */
    async tasksOfProject(projectId, taskIds) {
      const { rows } = await pool.query(
        `SELECT id FROM planning.task
          WHERE project_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [projectId, taskIds],
      );
      return new Set(rows.map((r) => r.id));
    },

    /** The branch contract over each root (R1 — sub-level scoping). */
    async branchContractsOf(taskIds) {
      const { rows } = await pool.query(
        `SELECT id AS task_id, coalesce(branch_contract_id, contract_id) AS branch_contract_id
           FROM planning.task WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [taskIds],
      );
      return rows;
    },

    /**
     * The package (doc 05 §10): the roots' SUBTREES — structure and scope —
     * plus their live BoQ quantities, never prices (the rfp_item table has no
     * price column; the schema itself enforces the redaction).
     */
    async snapshotPackage(projectId, rootTaskIds) {
      const { rows } = await pool.query(
        `WITH RECURSIVE sub AS (
             SELECT t.*, 0 AS rel_depth FROM planning.task t
              WHERE t.id = ANY($2::uuid[]) AND t.project_id = $1 AND t.deleted_at IS NULL
             UNION ALL
             SELECT c.*, sub.rel_depth + 1 FROM planning.task c
               JOIN sub ON c.parent_id = sub.id
              WHERE c.deleted_at IS NULL
           )
         SELECT id AS task_id,
                CASE WHEN rel_depth = 0 THEN NULL ELSE parent_id END AS parent_task_id,
                name, description AS scope_text, specialty, position
           FROM sub ORDER BY rel_depth, position`,
        [projectId, rootTaskIds],
      );
      const taskIds = rows.map((r) => r.task_id);
      const { rows: items } = await pool.query(
        `SELECT task_id, coalesce(chapter || '.', '') || code AS code, description, unit,
                quantity, material_spec, specialty
           FROM contracting.boq_item
          WHERE task_id = ANY($1::uuid[]) AND superseded_by_change_order_id IS NULL
          ORDER BY code`,
        [taskIds],
      );
      return { rows, items };
    },

    // ── tendering reads ───────────────────────────────────────────────────
    async getRfp(rfpId) {
      return loadRfp(pool, rfpId);
    },

    async packageOf(rfpId, packageVersion) {
      const { rows } = await pool.query(
        `SELECT task_id, parent_task_id, name, scope_text, specialty, position
           FROM tendering.rfp_package_row
          WHERE rfp_id = $1 AND package_version = $2
          ORDER BY position`,
        [rfpId, packageVersion],
      );
      const { rows: items } = await pool.query(
        `SELECT id, task_id, code, description, unit, quantity, material_spec, specialty
           FROM tendering.rfp_item
          WHERE rfp_id = $1 AND package_version = $2
          ORDER BY code`,
        [rfpId, packageVersion],
      );
      return { rows, items };
    },

    async clarificationsOf(rfpId) {
      const { rows } = await pool.query(
        'SELECT * FROM tendering.clarification WHERE rfp_id = $1 ORDER BY id',
        [rfpId],
      );
      return rows;
    },

    async getClarification(clarificationId) {
      const { rows } = await pool.query('SELECT * FROM tendering.clarification WHERE id = $1', [clarificationId]);
      return rows[0] ?? null;
    },

    async isRecipient(rfpId, orgId) {
      const { rows } = await pool.query(
        'SELECT 1 FROM tendering.rfp_recipient WHERE rfp_id = $1 AND org_id = $2',
        [rfpId, orgId],
      );
      return rows.length > 0;
    },

    async recipientCount(rfpId) {
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM tendering.rfp_recipient WHERE rfp_id = $1',
        [rfpId],
      );
      return rows[0].n;
    },

    async listRecipients(rfpId, { cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT * FROM tendering.rfp_recipient
          WHERE rfp_id = $1 AND ($2::uuid IS NULL OR id > $2)
          ORDER BY id LIMIT $3`,
        [rfpId, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    /** A proposal with the rfp facts every guard needs. */
    async getProposal(proposalId) {
      const { rows } = await pool.query(
        `SELECT p.*, r.issuer_org_id, r.status AS rfp_status, r.project_id,
                r.submission_deadline, r.package_version, r.level, r.parent_contract_id
           FROM tendering.proposal p JOIN tendering.rfp r ON r.id = p.rfp_id
          WHERE p.id = $1`,
        [proposalId],
      );
      return rows[0] ?? null;
    },

    async proposalDoc(proposalId) {
      const { rows } = await pool.query(
        'SELECT * FROM tendering.proposal_row WHERE proposal_id = $1 ORDER BY position',
        [proposalId],
      );
      const { rows: links } = await pool.query(
        'SELECT * FROM tendering.proposal_link WHERE proposal_id = $1',
        [proposalId],
      );
      const { rows: lines } = await pool.query(
        'SELECT * FROM tendering.proposal_line WHERE proposal_id = $1 ORDER BY id',
        [proposalId],
      );
      return { rows, links, lines };
    },

    async itemsOfRfp(rfpId, itemIds) {
      const { rows } = await pool.query(
        'SELECT id FROM tendering.rfp_item WHERE rfp_id = $1 AND id = ANY($2::uuid[])',
        [rfpId, itemIds],
      );
      return new Set(rows.map((r) => r.id));
    },

    /**
     * The lanes under a tendered row (D-36), V8 IN THE QUERY: the issuer of
     * the RFP sees every lane, a bidder sees its own, anyone else none.
     * Lane chips (missing/variant lines, has_plan) are computed here.
     */
    async lanesForTask(taskId, { viewerOrgId, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT p.*, rec.email, o.legal_name AS bidder_name,
                r.package_version,
                (SELECT count(*)::int FROM tendering.rfp_item i
                  WHERE i.rfp_id = r.id AND i.package_version = r.package_version
                    AND NOT EXISTS (SELECT 1 FROM tendering.proposal_line pl
                                     WHERE pl.proposal_id = p.id AND pl.rfp_item_id = i.id
                                       AND NOT pl.is_variant)) AS missing_lines,
                (SELECT count(*)::int FROM tendering.proposal_line pl
                  WHERE pl.proposal_id = p.id AND pl.is_variant) AS variant_lines,
                EXISTS (SELECT 1 FROM tendering.proposal_row pr WHERE pr.proposal_id = p.id) AS has_plan
           FROM tendering.proposal p
           JOIN tendering.rfp r ON r.id = p.rfp_id
           JOIN tendering.rfp_root rr ON rr.rfp_id = r.id AND rr.task_id = $1
           JOIN tendering.rfp_recipient rec ON rec.id = p.recipient_id
           LEFT JOIN identity.organization o ON o.id = p.bidder_org_id
          WHERE (r.issuer_org_id = $2 OR p.bidder_org_id = $2)
            AND ($3::uuid IS NULL OR p.id > $3)
          ORDER BY p.id LIMIT $4`,
        [taskId, viewerOrgId, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    /** Every lane of an RFP — issuer-side internals (award, comparison). */
    async lanesOfRfp(rfpId) {
      const { rows } = await pool.query(
        `SELECT p.*, rec.email, o.legal_name AS bidder_name
           FROM tendering.proposal p
           JOIN tendering.rfp_recipient rec ON rec.id = p.recipient_id
           LEFT JOIN identity.organization o ON o.id = p.bidder_org_id
          WHERE p.rfp_id = $1 ORDER BY p.id`,
        [rfpId],
      );
      return rows;
    },

    async linesOfProposals(proposalIds) {
      const { rows } = await pool.query(
        'SELECT * FROM tendering.proposal_line WHERE proposal_id = ANY($1::uuid[])',
        [proposalIds],
      );
      return rows;
    },

    async rowsOfProposals(proposalIds) {
      const { rows } = await pool.query(
        'SELECT * FROM tendering.proposal_row WHERE proposal_id = ANY($1::uuid[])',
        [proposalIds],
      );
      return rows;
    },

    /** Open listing (D-15): published, visibility open, filterable. */
    async browseOpenRfps({ specialty, municipality, cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT r.*,
                coalesce((SELECT array_agg(task_id) FROM tendering.rfp_root WHERE rfp_id = r.id), '{}') AS root_task_ids
           FROM tendering.rfp r
           JOIN project.project pr ON pr.id = r.project_id
          WHERE r.visibility = 'open' AND r.status = 'published'
            AND ($1::text IS NULL OR $1 = ANY(r.specialties))
            AND ($2::text IS NULL OR pr.municipality_code = $2)
            AND ($3::uuid IS NULL OR r.id > $3)
          ORDER BY r.id LIMIT $4`,
        [specialty, municipality, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    /** RFPs the org was invited to or bid on (bidder home). */
    async listMyRfps(orgId, { cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT DISTINCT r.*,
                coalesce((SELECT array_agg(task_id) FROM tendering.rfp_root WHERE rfp_id = r.id), '{}') AS root_task_ids
           FROM tendering.rfp r
          WHERE (EXISTS (SELECT 1 FROM tendering.rfp_recipient rec
                          WHERE rec.rfp_id = r.id AND rec.org_id = $1)
              OR EXISTS (SELECT 1 FROM tendering.proposal p
                          WHERE p.rfp_id = r.id AND p.bidder_org_id = $1))
            AND ($2::uuid IS NULL OR r.id > $2)
          ORDER BY r.id LIMIT $3`,
        [orgId, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
    },

    // ── writes (ledger + outbox on the same client — §6.3/§6.4) ──────────

    async createRfp({ id, projectId, issuerOrgId, level, parentContractId, title, scopeText,
      visibility, questionsDeadline, submissionDeadline, rootTaskIds, packageRows, packageItems, actor }) {
      return tx(async (client) => {
        const specialties = [...new Set(packageRows.map((r) => r.specialty).filter(Boolean))];
        await client.query(
          `INSERT INTO tendering.rfp
             (id, project_id, issuer_org_id, level, parent_contract_id, title, scope_text,
              specialties, visibility, questions_deadline, submission_deadline)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, projectId, issuerOrgId, level, parentContractId, title, scopeText,
            specialties, visibility, questionsDeadline, submissionDeadline],
        );
        for (const taskId of rootTaskIds) {
          await client.query('INSERT INTO tendering.rfp_root (rfp_id, task_id) VALUES ($1, $2)', [id, taskId]);
        }
        await insertPackage(client, { rfpId: id, packageVersion: 1, packageRows, packageItems });
        // No doc-10 event for a draft — the world hears about it at :publish.
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.rfp.created',
          scope: { type: 'project', id: projectId },
          object: { type: 'rfp', id },
          payload: { level, title, root_task_ids: rootTaskIds, visibility, items: packageItems.length },
          channel: actor.channel,
        });
        return loadRfp(client, id);
      });
    },

    async updateRfp({ rfpId, expectedVersion, set, rootTaskIds, packageRows, packageItems, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.rfp SET
             title = coalesce($3, title),
             scope_text = CASE WHEN $4::boolean THEN $5 ELSE scope_text END,
             visibility = coalesce($6, visibility),
             questions_deadline = CASE WHEN $7::boolean THEN $8::timestamptz ELSE questions_deadline END,
             submission_deadline = coalesce($9::timestamptz, submission_deadline),
             version = version + 1
           WHERE id = $1 AND version = $2 AND status = 'draft'
           RETURNING *`,
          [rfpId, expectedVersion,
            set.title ?? null,
            set.scopeText !== undefined, set.scopeText ?? null,
            set.visibility ?? null,
            set.questionsDeadline !== undefined, set.questionsDeadline ?? null,
            set.submissionDeadline ?? null],
        );
        if (!rows.length) return null; // version raced — the caller answers 409
        if (rootTaskIds) {
          await client.query('DELETE FROM tendering.rfp_root WHERE rfp_id = $1', [rfpId]);
          for (const taskId of rootTaskIds) {
            await client.query('INSERT INTO tendering.rfp_root (rfp_id, task_id) VALUES ($1, $2)', [rfpId, taskId]);
          }
          await client.query('DELETE FROM tendering.rfp_item WHERE rfp_id = $1 AND package_version = 1', [rfpId]);
          await client.query('DELETE FROM tendering.rfp_package_row WHERE rfp_id = $1 AND package_version = 1', [rfpId]);
          await insertPackage(client, { rfpId, packageVersion: 1, packageRows, packageItems });
          const specialties = [...new Set(packageRows.map((r) => r.specialty).filter(Boolean))];
          await client.query('UPDATE tendering.rfp SET specialties = $2 WHERE id = $1', [rfpId, specialties]);
        }
        await appendAuditEvent(client, {
          projectId: rows[0].project_id, actor,
          category: 'tendering',
          type: 'tendering.rfp.updated',
          scope: { type: 'project', id: rows[0].project_id },
          object: { type: 'rfp', id: rfpId },
          payload: { ...(rootTaskIds ? { root_task_ids: rootTaskIds } : {}), fields: Object.keys(set).filter((k) => set[k] !== undefined) },
          channel: actor.channel,
        });
        return loadRfp(client, rfpId);
      });
    },

    /**
     * Insert recipients + open their lanes (one proposal per recipient,
     * D-36). The raw token is returned ONCE; only its hash is stored.
     * A re-add of the same email is absorbed (UNIQUE rfp_id, email).
     */
    async addRecipients({ rfpId, projectId, recipients, actor }) {
      return tx(async (client) => {
        const out = [];
        for (const r of recipients) {
          const token = randomBytes(32).toString('hex');
          const { rows } = await client.query(
            `INSERT INTO tendering.rfp_recipient (id, rfp_id, org_id, email, token_hash)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (rfp_id, email) DO NOTHING
             RETURNING *`,
            [randomUUID(), rfpId, r.orgId, r.email, sha256(token)],
          );
          if (!rows.length) {
            const { rows: existing } = await client.query(
              'SELECT * FROM tendering.rfp_recipient WHERE rfp_id = $1 AND email = $2',
              [rfpId, r.email],
            );
            out.push({ recipient: existing[0], token: null });
            continue;
          }
          const recipient = rows[0];
          await client.query(
            `INSERT INTO tendering.proposal (id, rfp_id, recipient_id, bidder_org_id)
             VALUES ($1,$2,$3,$4)`,
            [randomUUID(), rfpId, recipient.id, r.orgId],
          );
          out.push({ recipient, token });
        }
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.rfp.recipients_added',
          scope: { type: 'project', id: projectId },
          object: { type: 'rfp', id: rfpId },
          // Emails are personal data and bidder identity is sensitive (D-29):
          // the ledger records how many, not who. Who is in tendering.*.
          payload: { count: out.length },
          channel: actor.channel,
        });
        return out;
      });
    },

    /** Guarded status move; null when `from` raced away (caller answers 409). */
    async transitionRfp({ rfpId, from, to, eventType, projectId, data, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.rfp SET status = $3, version = version + 1
            WHERE id = $1 AND status = $2 RETURNING *`,
          [rfpId, from, to],
        );
        if (!rows.length) return null;
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: eventType,
          scope: { type: 'project', id: projectId },
          object: { type: 'rfp', id: rfpId },
          payload: { from, to, ...data },
          channel: actor.channel,
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: eventType,
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'project', id: projectId },
          data: { rfp_id: rfpId, project_id: projectId, ...data },
        });
        return loadRfp(client, rfpId);
      });
    },

    /** R2: versioned addendum — new package snapshot, all bidders notified. */
    async addAddendum({ rfpId, projectId, packageVersion, summary, submissionDeadline,
      questionsDeadline, packageRows, packageItems, actor }) {
      return tx(async (client) => {
        await client.query(
          `UPDATE tendering.rfp SET
             package_version = $2,
             submission_deadline = coalesce($3::timestamptz, submission_deadline),
             questions_deadline = coalesce($4::timestamptz, questions_deadline),
             version = version + 1
           WHERE id = $1`,
          [rfpId, packageVersion, submissionDeadline, questionsDeadline],
        );
        await client.query(
          'INSERT INTO tendering.rfp_addendum (rfp_id, package_version, summary) VALUES ($1,$2,$3)',
          [rfpId, packageVersion, summary],
        );
        await insertPackage(client, { rfpId, packageVersion, packageRows, packageItems });
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.rfp.addendum_issued',
          scope: { type: 'project', id: projectId },
          object: { type: 'rfp', id: rfpId },
          payload: { package_version: packageVersion, summary },
          channel: actor.channel,
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'tendering.rfp.addendum_issued',
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'project', id: projectId },
          data: { rfp_id: rfpId, package_version: packageVersion, summary },
        });
        return loadRfp(client, rfpId);
      });
    },

    async askClarification({ id, rfpId, projectId, askedByOrgId, question, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO tendering.clarification (id, rfp_id, asked_by_org_id, question)
           VALUES ($1,$2,$3,$4) RETURNING *`,
          [id, rfpId, askedByOrgId, question],
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

    /** Whole-document replace (PUT); guarded on version; ledger-only. */
    async replaceProposalDoc({ proposalId, expectedVersion, status, rows, links, lines,
      conditions, validityUntil, documentIds, totalCents, durationWd, start,
      projectId, rfpId, actor }) {
      return tx(async (client) => {
        const { rows: updated } = await client.query(
          `UPDATE tendering.proposal SET
             status = $3, conditions = $4, validity_until = $5, document_ids = $6,
             summary_total_cents = $7, summary_duration_wd = $8, summary_start = $9,
             version = version + 1
           WHERE id = $1 AND version = $2
           RETURNING *`,
          [proposalId, expectedVersion, status, conditions, validityUntil, documentIds,
            totalCents, durationWd, start],
        );
        if (!updated.length) return null;
        await client.query('DELETE FROM tendering.proposal_link WHERE proposal_id = $1', [proposalId]);
        await client.query('DELETE FROM tendering.proposal_line WHERE proposal_id = $1', [proposalId]);
        await client.query('DELETE FROM tendering.proposal_row WHERE proposal_id = $1', [proposalId]);
        for (const row of rows) {
          await client.query(
            `INSERT INTO tendering.proposal_row
               (id, proposal_id, packaged_task_id, parent_row_id, kind, name, duration_wd, start, finish, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [row.id, proposalId, row.packagedTaskId, row.parentRowId, row.kind,
              row.name, row.durationWd, row.start, row.finish, row.position],
          );
        }
        for (const link of links) {
          await client.query(
            `INSERT INTO tendering.proposal_link
               (proposal_id, predecessor_row, successor_row, from_anchor, to_anchor, lag_wd)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [proposalId, link.predecessorRow, link.successorRow, link.fromAnchor, link.toAnchor, link.lagWd],
          );
        }
        for (const line of lines) {
          await client.query(
            `INSERT INTO tendering.proposal_line
               (id, proposal_id, rfp_item_id, proposal_row_id, is_variant, description, unit, quantity, unit_price_cents)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), proposalId, line.rfpItemId, line.proposalRowId, line.isVariant,
              line.description, line.unit, line.quantity, line.unitPriceCents],
          );
        }
        // Ledger-only: doc 10 has no event for drafting — the issuer hears
        // about the lane at :submit. Scope rfp_private (V7/V8).
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.proposal.drafted',
          scope: { type: 'rfp_private', id: proposalId },
          object: { type: 'proposal', id: proposalId },
          payload: { rfp_id: rfpId, rows: rows.length, lines: lines.length },
          channel: actor.channel,
        });
        return updated[0];
      });
    },

    /** invited|draft|submitted → submitted; new revision counts (doc 09). */
    async submitProposal({ proposalId, from, revision, totalCents, projectId, rfpId, bidderOrgId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.proposal SET status = 'submitted', current_revision = $3, version = version + 1
            WHERE id = $1 AND status = $2 RETURNING *`,
          [proposalId, from, revision],
        );
        if (!rows.length) return null;
        await client.query(
          `INSERT INTO tendering.proposal_revision (proposal_id, revision, total_cents)
           VALUES ($1,$2,$3)`,
          [proposalId, revision, totalCents],
        );
        await client.query(
          `UPDATE tendering.rfp_recipient SET status = 'proposal_submitted' WHERE id = $2 AND rfp_id = $1`,
          [rfpId, rows[0].recipient_id],
        );
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.proposal.submitted',
          scope: { type: 'rfp_private', id: proposalId },
          object: { type: 'proposal', id: proposalId },
          payload: { rfp_id: rfpId, revision, total: totalCents },
          channel: actor.channel,
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'tendering.proposal.submitted',
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'rfp_private', id: proposalId },
          data: { rfp_id: rfpId, proposal_id: proposalId, bidder_org_id: bidderOrgId, revision },
        });
        return rows[0];
      });
    },

    /** Guarded proposal move; eventType null = ledger-only (shortlist). */
    async transitionProposal({ proposalId, from, to, eventType, projectId, rfpId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.proposal SET status = $3, version = version + 1
            WHERE id = $1 AND status = $2 RETURNING *`,
          [proposalId, from, to],
        );
        if (!rows.length) return null;
        const type = `tendering.proposal.${to}`;
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type,
          scope: { type: 'rfp_private', id: proposalId },
          object: { type: 'proposal', id: proposalId },
          payload: { rfp_id: rfpId, from, to },
          channel: actor.channel,
        });
        if (eventType) {
          await publishEvent(client, {
            event_id: randomUUID(),
            type: eventType,
            project_id: projectId,
            actor: { person_id: actor.personId, org_id: actor.orgId },
            scope: { type: 'rfp_private', id: proposalId },
            data: { rfp_id: rfpId, proposal_id: proposalId, from, to },
          });
        }
        return rows[0];
      });
    },

    /** The issuer records an emailed answer: channel=email, summary, no plan. */
    async recordOfflineProposal({ proposalId, from, revision, totalCents, durationWd, start,
      conditions, validityUntil, documentIds, recordedByPersonId, projectId, rfpId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.proposal SET
             status = 'submitted', channel = 'email', current_revision = $3,
             summary_total_cents = $4, summary_duration_wd = $5, summary_start = $6,
             conditions = $7, validity_until = $8, document_ids = $9,
             recorded_by_person_id = $10, version = version + 1
           WHERE id = $1 AND status = $2 RETURNING *`,
          [proposalId, from, revision, totalCents, durationWd, start,
            conditions, validityUntil, documentIds, recordedByPersonId],
        );
        if (!rows.length) return null;
        await client.query(
          `INSERT INTO tendering.proposal_revision (proposal_id, revision, total_cents)
           VALUES ($1,$2,$3)`,
          [proposalId, revision, totalCents],
        );
        await client.query(
          `UPDATE tendering.rfp_recipient SET status = 'proposal_submitted' WHERE id = $2 AND rfp_id = $1`,
          [rfpId, rows[0].recipient_id],
        );
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.proposal.submitted',
          scope: { type: 'rfp_private', id: proposalId },
          object: { type: 'proposal', id: proposalId },
          payload: { rfp_id: rfpId, revision, total: totalCents, channel: 'email' },
          channel: actor.channel,
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'tendering.proposal.submitted',
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'rfp_private', id: proposalId },
          data: { rfp_id: rfpId, proposal_id: proposalId, bidder_org_id: rows[0].bidder_org_id, revision, channel: 'email' },
        });
        return rows[0];
      });
    },

    /**
     * ONE transaction (doc 09 award guard already proven by the use case):
     * RFP → awarded, winner lane → awarded, live losers → declined, and the
     * contract draft written by contracting's award port on this client.
     */
    async awardRfp({ rfpId, from, winnerProposalId, declineProposalIds, note,
      projectId, actor, createContract }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.rfp SET status = 'awarded', awarded_proposal_id = $3, version = version + 1
            WHERE id = $1 AND status = $2 RETURNING *`,
          [rfpId, from, winnerProposalId],
        );
        if (!rows.length) return null;
        const { rows: winnerRows } = await client.query(
          `UPDATE tendering.proposal SET status = 'awarded', version = version + 1
            WHERE id = $1 AND status IN ('submitted','shortlisted') RETURNING *`,
          [winnerProposalId],
        );
        if (!winnerRows.length) return null; // the lane raced away — 409
        if (declineProposalIds.length) {
          await client.query(
            `UPDATE tendering.proposal SET status = 'declined', version = version + 1
              WHERE id = ANY($1::uuid[]) AND status IN ('invited','draft','submitted','shortlisted')`,
            [declineProposalIds],
          );
        }
        const award = await createContract(client);
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.rfp.awarded',
          scope: { type: 'project', id: projectId },
          object: { type: 'rfp', id: rfpId },
          payload: {
            proposal_id: winnerProposalId,
            contract_id: award.contract.id,
            declined_proposal_ids: declineProposalIds,
            ...(note ? { note } : {}),
          },
          channel: actor.channel,
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'tendering.rfp.awarded',
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'project', id: projectId },
          data: { rfp_id: rfpId, proposal_id: winnerProposalId, contract_id: award.contract.id },
        });
        return award;
      });
    },

    // ── idempotency (POST …/rfps) ─────────────────────────────────────────
    async idempotent(meta, fn) {
      if (!meta.key) return fn();
      return tx((client) => withIdempotency(client, meta, fn));
    },
  };
}

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}
