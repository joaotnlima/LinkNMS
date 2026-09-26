// Postgres store for the contracting module (schema: contracting.*, db/v2
// 0001 + 0004).
//
// Owns its transactions. Every write appends its ledger entry AND publishes
// its domain event on the SAME client before commit (invariants §6.3/§6.4,
// doc 02 rule 3). Ledger entries are CONTRACT-scoped so the V7 redacted read
// hides them from non-parties (checks §5). Cross-schema READS (identity for
// actor/orgs, project for guards, planning.task to validate roots) are query
// ports; it never WRITES outside contracting.* + ledger + outbox — binding
// tasks and baselining on signature is planning's consumer of
// contracting.contract.signed (doc 10), participation is project's.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { ProblemError } from '../../../platform/errors.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';
import { withIdempotency } from '../../../platform/idempotency.mjs';

export function createContractingStore(pool) {
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

  /** One contract + everything its wire body needs, on any client. */
  async function loadContract(q, contractId) {
    const { rows } = await q.query(
      `SELECT c.*,
              cl.kind AS client_kind, cl.legal_name AS client_legal_name, cl.nif AS client_nif,
              su.kind AS supplier_kind, su.legal_name AS supplier_legal_name, su.nif AS supplier_nif,
              coalesce((SELECT sum(round(b.quantity * b.unit_price_cents))
                          FROM contracting.boq_item b
                         WHERE b.contract_id = c.id
                           AND b.superseded_by_change_order_id IS NULL), 0) AS value_cents_live,
              coalesce((SELECT array_agg(r.task_id ORDER BY r.task_id)
                          FROM contracting.contract_root r
                         WHERE r.contract_id = c.id), '{}') AS root_task_ids
         FROM contracting.contract c
         JOIN identity.organization cl ON cl.id = c.client_org_id
         JOIN identity.organization su ON su.id = c.supplier_org_id
        WHERE c.id = $1`,
      [contractId],
    );
    if (!rows.length) return null;
    const { rows: signatures } = await q.query(
      `SELECT org_id, person_id, signed_at FROM contracting.contract_signature
        WHERE contract_id = $1 ORDER BY signed_at`,
      [contractId],
    );
    return bundle(rows[0], signatures);
  }

  /** One change order + lines + time + its contract, on any client. */
  async function loadChangeOrder(q, changeOrderId) {
    const { rows } = await q.query('SELECT * FROM contracting.change_order WHERE id = $1', [changeOrderId]);
    if (!rows.length) return null;
    const [{ rows: lines }, { rows: time }, { rows: contracts }] = await Promise.all([
      q.query('SELECT op, boq_item_id, new_line FROM contracting.change_order_line WHERE change_order_id = $1 ORDER BY id', [changeOrderId]),
      q.query('SELECT task_id, new_baseline_start, new_baseline_finish FROM contracting.change_order_time WHERE change_order_id = $1 ORDER BY task_id', [changeOrderId]),
      q.query('SELECT id, project_id, client_org_id, supplier_org_id, status, payment_days, retention_bp FROM contracting.contract WHERE id = $1', [rows[0].contract_id]),
    ]);
    return { changeOrder: rows[0], lines, time, contract: contracts[0] };
  }

  /** One measurement + priced lines (with cumulative) + its contract. */
  async function loadMeasurement(q, measurementId) {
    const { rows } = await q.query('SELECT * FROM contracting.measurement WHERE id = $1', [measurementId]);
    if (!rows.length) return null;
    const [{ rows: lines }, { rows: contracts }] = await Promise.all([
      q.query(
        `SELECT ml.boq_item_id, ml.quantity_this_period, b.description, b.unit_price_cents,
                (SELECT sum(ml2.quantity_this_period)
                   FROM contracting.measurement_line ml2
                   JOIN contracting.measurement m2 ON m2.id = ml2.measurement_id
                  WHERE ml2.boq_item_id = ml.boq_item_id
                    AND m2.contract_id = $2 AND m2.period <= $3
                    AND m2.status <> 'disputed') AS cumulative_quantity
           FROM contracting.measurement_line ml
           JOIN contracting.boq_item b ON b.id = ml.boq_item_id
          WHERE ml.measurement_id = $1
          ORDER BY b.code`,
        [measurementId, rows[0].contract_id, rows[0].period],
      ),
      q.query('SELECT id, project_id, client_org_id, supplier_org_id, status, payment_days, retention_bp FROM contracting.contract WHERE id = $1', [rows[0].contract_id]),
    ]);
    return { measurement: rows[0], lines, contract: contracts[0] };
  }

  /** ledger + outbox for one contract-scoped money event, same client. */
  async function moneyEvent(client, { projectId, contractId, actor, type, objectType, objectId, payload, data }) {
    await appendAuditEvent(client, {
      projectId,
      actor,
      category: 'contracting',
      type,
      scope: { type: 'contract', id: contractId },
      object: { type: objectType, id: objectId },
      payload,
      channel: actor.channel ?? 'system',
    });
    await publishEvent(client, {
      event_id: randomUUID(),
      type,
      project_id: projectId,
      actor: { person_id: actor.personId ?? null, org_id: actor.orgId ?? null },
      scope: { type: 'contract', id: contractId },
      data,
    });
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

    async getOrganization(orgId) {
      const { rows } = await pool.query('SELECT * FROM identity.organization WHERE id = $1', [orgId]);
      return rows[0] ?? null;
    },

    /** Which of `taskIds` are live rows of this project (root validation). */
    async tasksOfProject(projectId, taskIds) {
      const { rows } = await pool.query(
        `SELECT id FROM planning.task
          WHERE project_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [projectId, taskIds],
      );
      return new Set(rows.map((r) => r.id));
    },

    async getContract(contractId) {
      return loadContract(pool, contractId);
    },

    async listContracts(projectId, { cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT c.*,
                cl.kind AS client_kind, cl.legal_name AS client_legal_name, cl.nif AS client_nif,
                su.kind AS supplier_kind, su.legal_name AS supplier_legal_name, su.nif AS supplier_nif,
                coalesce((SELECT sum(round(b.quantity * b.unit_price_cents))
                            FROM contracting.boq_item b
                           WHERE b.contract_id = c.id
                             AND b.superseded_by_change_order_id IS NULL), 0) AS value_cents_live,
                coalesce((SELECT array_agg(r.task_id ORDER BY r.task_id)
                            FROM contracting.contract_root r
                           WHERE r.contract_id = c.id), '{}') AS root_task_ids
           FROM contracting.contract c
           JOIN identity.organization cl ON cl.id = c.client_org_id
           JOIN identity.organization su ON su.id = c.supplier_org_id
          WHERE c.project_id = $1 AND ($2::uuid IS NULL OR c.id > $2::uuid)
          ORDER BY c.id
          LIMIT $3`,
        [projectId, cursor, limit + 1],
      );
      const page = rows.slice(0, limit);
      const ids = page.map((r) => r.id);
      const { rows: sigs } = ids.length
        ? await pool.query(
          `SELECT contract_id, org_id, person_id, signed_at
             FROM contracting.contract_signature
            WHERE contract_id = ANY($1::uuid[]) ORDER BY signed_at`,
          [ids],
        )
        : { rows: [] };
      const byContract = new Map(ids.map((id) => [id, []]));
      for (const s of sigs) byContract.get(s.contract_id).push(s);
      return {
        items: page.map((r) => bundle(r, byContract.get(r.id))),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      };
    },

    // ── writes (ledger + outbox on the same client — §6.3/§6.4) ──────────
    async createContract({ id, projectId, kind, parentContractId, clientOrgId, supplierOrgId,
      reference, paymentTerms, retentionBp, scopeInclusions, scopeExclusions, rootTaskIds, actor }) {
      return tx(async (client) => {
        await client.query(
          `INSERT INTO contracting.contract
             (id, project_id, kind, parent_contract_id, client_org_id, supplier_org_id,
              reference, payment_terms, retention_bp, scope_inclusions, scope_exclusions, origin)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'direct_entry')`,
          [id, projectId, kind, parentContractId, clientOrgId, supplierOrgId,
            reference, paymentTerms, retentionBp, scopeInclusions, scopeExclusions],
        );
        for (const taskId of rootTaskIds) {
          await client.query(
            'INSERT INTO contracting.contract_root (contract_id, task_id) VALUES ($1, $2)',
            [id, taskId],
          );
        }
        await appendAuditEvent(client, {
          projectId,
          actor,
          category: 'contracting',
          type: 'contracting.contract.created',
          scope: { type: 'contract', id },
          object: { type: 'contract', id },
          payload: {
            kind, reference,
            client_org_id: clientOrgId, supplier_org_id: supplierOrgId,
            parent_contract_id: parentContractId, root_task_ids: rootTaskIds,
          },
          channel: actor.channel,
        });
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'contracting.contract.created',
          project_id: projectId,
          actor: { person_id: actor.personId, org_id: actor.orgId },
          scope: { type: 'contract', id },
          data: { kind, client_org_id: clientOrgId, supplier_org_id: supplierOrgId },
        });
        return loadContract(client, id);
      });
    },

    async updateDraft({ contractId, expectedVersion, patch, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE contracting.contract SET
             reference = COALESCE($3, reference),
             payment_terms = COALESCE($4, payment_terms),
             retention_bp = COALESCE($5, retention_bp),
             scope_inclusions = CASE WHEN $6::boolean THEN $7 ELSE scope_inclusions END,
             scope_exclusions = CASE WHEN $8::boolean THEN $9 ELSE scope_exclusions END,
             version = version + 1
           WHERE id = $1 AND version = $2 AND status = 'draft'
           RETURNING *`,
          [contractId, expectedVersion,
            patch.reference ?? null,
            patch.paymentTerms ?? null,
            patch.retentionBp ?? null,
            patch.scopeInclusions !== undefined, patch.scopeInclusions ?? null,
            patch.scopeExclusions !== undefined, patch.scopeExclusions ?? null],
        );
        if (!rows.length) return null; // version raced — the caller answers 409
        if (patch.rootTaskIds) {
          await client.query('DELETE FROM contracting.contract_root WHERE contract_id = $1', [contractId]);
          for (const taskId of patch.rootTaskIds) {
            await client.query(
              'INSERT INTO contracting.contract_root (contract_id, task_id) VALUES ($1, $2)',
              [contractId, taskId],
            );
          }
        }
        await appendAuditEvent(client, {
          projectId: rows[0].project_id,
          actor,
          category: 'contracting',
          type: 'contracting.contract.updated',
          scope: { type: 'contract', id: contractId },
          object: { type: 'contract', id: contractId },
          payload: {
            version: rows[0].version,
            changed: Object.keys(patch).filter((k) => patch[k] !== undefined),
          },
          channel: actor.channel,
        });
        return loadContract(client, contractId);
      });
    },

    async addSignature({ contractId, orgId, personId, becomesSigned, actor }) {
      return tx(async (client) => {
        const { rows: existing } = await client.query(
          'SELECT project_id, kind, client_org_id, supplier_org_id FROM contracting.contract WHERE id = $1 FOR UPDATE',
          [contractId],
        );
        const contract = existing[0];
        await client.query(
          `INSERT INTO contracting.contract_signature (contract_id, org_id, person_id)
           VALUES ($1, $2, $3)`,
          [contractId, orgId, personId],
        );
        await appendAuditEvent(client, {
          projectId: contract.project_id,
          actor,
          category: 'contracting',
          type: 'contracting.contract.signature_added',
          scope: { type: 'contract', id: contractId },
          object: { type: 'contract', id: contractId },
          payload: { org_id: orgId, person_id: personId },
          channel: actor.channel,
        });
        if (becomesSigned) {
          try {
            await client.query(
              `UPDATE contracting.contract SET status = 'signed', version = version + 1
                WHERE id = $1 AND status = 'draft'`,
              [contractId],
            );
          } catch (err) {
            // C3: the one-live-prime partial unique index (0001) fires here
            // if a second prime would go live on the project.
            if (err.code === '23505' && err.constraint === 'contract_one_live_prime') {
              throw new ProblemError('invalid_transition', 'this project already has a live prime contract');
            }
            throw err;
          }
          await appendAuditEvent(client, {
            projectId: contract.project_id,
            actor,
            category: 'contracting',
            type: 'contracting.contract.signed',
            scope: { type: 'contract', id: contractId },
            object: { type: 'contract', id: contractId },
            payload: {
              kind: contract.kind,
              client_org_id: contract.client_org_id,
              supplier_org_id: contract.supplier_org_id,
            },
            channel: actor.channel,
          });
          // Consumers (doc 10): project → participation, planning → bind
          // roots + baseline the branch, reputation, billing.
          await publishEvent(client, {
            event_id: randomUUID(),
            type: 'contracting.contract.signed',
            project_id: contract.project_id,
            actor: { person_id: actor.personId, org_id: actor.orgId },
            scope: { type: 'contract', id: contractId },
            data: {
              kind: contract.kind,
              client_org_id: contract.client_org_id,
              supplier_org_id: contract.supplier_org_id,
            },
          });
        }
        return loadContract(client, contractId);
      });
    },

    // ── money-flow reads (phase 5) ────────────────────────────────────────
    /** Guard for receiveProvisionally: quality owns writes, a read is fine. */
    async hasOpenNonConformities(contractId) {
      const { rows } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM quality.nonconformity
                         WHERE contract_id = $1 AND status <> 'closed') AS open`,
        [contractId],
      );
      return rows[0].open;
    },

    /** Which of `ids` are live (non-superseded) lines of this contract. */
    async liveBoqItemsOf(contractId, ids) {
      const { rows } = await pool.query(
        `SELECT id, description, unit_price_cents, quantity, task_id
           FROM contracting.boq_item
          WHERE contract_id = $1 AND id = ANY($2::uuid[])
            AND superseded_by_change_order_id IS NULL`,
        [contractId, ids],
      );
      return new Map(rows.map((r) => [r.id, r]));
    },

    async getChangeOrder(changeOrderId) {
      return loadChangeOrder(pool, changeOrderId);
    },

    /** Contracts of the back-to-back chain (ruling 11), this CO's excluded. */
    async linkedChainParties(changeOrderId) {
      const { rows } = await pool.query(
        `WITH RECURSIVE chain AS (
           SELECT co.id, co.linked_change_order_id, co.contract_id
             FROM contracting.change_order co WHERE co.id = $1
           UNION
           SELECT c2.id, c2.linked_change_order_id, c2.contract_id
             FROM contracting.change_order c2
             JOIN chain ch ON c2.id = ch.linked_change_order_id OR c2.linked_change_order_id = ch.id
         )
         SELECT DISTINCT c.id AS contract_id, c.client_org_id, c.supplier_org_id
           FROM chain JOIN contracting.contract c ON c.id = chain.contract_id
          WHERE chain.id <> $1`,
        [changeOrderId],
      );
      return rows;
    },

    async getMeasurement(measurementId) {
      return loadMeasurement(pool, measurementId);
    },

    async getPayment(paymentId) {
      const { rows } = await pool.query('SELECT * FROM contracting.payment_record WHERE id = $1', [paymentId]);
      if (!rows.length) return null;
      const { rows: contracts } = await pool.query(
        'SELECT id, project_id, client_org_id, supplier_org_id, status FROM contracting.contract WHERE id = $1',
        [rows[0].contract_id],
      );
      return { payment: rows[0], contract: contracts[0] };
    },

    /** Financials — every sum in SQL so rounding is checks.sql §2 exactly. */
    async contractFinancials(contractId) {
      const { rows } = await pool.query(
        `SELECT
           coalesce((SELECT sum(round(b.quantity * b.unit_price_cents)) FROM contracting.boq_item b
                      WHERE b.contract_id = $1 AND b.superseded_by_change_order_id IS NULL), 0) AS value_cents,
           coalesce((SELECT sum(co.amount_delta_cents) FROM contracting.change_order co
                      WHERE co.contract_id = $1 AND co.status = 'approved'), 0) AS approved_changes_cents,
           coalesce((SELECT sum(m.gross_cents) FROM contracting.measurement m
                      WHERE m.contract_id = $1 AND m.status = 'approved'), 0) AS measured_cents,
           coalesce((SELECT sum(m.retention_cents) FROM contracting.measurement m
                      WHERE m.contract_id = $1 AND m.status = 'approved'), 0) AS retention_held_cents,
           coalesce((SELECT sum(p.amount_cents) FROM contracting.payment_record p
                      WHERE p.contract_id = $1 AND p.status = 'confirmed'), 0) AS paid_cents,
           coalesce((SELECT sum(p.amount_cents) FROM contracting.payment_record p
                      WHERE p.contract_id = $1 AND p.status <> 'confirmed'), 0) AS outstanding_cents`,
        [contractId],
      );
      const r = rows[0];
      return {
        valueCents: r.value_cents, approvedChangesCents: r.approved_changes_cents,
        measuredCents: r.measured_cents, retentionHeldCents: r.retention_held_cents,
        paidCents: r.paid_cents, outstandingCents: r.outstanding_cents,
      };
    },

    /** Suggested quantities: remaining quantity of lines whose row was
     * verified in the period. No verification data → no lines (keep simple). */
    async suggestMeasurementLines(contractId, period) {
      const { rows } = await pool.query(
        `SELECT b.id AS boq_item_id, b.description, b.unit_price_cents,
                greatest(b.quantity - coalesce((
                  SELECT sum(ml.quantity_this_period)
                    FROM contracting.measurement_line ml
                    JOIN contracting.measurement m ON m.id = ml.measurement_id
                   WHERE ml.boq_item_id = b.id AND m.status <> 'disputed'), 0), 0) AS quantity_this_period
           FROM contracting.boq_item b
          WHERE b.contract_id = $1 AND b.superseded_by_change_order_id IS NULL
            AND b.task_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM planning.progress_report pr
                         WHERE pr.task_id = b.task_id AND pr.status = 'verified'
                           AND to_char(pr.reported_at, 'YYYY-MM') = $2)
          ORDER BY b.code`,
        [contractId, period],
      );
      return rows;
    },

    /** Owner cash-flow: expected/declared payments of OWNER-LEVEL contracts
     * only (client = owner org). Sub-level payments never roll up (V3). */
    async ownerCashFlow(projectId, ownerOrgId, { from, to }) {
      const { rows } = await pool.query(
        `SELECT p.due_date, p.contract_id, o.legal_name AS supplier, p.amount_cents, p.status
           FROM contracting.payment_record p
           JOIN contracting.contract c ON c.id = p.contract_id
           JOIN identity.organization o ON o.id = c.supplier_org_id
          WHERE c.project_id = $1 AND c.client_org_id = $2
            AND p.status IN ('expected', 'declared_paid')
            AND ($3::date IS NULL OR p.due_date >= $3::date)
            AND ($4::date IS NULL OR p.due_date <= $4::date)
          ORDER BY p.due_date, p.id`,
        [projectId, ownerOrgId, from, to],
      );
      return rows;
    },

    // ── money-flow writes (ledger + outbox same client — §6.3/§6.4) ────────
    async sponsorContract({ contractId, sponsorOrgId, sponsoredOrgId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE contracting.contract SET sponsored_by_org_id = $2, version = version + 1
            WHERE id = $1 AND sponsored_by_org_id IS NULL
            RETURNING project_id`,
          [contractId, sponsorOrgId],
        );
        if (!rows.length) throw new ProblemError('invalid_transition', 'this contract is already sponsored');
        // billing.sponsorship is billing's table, but sponsorship is DECLARED
        // here (doc 07): the row is written with the contract stamp in one
        // transaction — the billing module reads it, it never re-derives it.
        await client.query(
          `INSERT INTO billing.sponsorship (contract_id, sponsor_org_id, sponsored_org_id)
           VALUES ($1, $2, $3)`,
          [contractId, sponsorOrgId, sponsoredOrgId],
        );
        await moneyEvent(client, {
          projectId: rows[0].project_id, contractId, actor,
          type: 'contracting.contract.sponsored', objectType: 'contract', objectId: contractId,
          payload: { sponsor_org_id: sponsorOrgId, sponsored_org_id: sponsoredOrgId },
          data: { sponsor_org_id: sponsorOrgId, sponsored_org_id: sponsoredOrgId },
        });
        return loadContract(client, contractId);
      });
    },

    async transitionContract({ contractId, from, to, eventType, actor, note }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE contracting.contract SET status = $3, version = version + 1
            WHERE id = $1 AND status = $2
            RETURNING project_id`,
          [contractId, from, to],
        );
        if (!rows.length) throw new ProblemError('version_conflict', 'the contract moved first — reload');
        await moneyEvent(client, {
          projectId: rows[0].project_id, contractId, actor,
          type: eventType, objectType: 'contract', objectId: contractId,
          payload: { from, to, ...(note ? { note } : {}) },
          data: { from, to },
        });
        return loadContract(client, contractId);
      });
    },

    async createChangeOrder({ id, contractId, projectId, kind, reason, lines, time, linkedChangeOrderId, fromVariationIds, idempotencyKey, actor }) {
      return tx(async (client) => {
        // serialize numbering per contract (ruling 9: sequential int-as-text)
        await client.query('SELECT 1 FROM contracting.contract WHERE id = $1 FOR UPDATE', [contractId]);
        const { rows: numbered } = await client.query(
          `SELECT (coalesce(max(number::int), 0) + 1)::text AS number
             FROM contracting.change_order WHERE contract_id = $1`,
          [contractId],
        );
        await client.query(
          `INSERT INTO contracting.change_order
             (id, contract_id, number, kind, reason, linked_change_order_id, from_variation_ids,
              proposed_by_org_id, proposed_by_person_id, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, contractId, numbered[0].number, kind, reason, linkedChangeOrderId,
            fromVariationIds, actor.orgId, actor.personId, idempotencyKey],
        );
        for (const l of lines) {
          await client.query(
            `INSERT INTO contracting.change_order_line (id, change_order_id, op, boq_item_id, new_line)
             VALUES ($1,$2,$3,$4,$5)`,
            [randomUUID(), id, l.op, l.boqItemId, l.newLine ? JSON.stringify(l.newLine) : null],
          );
        }
        for (const t of time) {
          await client.query(
            `INSERT INTO contracting.change_order_time (change_order_id, task_id, new_baseline_start, new_baseline_finish)
             VALUES ($1,$2,$3,$4)`,
            [id, t.taskId, t.newBaselineStart, t.newBaselineFinish],
          );
        }
        await moneyEvent(client, {
          projectId, contractId, actor,
          type: 'contracting.change_order.created', objectType: 'change_order', objectId: id,
          payload: { number: numbered[0].number, kind, reason, lines: lines.length, time: time.length },
          data: { change_order_id: id, contract_id: contractId, number: numbered[0].number, kind },
        });
        return loadChangeOrder(client, id);
      });
    },

    /** submit / withdraw — the note is LEDGERED ONLY (ruling 10): decided_*
     * stays NULL, the DB CHECK ties those columns to approved/rejected. */
    async transitionChangeOrder({ changeOrderId, to, eventType, note, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE contracting.change_order SET status = $2, version = version + 1
            WHERE id = $1 AND status IN ('draft', 'submitted')
            RETURNING contract_id`,
          [changeOrderId, to],
        );
        if (!rows.length) throw new ProblemError('version_conflict', 'the change order moved first — reload');
        const { rows: contracts } = await client.query(
          'SELECT project_id FROM contracting.contract WHERE id = $1', [rows[0].contract_id],
        );
        await moneyEvent(client, {
          projectId: contracts[0].project_id, contractId: rows[0].contract_id, actor,
          type: eventType, objectType: 'change_order', objectId: changeOrderId,
          payload: { to, ...(note ? { note } : {}) },
          data: { change_order_id: changeOrderId, contract_id: rows[0].contract_id, to },
        });
        return loadChangeOrder(client, changeOrderId);
      });
    },

    /**
     * Approve / reject, ONE transaction. On approve the BoQ delta is applied
     * by SUPERSEDE + INSERT — never an in-place UPDATE of quantity/price
     * (trigger boq_freeze_guard raises) — the contract value is recomputed
     * from the live lines, and the revision bumps. The event carries the
     * time[] entries so planning re-baselines from it (doc 10).
     */
    async decideChangeOrder({ changeOrderId, approve, note, actor }) {
      return tx(async (client) => {
        const { rows: cos } = await client.query(
          'SELECT * FROM contracting.change_order WHERE id = $1 FOR UPDATE', [changeOrderId],
        );
        const co = cos[0];
        if (!co || co.status !== 'submitted') {
          throw new ProblemError('version_conflict', 'the change order moved first — reload');
        }
        const { rows: contracts } = await client.query(
          'SELECT * FROM contracting.contract WHERE id = $1 FOR UPDATE', [co.contract_id],
        );
        const contract = contracts[0];

        let amountDelta = 0;
        if (approve) {
          const { rows: lines } = await client.query(
            'SELECT * FROM contracting.change_order_line WHERE change_order_id = $1 ORDER BY id', [changeOrderId],
          );
          for (const line of lines) {
            let supersededTaskId = null;
            if (line.op !== 'add') {
              const { rows: old } = await client.query(
                `UPDATE contracting.boq_item SET superseded_by_change_order_id = $2
                  WHERE id = $1 AND superseded_by_change_order_id IS NULL
                  RETURNING task_id, round(quantity * unit_price_cents) AS amount`,
                [line.boq_item_id, changeOrderId],
              );
              if (!old.length) {
                throw new ProblemError('version_conflict', `line ${line.boq_item_id} was already superseded by another change order`);
              }
              supersededTaskId = old[0].task_id;
              amountDelta -= Number(old[0].amount);
            }
            if (line.op !== 'remove') {
              const n = line.new_line;
              try {
                const { rows: added } = await client.query(
                  `INSERT INTO contracting.boq_item
                     (id, project_id, contract_id, task_id, code, description, unit, quantity,
                      unit_price_cents, material_spec, introduced_by_change_order_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                   RETURNING round(quantity * unit_price_cents) AS amount`,
                  [n.id, contract.project_id, contract.id, n.task_id ?? supersededTaskId,
                    n.code, n.description, n.unit, n.quantity, n.unit_price.amount_cents,
                    n.material_spec ?? null, changeOrderId],
                );
                amountDelta += Number(added[0].amount);
              } catch (err) {
                if (err.code === '23505') {
                  // boq_code_per_contract: the superseded row keeps its code
                  throw new ProblemError('validation_failed', null, {
                    errors: { lines: `new_line code ${JSON.stringify(n.code)} already exists on this contract — supersession keeps the old row; give the new line its own code` },
                  });
                }
                throw err;
              }
            }
          }
          await client.query(
            `UPDATE contracting.contract
                SET value_cents = coalesce((SELECT sum(round(b.quantity * b.unit_price_cents))
                                              FROM contracting.boq_item b
                                             WHERE b.contract_id = $1
                                               AND b.superseded_by_change_order_id IS NULL), 0),
                    revision = revision + 1,
                    version = version + 1
              WHERE id = $1`,
            [contract.id],
          );
        }
        await client.query(
          `UPDATE contracting.change_order
              SET status = $2, decided_by_org_id = $3, decided_by_person_id = $4,
                  decided_at = now(), decision_note = $5, amount_delta_cents = $6,
                  version = version + 1
            WHERE id = $1`,
          [changeOrderId, approve ? 'approved' : 'rejected', actor.orgId, actor.personId, note, amountDelta],
        );
        const { rows: time } = await client.query(
          `SELECT task_id, to_char(new_baseline_start,'YYYY-MM-DD') AS new_baseline_start,
                  to_char(new_baseline_finish,'YYYY-MM-DD') AS new_baseline_finish
             FROM contracting.change_order_time WHERE change_order_id = $1 ORDER BY task_id`,
          [changeOrderId],
        );
        await moneyEvent(client, {
          projectId: contract.project_id, contractId: contract.id, actor,
          type: approve ? 'contracting.change_order.approved' : 'contracting.change_order.rejected',
          objectType: 'change_order', objectId: changeOrderId,
          payload: {
            number: co.number, amount_delta_cents: amountDelta,
            ...(note ? { note } : {}), time_entries: time.length,
          },
          data: {
            change_order_id: changeOrderId, contract_id: contract.id,
            amount_delta_cents: amountDelta,
            time,
            from_variation_ids: co.from_variation_ids ?? [],
          },
        });
        return loadChangeOrder(client, changeOrderId);
      });
    },

    /** Create (as SUBMITTED) — or revise a DISPUTED one for the same period
     * back to submitted (doc 09). A live duplicate period answers 409. */
    async createMeasurement({ id, contractId, projectId, period, lines, grossCents, retentionCents, netCents, actor }) {
      return tx(async (client) => {
        const { rows: existing } = await client.query(
          'SELECT id, status FROM contracting.measurement WHERE contract_id = $1 AND period = $2 FOR UPDATE',
          [contractId, period],
        );
        let measurementId = id;
        if (existing.length) {
          if (existing[0].status !== 'disputed') {
            throw new ProblemError('version_conflict', `a measurement for ${period} already exists`);
          }
          // revision keeps the standing row's identity: the period is the key
          measurementId = existing[0].id;
          await client.query('DELETE FROM contracting.measurement_line WHERE measurement_id = $1', [measurementId]);
          await client.query(
            `UPDATE contracting.measurement
                SET status = 'submitted', gross_cents = $2, retention_cents = $3, net_cents = $4,
                    submitted_by_person_id = $5
              WHERE id = $1`,
            [measurementId, grossCents, retentionCents, netCents, actor.personId],
          );
        } else {
          await client.query(
            `INSERT INTO contracting.measurement
               (id, contract_id, period, status, gross_cents, retention_cents, net_cents, submitted_by_person_id)
             VALUES ($1,$2,$3,'submitted',$4,$5,$6,$7)`,
            [measurementId, contractId, period, grossCents, retentionCents, netCents, actor.personId],
          );
        }
        for (const l of lines) {
          await client.query(
            `INSERT INTO contracting.measurement_line (measurement_id, boq_item_id, quantity_this_period)
             VALUES ($1,$2,$3)`,
            [measurementId, l.boqItemId, l.quantityThisPeriod],
          );
        }
        await moneyEvent(client, {
          projectId, contractId, actor,
          type: 'contracting.measurement.submitted', objectType: 'measurement', objectId: measurementId,
          payload: { period, gross_cents: grossCents, net_cents: netCents, revised: existing.length > 0 },
          data: { measurement_id: measurementId, contract_id: contractId, period, net_cents: netCents },
        });
        return loadMeasurement(client, measurementId);
      });
    },

    /** Approve → the EXPECTED payment, one transaction (ruling 3: due =
     * approval date + contract.payment_days). Milestone minting is OUT
     * (ruling 2) — payments here always hang off a measurement. */
    async approveMeasurement({ measurementId, paymentDays, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE contracting.measurement
              SET status = 'approved', approved_by_person_id = $2, approved_at = now()
            WHERE id = $1 AND status = 'submitted'
            RETURNING contract_id, period, net_cents`,
          [measurementId, actor.personId],
        );
        if (!rows.length) throw new ProblemError('version_conflict', 'the measurement moved first — reload');
        const m = rows[0];
        const { rows: contracts } = await client.query(
          'SELECT project_id FROM contracting.contract WHERE id = $1', [m.contract_id],
        );
        const paymentId = randomUUID();
        const { rows: payments } = await client.query(
          `INSERT INTO contracting.payment_record (id, contract_id, measurement_id, amount_cents, due_date, status)
           VALUES ($1, $2, $3, $4, current_date + $5::int, 'expected')
           RETURNING to_char(due_date,'YYYY-MM-DD') AS due_date`,
          [paymentId, m.contract_id, measurementId, m.net_cents, paymentDays],
        );
        await moneyEvent(client, {
          projectId: contracts[0].project_id, contractId: m.contract_id, actor,
          type: 'contracting.measurement.approved', objectType: 'measurement', objectId: measurementId,
          payload: { period: m.period, net_cents: Number(m.net_cents), payment_id: paymentId, due_date: payments[0].due_date },
          data: { measurement_id: measurementId, contract_id: m.contract_id, payment_id: paymentId, net_cents: Number(m.net_cents), due_date: payments[0].due_date },
        });
        return loadMeasurement(client, measurementId);
      });
    },

    async disputeMeasurement({ measurementId, note, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE contracting.measurement SET status = 'disputed'
            WHERE id = $1 AND status = 'submitted'
            RETURNING contract_id, period`,
          [measurementId],
        );
        if (!rows.length) throw new ProblemError('version_conflict', 'the measurement moved first — reload');
        const { rows: contracts } = await client.query(
          'SELECT project_id FROM contracting.contract WHERE id = $1', [rows[0].contract_id],
        );
        await moneyEvent(client, {
          projectId: contracts[0].project_id, contractId: rows[0].contract_id, actor,
          type: 'contracting.measurement.disputed', objectType: 'measurement', objectId: measurementId,
          payload: { period: rows[0].period, ...(note ? { note } : {}) },
          data: { measurement_id: measurementId, contract_id: rows[0].contract_id, period: rows[0].period },
        });
        return loadMeasurement(client, measurementId);
      });
    },

    async transitionPayment({ paymentId, to, eventType, note, actor }) {
      return tx(async (client) => {
        const stamps = {
          declared_paid: ', declared_paid_at = now(), declared_by_person_id = $3',
          confirmed: ', confirmed_at = now(), confirmed_by_person_id = $3',
          disputed: '',
        }[to];
        const params = to === 'disputed' ? [paymentId, to] : [paymentId, to, actor.personId];
        const { rows } = await client.query(
          `UPDATE contracting.payment_record SET status = $2${stamps}
            WHERE id = $1 AND status IN ('expected', 'declared_paid', 'disputed')
            RETURNING contract_id`,
          params,
        );
        if (!rows.length) throw new ProblemError('version_conflict', 'the payment moved first — reload');
        const { rows: contracts } = await client.query(
          'SELECT project_id FROM contracting.contract WHERE id = $1', [rows[0].contract_id],
        );
        await moneyEvent(client, {
          projectId: contracts[0].project_id, contractId: rows[0].contract_id, actor,
          type: eventType, objectType: 'payment_record', objectId: paymentId,
          payload: { to, ...(note ? { note } : {}) },
          data: { payment_id: paymentId, contract_id: rows[0].contract_id, to },
        });
        const { rows: payments } = await client.query('SELECT * FROM contracting.payment_record WHERE id = $1', [paymentId]);
        return payments[0];
      });
    },

    /**
     * Consumer of planning.progress.reported (application/consumers.mjs):
     * work starting on a branch row activates its signed contract and every
     * signed ancestor. Idempotent — the status = 'signed' filter absorbs
     * replays; terminated contracts are never touched (ruling 16).
     */
    async activateContractsForTask({ taskId, projectId, actor }) {
      return tx(async (client) => {
        const { rows: chain } = await client.query(
          `WITH RECURSIVE up AS (
             SELECT c.id, c.parent_contract_id FROM contracting.contract c
              WHERE c.id = (SELECT coalesce(contract_id, branch_contract_id)
                              FROM planning.task WHERE id = $1)
             UNION ALL
             SELECT p.id, p.parent_contract_id
               FROM contracting.contract p JOIN up ON p.id = up.parent_contract_id
           ) SELECT id FROM up`,
          [taskId],
        );
        const activated = [];
        for (const { id } of chain) {
          const { rows } = await client.query(
            `UPDATE contracting.contract SET status = 'active', version = version + 1
              WHERE id = $1 AND status = 'signed' RETURNING id`,
            [id],
          );
          if (!rows.length) continue;
          await moneyEvent(client, {
            projectId, contractId: id, actor: { ...actor, channel: 'system' },
            type: 'contracting.contract.activated', objectType: 'contract', objectId: id,
            payload: { cause_task_id: taskId },
            data: { from: 'signed', to: 'active', cause_task_id: taskId },
          });
          activated.push(id);
        }
        return { activated };
      });
    },

    // ── idempotency (POST …/contracts) ───────────────────────────────────
    async idempotent(meta, fn) {
      if (!meta.key) return fn();
      return tx((client) => withIdempotency(client, meta, fn));
    },
  };
}

/** Shape a joined row into what use-cases/domain expect. */
function bundle(row, signatures = []) {
  const {
    client_kind, client_legal_name, client_nif,
    supplier_kind, supplier_legal_name, supplier_nif,
    value_cents_live, root_task_ids, ...contract
  } = row;
  return {
    contract,
    client: { id: contract.client_org_id, kind: client_kind, legal_name: client_legal_name, nif: client_nif },
    supplier: { id: contract.supplier_org_id, kind: supplier_kind, legal_name: supplier_legal_name, nif: supplier_nif },
    roots: root_task_ids,
    signatures,
    valueCents: value_cents_live,
  };
}
