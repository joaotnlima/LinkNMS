// Postgres store for the directory module (schema directory.*, db/v2 0001 +
// 0022). Owns its transactions; touches no other schema.
//
// Directory writes are not ledgered: a profile is the organisation's own
// public page, not a fact of a build (the ledger is project-scoped, doc 08),
// and the read model only mirrors facts other modules already ledgered.
// Directory publishes one event (to-be/10, PRD-04): directory.profile.claimed,
// on the outbox in the claim transaction.
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';
import { withIdempotency } from '../../../platform/idempotency.mjs';
import { slugCandidate } from '../domain/profile.mjs';
import { createRecordStore } from './pg-record.mjs';

const SLUG_ATTEMPTS = 50;

export function createDirectoryStore(pool) {
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

  /** INSERT with the first free slug candidate; a lost race tries the next. */
  async function insertWithSlug(slugBase, insert) {
    const { rows: taken } = await pool.query(
      `SELECT slug FROM directory.organization_profile WHERE slug = $1 OR slug LIKE $2`,
      [slugBase, `${slugBase}-%`],
    );
    const used = new Set(taken.map((r) => r.slug));
    for (let n = 1; n <= SLUG_ATTEMPTS; n += 1) {
      const slug = slugCandidate(slugBase, n);
      if (used.has(slug)) continue;
      try {
        return await insert(slug);
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'organization_profile_slug_unique') continue;
        if (err.code === '23505' && err.constraint === 'organization_profile_pkey') {
          throw new ProblemError('version_conflict', 'the profile was created meanwhile — reload');
        }
        throw err;
      }
    }
    throw new Error(`no free slug for ${slugBase}`);
  }

  return {
    ...createRecordStore(pool, tx),

    // ── taxonomy ─────────────────────────────────────────────────────────
    async listSpecialties() {
      const { rows } = await pool.query(
        `SELECT code, name_pt, name_en, parent_code, position, impic_ref
           FROM directory.specialty ORDER BY position, code`,
      );
      return rows;
    },

    // ── profiles ─────────────────────────────────────────────────────────
    async getProfileByOrg(orgId) {
      const { rows } = await pool.query(
        `SELECT *, to_char(available_from, 'YYYY-MM-DD') AS available_from
           FROM directory.organization_profile WHERE org_id = $1`,
        [orgId],
      );
      return rows[0] ?? null;
    },

    async insertProfile({ orgId, kind, slugBase, value, completeness }) {
      return insertWithSlug(slugBase, async (slug) => {
        const { rows } = await pool.query(
          `INSERT INTO directory.organization_profile
             (org_id, slug, kind, claimed, ${WRITE_COLUMNS.join(', ')}, completeness)
           VALUES ($1, $2, $3, true, ${WRITE_COLUMNS.map((_, i) => `$${i + 4}`).join(', ')}, $${WRITE_COLUMNS.length + 4})
           RETURNING *, to_char(available_from, 'YYYY-MM-DD') AS available_from`,
          [orgId, slug, kind, ...writeValues(value), completeness],
        );
        return rows[0];
      });
    },

    async updateProfile({ orgId, expectedVersion, value, completeness }) {
      const sets = WRITE_COLUMNS.map((c, i) => `${c} = $${i + 3}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE directory.organization_profile
            SET ${sets}, completeness = $${WRITE_COLUMNS.length + 3}, updated_at = now(), version = version + 1
          WHERE org_id = $1 AND version = $2
          RETURNING *, to_char(available_from, 'YYYY-MM-DD') AS available_from`,
        [orgId, expectedVersion, ...writeValues(value), completeness],
      );
      return rows[0] ?? null;
    },

    async setCompleteness({ orgId, completeness }) {
      await pool.query(
        'UPDATE directory.organization_profile SET completeness = $2 WHERE org_id = $1',
        [orgId, completeness],
      );
    },

    /** One unclaimed, listed profile per e-mail (PRD-04 seed port). */
    async insertUnclaimedProfile({ orgId, displayName, contactEmail, slugBase, specialties }) {
      const { rows: existing } = await pool.query(
        `SELECT * FROM directory.organization_profile WHERE contact_email = $1 AND NOT claimed`,
        [contactEmail],
      );
      if (existing.length) return existing[0];
      // An address whose profile was already claimed is that company now: no
      // second, unclaimed profile for it (PRD-04 X-2 seeds on every send).
      const { rows: claimed } = await pool.query(
        `SELECT p.* FROM directory.profile_claim c
           JOIN directory.organization_profile p ON p.org_id = c.claimant_org_id
          WHERE lower(c.sent_to) = $1 AND c.accepted_at IS NOT NULL
          ORDER BY c.accepted_at DESC LIMIT 1`,
        [contactEmail],
      );
      if (claimed.length) return claimed[0];
      return insertWithSlug(slugBase, async (slug) => {
        const { rows } = await pool.query(
          `INSERT INTO directory.organization_profile
             (org_id, slug, display_name, claimed, contact_email, specialties, listed)
           VALUES ($1, $2, $3, false, $4, $5, true)
           RETURNING *`,
          [orgId, slug, displayName, contactEmail, specialties],
        );
        return rows[0];
      });
    },

    // ── portfolio ────────────────────────────────────────────────────────
    /** Public: stated entries + platform entries with consent; `all` for the owner's editor. */
    async listPortfolio(orgId, { all = false } = {}) {
      const { rows } = await pool.query(
        `SELECT id, org_id, source, contract_id, title, municipality_code, typology, specialties,
                to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
                variance_wd, photo_document_ids, owner_consent
           FROM directory.portfolio_entry
          WHERE org_id = $1 AND ($2::boolean OR source = 'declared' OR owner_consent)
          ORDER BY end_date DESC NULLS LAST, created_at DESC`,
        [orgId, all],
      );
      return rows;
    },

    /**
     * The editor's list (listMyPortfolio): every entry, newest end first;
     * keyset on (end_date or -infinity, created_at, id), all descending.
     */
    async listPortfolioPage(orgId, { cursor = null, limit = 50 } = {}) {
      const { rows } = await pool.query(
        `SELECT id, org_id, source, contract_id, title, municipality_code, typology, specialties,
                to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
                variance_wd, photo_document_ids, owner_consent,
                coalesce(to_char(end_date, 'YYYY-MM-DD'), '-infinity') AS end_key,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key
           FROM directory.portfolio_entry
          WHERE org_id = $1
            AND ($2::text IS NULL
              OR (coalesce(end_date, '-infinity'::date), created_at, id) < ($2::date, $3::timestamptz, $4::uuid))
          ORDER BY coalesce(end_date, '-infinity'::date) DESC, created_at DESC, id DESC
          LIMIT $5`,
        [orgId, cursor?.e ?? null, cursor?.c ?? null, cursor?.id ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(({ end_key: _e, created_key: _c, ...r }) => r),
        nextCursor: rows.length > limit ? { e: last.end_key, c: last.created_key, id: last.id } : null,
      };
    },

    async countPortfolio(orgId) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM directory.portfolio_entry
          WHERE org_id = $1 AND (source = 'declared' OR owner_consent)`,
        [orgId],
      );
      return rows[0].n;
    },

    async getPortfolioEntry(id) {
      const { rows } = await pool.query('SELECT * FROM directory.portfolio_entry WHERE id = $1', [id]);
      return rows[0] ?? null;
    },

    async insertPortfolioEntry({ id, orgId, title, municipalityCode, typology, specialties, startDate, endDate }) {
      const { rows } = await pool.query(
        `INSERT INTO directory.portfolio_entry
           (id, org_id, source, title, municipality_code, typology, specialties, start_date, end_date)
         VALUES ($1, $2, 'declared', $3, $4, $5, $6, $7, $8)
         RETURNING id, org_id, source, title, municipality_code, typology, specialties,
                   to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
                   variance_wd, photo_document_ids, owner_consent`,
        [id, orgId, title, municipalityCode, typology, specialties, startDate, endDate],
      );
      return rows[0];
    },

    async deletePortfolioEntry(id) {
      await pool.query(`DELETE FROM directory.portfolio_entry WHERE id = $1 AND source = 'declared'`, [id]);
    },

    // ── owner consent (R-12) ─────────────────────────────────────────────
    async getConsent(projectId) {
      const { rows } = await pool.query('SELECT * FROM directory.portfolio_consent WHERE project_id = $1', [projectId]);
      return rows[0] ?? null;
    },

    async putConsent({ projectId, ownerOrgId, showOnProfiles, buildName, note, personId }) {
      const { rows } = await pool.query(
        `INSERT INTO directory.portfolio_consent
           (project_id, owner_org_id, show_on_profiles, build_name, note, decided_by_person_id, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (project_id) DO UPDATE SET
           owner_org_id = EXCLUDED.owner_org_id, show_on_profiles = EXCLUDED.show_on_profiles,
           build_name = EXCLUDED.build_name, note = EXCLUDED.note,
           decided_by_person_id = EXCLUDED.decided_by_person_id, decided_at = now()
         RETURNING *`,
        [projectId, ownerOrgId, showOnProfiles, buildName, note, personId],
      );
      return rows[0];
    },

    // ── claims (R-16) ────────────────────────────────────────────────────
    async createClaim({ id, profileOrgId, claimantOrgId, claimantPersonId, tokenHash, sentTo, expiresAt }) {
      await pool.query(
        `INSERT INTO directory.profile_claim
           (id, profile_org_id, claimant_org_id, claimant_person_id, token_hash, sent_to, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, profileOrgId, claimantOrgId, claimantPersonId, tokenHash, sentTo, expiresAt],
      );
    },

    async findClaimByHash(tokenHash) {
      const { rows } = await pool.query('SELECT * FROM directory.profile_claim WHERE token_hash = $1', [tokenHash]);
      return rows[0] ?? null;
    },

    /**
     * Re-key the unclaimed profile to the claimant org, mark it claimed and
     * the link used — one transaction. null when the profile is no longer
     * unclaimed or the claimant has a profile of its own by now.
     */
    async acceptClaim({ claimId, profileOrgId, claimantOrgId, kind, actor = null }) {
      return tx(async (client) => {
        const { rows: used } = await client.query(
          `UPDATE directory.profile_claim SET accepted_at = now()
            WHERE id = $1 AND accepted_at IS NULL RETURNING id`,
          [claimId],
        );
        if (!used.length) return null;
        const { rows: own } = await client.query(
          'SELECT 1 FROM directory.organization_profile WHERE org_id = $1', [claimantOrgId],
        );
        if (own.length) return null;
        const { rows } = await client.query(
          `UPDATE directory.organization_profile
              SET org_id = $2, claimed = true, contact_email = NULL, kind = $3,
                  updated_at = now(), version = version + 1
            WHERE org_id = $1 AND NOT claimed
            RETURNING *, to_char(available_from, 'YYYY-MM-DD') AS available_from`,
          [profileOrgId, claimantOrgId, kind],
        );
        if (!rows.length) return null;
        await client.query('UPDATE directory.portfolio_entry SET org_id = $2 WHERE org_id = $1', [profileOrgId, claimantOrgId]);
        await client.query('UPDATE directory.listing_stat SET org_id = $2 WHERE org_id = $1', [profileOrgId, claimantOrgId]);
        // PRD-04 §6 criterion 3: tendering back-fills the organisation on every
        // past invite to the claimed address. The address travels on the
        // outbox (directory events are not ledgered) — never on the ledger.
        const { rows: sent } = await client.query('SELECT sent_to FROM directory.profile_claim WHERE id = $1', [claimId]);
        await publishEvent(client, {
          event_id: randomUUID(),
          type: 'directory.profile.claimed',
          project_id: null,
          actor: { person_id: actor?.personId ?? null, org_id: claimantOrgId },
          scope: { type: 'org_private', id: claimantOrgId },
          data: { org_id: claimantOrgId, previous_profile_id: profileOrgId, slug: rows[0].slug, email: String(sent[0].sent_to).toLowerCase() },
        });
        return rows[0];
      });
    },

    // ── listing stats (R-17) ─────────────────────────────────────────────
    async recordStat({ orgIds, kind }) {
      await pool.query(
        `INSERT INTO directory.listing_stat (org_id, day, kind, count)
         SELECT o, current_date, $2, count(*) FROM unnest($1::uuid[]) AS o GROUP BY o
         ON CONFLICT (org_id, day, kind) DO UPDATE SET count = directory.listing_stat.count + EXCLUDED.count`,
        [orgIds, kind],
      );
    },

    async listingStats({ orgId, days }) {
      const { rows } = await pool.query(
        `SELECT
           (SELECT coalesce(sum(count), 0) FROM directory.listing_stat
             WHERE org_id = $1 AND kind = 'search_impression' AND day > current_date - $2::int) AS shown_in_searches,
           (SELECT coalesce(sum(count), 0) FROM directory.listing_stat
             WHERE org_id = $1 AND kind = 'profile_view' AND day > current_date - $2::int) AS profile_views,
           (SELECT count(*) FROM directory.record_proposal
             WHERE bidder_org_id = $1 AND submitted_at > now() - make_interval(days => $2::int)) AS proposals_sent,
           (SELECT count(*) FROM directory.record_proposal
             WHERE bidder_org_id = $1 AND awarded_at > now() - make_interval(days => $2::int)) AS proposals_awarded`,
        [orgId, days],
      );
      return rows[0];
    },

    // ── idempotency (POST …/portfolio) ───────────────────────────────────
    async idempotent(meta, fn) {
      if (!meta.key) return fn();
      return tx((client) => withIdempotency(client, meta, fn));
    },
  };
}

const WRITE_COLUMNS = [
  'display_name', 'description', 'specialties', 'tags', 'service_areas',
  'base_municipality_code', 'base_lat', 'base_lng', 'service_radius_km', 'team_size_band',
  'founded_year', 'available_from', 'declared_nif', 'declared_impic_number', 'declared_impic_class',
  'declared_insurance', 'listed',
];

function writeValues(v) {
  return [
    v.displayName, v.description, v.specialties, v.tags, v.serviceAreas,
    v.base.municipalityCode, v.base.lat, v.base.lng, v.serviceRadiusKm, v.teamSizeBand,
    v.foundedYear, v.availableFrom, v.declared.nif, v.declared.impicNumber, v.declared.impicClass,
    v.declared.insurance, v.listed,
  ];
}
