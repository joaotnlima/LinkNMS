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
