// Postgres store for the billing module (schema: billing.*, db/v2 0001 +
// catalogue seed 0006).
//
// Owns its transactions. Billing is platform housekeeping, so writes are NOT
// ledgered (doc 10 lists no billing.* ledger row); the one listed event —
// `billing.subscription.changed` (consumer: IAM cache) — is published on the
// SAME client as the subscription write, scope org_private. Cross-schema
// READS (project participation, identity memberships, tendering RFPs,
// contracting contracts for sponsorship) are query ports for the usage
// counters; it never WRITES outside billing.*.
//
// provider_ref stays NULL on every row this store writes: no charging
// provider is registered — open question 17. A provider adapter later fills
// provider_ref and drives status through the webhook, behind the same port.
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';
import { withIdempotency } from '../../../platform/idempotency.mjs';

export function createBillingStore(pool) {
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

  /** doc 10: billing.subscription.changed — org-private, never ledgered. */
  async function publishChanged(client, row, actor) {
    await publishEvent(client, {
      event_id: randomUUID(),
      type: 'billing.subscription.changed',
      project_id: null,
      actor: { person_id: actor.personId, org_id: actor.orgId },
      scope: { type: 'org_private', id: row.org_id },
      data: { subscription_id: row.id, plan_code: row.plan_code, status: row.status },
    });
  }

  return {
    // ── reads ────────────────────────────────────────────────────────────
    async getPersonByClerkId(clerkUserId) {
      const { rows } = await pool.query('SELECT * FROM identity.person WHERE clerk_user_id = $1', [clerkUserId]);
      return rows[0] ?? null;
    },

    async getPlan(code) {
      const { rows } = await pool.query('SELECT * FROM billing.plan WHERE code = $1', [code]);
      return rows[0] ?? null;
    },

    /** The catalogue for one org kind, keyset-paged on code. */
    async listPlans({ orgKind, cursor = null, limit = 50 }) {
      const { rows } = await pool.query(
        `SELECT * FROM billing.plan
          WHERE org_kind = $1 AND ($2::text IS NULL OR code > $2)
          ORDER BY code
          LIMIT $3`,
        [orgKind, cursor, limit + 1],
      );
      const items = rows.slice(0, limit);
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].code : null };
    },

    async getSubscription(id) {
      const { rows } = await pool.query('SELECT * FROM billing.subscription WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async getSubscriptionByOrg(orgId) {
      const { rows } = await pool.query('SELECT * FROM billing.subscription WHERE org_id = $1', [orgId]);
      return rows[0] ?? null;
    },

    /**
     * Add-on top-up for one kind, current period. Periods are calendar
     * months ('YYYY-MM') — the granularity add-ons are sold at while no
     * provider drives real billing cycles (open question 17).
     */
    async addOnQuantity(orgId, kind) {
      const { rows } = await pool.query(
        `SELECT coalesce(sum(quantity), 0) AS total
           FROM billing.add_on
          WHERE org_id = $1 AND kind = $2 AND period = to_char(now(), 'YYYY-MM')`,
        [orgId, kind],
      );
      return Number(rows[0].total);
    },

    /**
     * Doc 04 §4 Sponsorship: a live sponsorship whose contract belongs to
     * `projectId` covers the sponsored org's project-scoped entitlements.
     */
    async sponsorshipCovers(orgId, projectId) {
      const { rows } = await pool.query(
        `SELECT 1
           FROM billing.sponsorship s
           JOIN contracting.contract c ON c.id = s.contract_id
          WHERE s.sponsored_org_id = $1 AND c.project_id = $2
            AND now() >= s.starts_at AND now() < coalesce(s.ends_at, 'infinity')
          LIMIT 1`,
        [orgId, projectId],
      );
      return rows.length > 0;
    },

    /**
     * What is countable today, honestly but cheaply (phase-8 brief):
     *   projects:active   — projects the org actively participates in that
     *                       are not closed/cancelled (project.participation);
     *   seats             — active org memberships (identity.org_membership;
     *                       the Clerk mirror is the staffing source of truth);
     *   rfp:open-credits  — open-visibility RFPs the org took out of draft
     *                       this calendar month (tendering.rfp has no
     *                       published_at, so created_at approximates the
     *                       period — same month in practice, and the honest
     *                       cheap answer until publication is timestamped).
     */
    async usage(orgId) {
      const { rows } = await pool.query(
        `SELECT
           (SELECT count(DISTINCT p.project_id)
              FROM project.participation p
              JOIN project.project pr ON pr.id = p.project_id
             WHERE p.org_id = $1 AND p.status = 'active'
               AND pr.status NOT IN ('closed', 'cancelled')) AS projects_active,
           (SELECT count(*) FROM identity.org_membership
             WHERE org_id = $1 AND status = 'active') AS seats,
           (SELECT count(*) FROM tendering.rfp
             WHERE issuer_org_id = $1 AND visibility = 'open' AND status <> 'draft'
               AND created_at >= date_trunc('month', now())) AS open_rfps`,
        [orgId],
      );
      const r = rows[0];
      return {
        'projects:active': Number(r.projects_active),
        seats: Number(r.seats),
        'rfp:open-credits': Number(r.open_rfps),
      };
    },

    // ── writes (event on the same client; no ledger — doc 10) ────────────

    /**
     * Create the org's subscription, replacing a canceled slot in place
     * (org_id UNIQUE). The lock re-checks liveness so a concurrent subscribe
     * cannot slip past the use case's pre-check.
     */
    async subscribe({ id, orgId, planCode, interval, actor }) {
      return tx(async (client) => {
        const { rows: existing } = await client.query(
          'SELECT * FROM billing.subscription WHERE org_id = $1 FOR UPDATE',
          [orgId],
        );
        if (existing[0] && existing[0].status !== 'canceled') {
          // The use case pre-checked; this is the race guard under the lock.
          throw new ProblemError('invalid_transition', 'this organisation already has a subscription — change or cancel it instead');
        }
        // Period end from the plan interval; interval 'project' has none
        // (it runs with the build). provider_ref NULL: manual mode.
        const { rows } = await client.query(
          `INSERT INTO billing.subscription (id, org_id, plan_code, status, current_period_end, provider_ref)
           VALUES ($1, $2, $3, 'active',
                   CASE $4 WHEN 'month' THEN now() + interval '1 month'
                           WHEN 'year'  THEN now() + interval '1 year'
                           ELSE NULL END,
                   NULL)
           ON CONFLICT (org_id) DO UPDATE
             SET plan_code = EXCLUDED.plan_code,
                 status = 'active',
                 current_period_end = EXCLUDED.current_period_end,
                 provider_ref = NULL
           RETURNING *`,
          [id, orgId, planCode, interval],
        );
        await publishChanged(client, rows[0], actor);
        return rows[0];
      });
    },

    /** Change the plan only — status and period end stay (phase-8 brief). */
    async changePlan({ subscriptionId, planCode, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          'UPDATE billing.subscription SET plan_code = $2 WHERE id = $1 RETURNING *',
          [subscriptionId, planCode],
        );
        if (!rows[0]) return null;
        await publishChanged(client, rows[0], actor);
        return rows[0];
      });
    },

    /** Cancel; the row stays (org_id UNIQUE slot) so reads keep answering. */
    async cancel({ subscriptionId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE billing.subscription SET status = 'canceled' WHERE id = $1 RETURNING *`,
          [subscriptionId],
        );
        if (!rows[0]) return null;
        await publishChanged(client, rows[0], actor);
        return rows[0];
      });
    },

    /** An add-on purchase — no doc-10 event, plain insert for this period. */
    async addAddOn({ id, orgId, kind, quantity }) {
      const { rows } = await pool.query(
        `INSERT INTO billing.add_on (id, org_id, kind, quantity, period)
         VALUES ($1, $2, $3, $4, to_char(now(), 'YYYY-MM'))
         RETURNING *`,
        [id, orgId, kind, quantity],
      );
      return rows[0];
    },

    // ── idempotency (POST commands with a body) ──────────────────────────
    async idempotent(meta, fn) {
      if (!meta.key) return fn();
      return tx((client) => withIdempotency(client, meta, fn));
    },
  };
}
