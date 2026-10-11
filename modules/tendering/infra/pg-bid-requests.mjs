// Postgres part of the tendering store for PRD-04 (D-47): requests to bid on a
// listed RFP, the company inbox reads, declining an invitation, and the two
// directory links — the e-mail invitees the directory seeds unclaimed
// profiles for, and the claim back-fill. Spread into createTenderingStore's
// object like pg-clarifications.mjs; reads tendering.* only.
//
// Same rules as pg-store: every write appends its ledger entry and, where
// doc 10 lists an event, publishes it on the SAME client before commit
// (invariants §6.3/§6.4). Bidder identity stays in tendering.*: ledger
// entries of a request are scoped rfp_private and carry no organisation.
import { randomUUID, createHash, randomBytes } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';

const REQUEST_COLUMNS = `br.*, r.project_id, r.issuer_org_id, r.status AS rfp_status, r.title,
  coalesce((SELECT array_agg(task_id ORDER BY task_id) FROM tendering.rfp_root WHERE rfp_id = r.id), '{}') AS root_task_ids`;

/**
 * @param {import('pg').Pool} pool
 * @param {(fn: (client: object) => Promise<any>) => Promise<any>} tx
 */
export function bidRequestQueries(pool, tx) {
  async function ledgerAndEvent(client, { type, request, projectId, actor, data = {} }) {
    await appendAuditEvent(client, {
      projectId, actor,
      category: 'tendering',
      type,
      scope: { type: 'rfp_private', id: request.id },
      object: { type: 'bid_request', id: request.id },
      payload: { rfp_id: request.rfp_id, bid_request_id: request.id, ...data },
      channel: actor.channel,
    });
    await publishEvent(client, {
      event_id: randomUUID(),
      type,
      project_id: projectId,
      actor: { person_id: actor.personId, org_id: actor.orgId },
      scope: { type: 'rfp_private', id: request.id },
      data: { rfp_id: request.rfp_id, bid_request_id: request.id, org_id: request.org_id, ...data },
    });
  }

  return {
    async getBidRequest(id) {
      const { rows } = await pool.query(
        `SELECT ${REQUEST_COLUMNS} FROM tendering.bid_request br
           JOIN tendering.rfp r ON r.id = br.rfp_id WHERE br.id = $1`,
        [id],
      );
      return rows[0] ?? null;
    },

    /** Pending first, newest first; keyset on (pending, requested_at, id). */
    async listBidRequests(rfpId, { cursor = null, limit = 50 } = {}) {
      const { rows } = await pool.query(
        `SELECT *, (status = 'pending')::int AS pending_rank,
                to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_key
           FROM tendering.bid_request
          WHERE rfp_id = $1
            AND ($2::int IS NULL
              OR (status = 'pending')::int < $2::int
              OR ((status = 'pending')::int = $2::int
                  AND (requested_at < $3::timestamptz OR (requested_at = $3::timestamptz AND id > $4::uuid))))
          ORDER BY (status = 'pending') DESC, requested_at DESC, id
          LIMIT $5`,
        [rfpId, cursor?.p ?? null, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: rows.length > limit ? { p: last.pending_rank, at: last.requested_key, id: last.id } : null,
      };
    },

    /** The org's requests on the given RFPs (the open-requests read). */
    async bidRequestsOfOrg(orgId, rfpIds) {
      if (!rfpIds.length) return [];
      const { rows } = await pool.query(
        'SELECT * FROM tendering.bid_request WHERE org_id = $1 AND rfp_id = ANY($2::uuid[])',
        [orgId, rfpIds],
      );
      return rows;
    },

    /**
     * Ask to bid (D-47). Idempotent on (rfp, org): a repeat returns the stored
     * request with created=false and writes nothing.
     */
    async createBidRequest({ id, rfpId, projectId, orgId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO tendering.bid_request (id, rfp_id, org_id, requested_by_person_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (rfp_id, org_id) DO NOTHING RETURNING *`,
          [id, rfpId, orgId, actor.personId],
        );
        if (!rows.length) {
          const { rows: existing } = await client.query(
            'SELECT * FROM tendering.bid_request WHERE rfp_id = $1 AND org_id = $2', [rfpId, orgId],
          );
          return { request: existing[0], created: false };
        }
        await ledgerAndEvent(client, { type: 'tendering.bid_request.requested', request: rows[0], projectId, actor });
        return { request: rows[0], created: true };
      });
    },

    /**
     * Approve: the lane exists the instant the request says approved. The
     * invite is inserted with source asked_to_bid — or, when the issuer had
     * already invited the org's address by e-mail, that invite is ADOPTED
     * (org back-filled, source kept, no second link) exactly as the D-40
     * Slice 1 apply did. Returns { request, recipient, token } (token null on
     * adoption: that address already holds its link), or null when the
     * request was decided meanwhile.
     */
    async approveBidRequest({ requestId, rfpId, projectId, orgId, email, actor }) {
      return tx(async (client) => {
        const { rows: pending } = await client.query(
          `SELECT * FROM tendering.bid_request WHERE id = $1 AND status = 'pending' FOR UPDATE`, [requestId],
        );
        if (!pending.length) return null;
        const token = randomBytes(32).toString('hex');
        const { rows: recRows } = await client.query(
          `INSERT INTO tendering.rfp_recipient (id, rfp_id, org_id, email, token_hash, expires_at, source)
           VALUES ($1, $2, $3, $4, $5,
             (SELECT submission_deadline + interval '14 days' FROM tendering.rfp WHERE id = $2), 'asked_to_bid')
           ON CONFLICT (rfp_id, email) DO UPDATE
             SET org_id = COALESCE(tendering.rfp_recipient.org_id, EXCLUDED.org_id)
           RETURNING *, (xmax = 0) AS inserted`,
          [randomUUID(), rfpId, orgId, email, sha256(token)],
        );
        const recipient = recRows[0];
        const { rows: lanes } = await client.query('SELECT id, bidder_org_id FROM tendering.proposal WHERE recipient_id = $1', [recipient.id]);
        if (!lanes.length) {
          await client.query(
            'INSERT INTO tendering.proposal (id, rfp_id, recipient_id, bidder_org_id) VALUES ($1, $2, $3, $4)',
            [randomUUID(), rfpId, recipient.id, orgId],
          );
        } else if (lanes[0].bidder_org_id == null) {
          await client.query('UPDATE tendering.proposal SET bidder_org_id = $2 WHERE id = $1', [lanes[0].id, orgId]);
        }
        const { rows } = await client.query(
          `UPDATE tendering.bid_request
              SET status = 'approved', decided_by_person_id = $2, decided_at = now(), recipient_id = $3
            WHERE id = $1 RETURNING *`,
          [requestId, actor.personId, recipient.id],
        );
        await ledgerAndEvent(client, {
          type: 'tendering.bid_request.approved', request: rows[0], projectId, actor,
          data: { adopted: !recipient.inserted },
        });
        return { request: rows[0], recipient, token: recipient.inserted ? token : null };
      });
    },

    async declineBidRequest({ requestId, projectId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.bid_request
              SET status = 'declined', decided_by_person_id = $2, decided_at = now()
            WHERE id = $1 AND status = 'pending' RETURNING *`,
          [requestId, actor.personId],
        );
        if (!rows.length) return null;
        await ledgerAndEvent(client, { type: 'tendering.bid_request.declined', request: rows[0], projectId, actor });
        return rows[0];
      });
    },

    // ── the company inbox (X-9, X-10) ──────────────────────────────────────

    /** "Requests for you": every non-draft RFP the org is invited to, newest first. */
    async requestsForOrg(orgId, { cursor, limit }) {
      const { rows } = await pool.query(
        `SELECT rec.id AS recipient_id, rec.rfp_id, rec.source, rec.status AS recipient_status,
                coalesce(rec.sent_at, rec.created_at) AS received_at, rec.created_at,
                r.title, r.level, r.project_id, r.status AS rfp_status, r.submission_deadline,
                r.awarded_proposal_id,
                (SELECT count(*) FROM tendering.rfp_package_row pr
                  WHERE pr.rfp_id = r.id AND pr.package_version = r.package_version) AS task_count,
                (CASE WHEN r.model_document_id IS NULL THEN 0 ELSE 1 END) AS file_count,
                p.id AS proposal_id, p.status AS proposal_status
           FROM tendering.rfp_recipient rec
           JOIN tendering.rfp r ON r.id = rec.rfp_id
           LEFT JOIN tendering.proposal p ON p.recipient_id = rec.id
          WHERE rec.org_id = $1 AND rec.revoked_at IS NULL AND r.status <> 'draft'
            AND ($2::timestamptz IS NULL OR (rec.created_at, rec.id) < ($2::timestamptz, $3::uuid))
          ORDER BY rec.created_at DESC, rec.id DESC LIMIT $4`,
        [orgId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return { items: page, nextCursor: rows.length > limit ? { at: last.created_at, id: last.recipient_id } : null };
    },

    /**
     * "Open requests near you" in ONE statement (PRD-04 X-10, 0030): listed,
     * published RFPs still taking bids, minus the org's own and those it is
     * already invited to, that share a specialty with the company's family AND
     * whose build is within its radius of its base point, or in one of its
     * service areas (municipality, or district = its first two digits).
     * Nearest first (no distance last), then deadline, then id; keyset on that
     * order. `distance_km` is rounded to 0.1 km — what the wire shows.
     */
    async openRequestsFor({ orgId, family, base, radiusKm, areas, cursor = null, limit = 50 }) {
      const { rows } = await pool.query(
        `WITH scored AS (
           SELECT r.id, r.title, r.level, r.project_id, r.specialty_codes, r.submission_deadline,
                  (SELECT count(*) FROM tendering.rfp_package_row pr
                    WHERE pr.rfp_id = r.id AND pr.package_version = r.package_version) AS task_count,
                  CASE WHEN r.listing_lat IS NOT NULL AND $3::numeric IS NOT NULL
                       THEN tendering.distance_km(r.listing_lat, r.listing_lng, $3::numeric, $4::numeric)
                  END AS dist,
                  r.listing_municipality_code AS muni
             FROM tendering.rfp r
            WHERE r.listed AND r.status = 'published' AND r.submission_deadline > now()
              AND r.issuer_org_id <> $1
              AND r.specialty_codes && $2::text[]
              AND NOT EXISTS (SELECT 1 FROM tendering.rfp_recipient rec
                               WHERE rec.rfp_id = r.id AND rec.org_id = $1)
         ), matched AS (
           SELECT s.id, s.title, s.level, s.project_id, s.specialty_codes, s.submission_deadline, s.task_count,
                  to_char(s.submission_deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_key,
                  round(s.dist::numeric, 1) AS distance_km,
                  coalesce(round(s.dist::numeric, 1), 1e9) AS sort_km
             FROM scored s
            WHERE (s.dist IS NOT NULL AND $5::numeric IS NOT NULL AND s.dist <= $5::numeric)
               OR (s.muni IS NOT NULL AND (s.muni = ANY($6::text[]) OR left(s.muni, 2) = ANY($6::text[])))
         )
         SELECT * FROM matched
          WHERE $7::numeric IS NULL
             OR (sort_km, submission_deadline, id) > ($7::numeric, $8::timestamptz, $9::uuid)
          ORDER BY sort_km, submission_deadline, id
          LIMIT $10`,
        [orgId, family, base?.lat ?? null, base?.lng ?? null, radiusKm ?? null, areas ?? [],
          cursor?.k ?? null, cursor?.d ?? null, cursor?.id ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: rows.length > limit
          ? { k: String(last.sort_km), d: last.deadline_key, id: last.id } : null,
      };
    },

    /** The org's live invite on an RFP (decline guard), with its lane state. */
    async invitationOf(rfpId, orgId) {
      const { rows } = await pool.query(
        `SELECT rec.*, p.status AS lane_status FROM tendering.rfp_recipient rec
           LEFT JOIN tendering.proposal p ON p.recipient_id = rec.id
          WHERE rec.rfp_id = $1 AND rec.org_id = $2 AND rec.revoked_at IS NULL`,
        [rfpId, orgId],
      );
      return rows[0] ?? null;
    },

    /** One "Requests for you" item, by RFP (after a decline). */
    async requestForOrg(rfpId, orgId) {
      const { rows } = await pool.query(
        `SELECT rec.id AS recipient_id, rec.rfp_id, rec.source, rec.status AS recipient_status,
                coalesce(rec.sent_at, rec.created_at) AS received_at, rec.created_at,
                r.title, r.level, r.project_id, r.status AS rfp_status, r.submission_deadline,
                r.awarded_proposal_id,
                (SELECT count(*) FROM tendering.rfp_package_row pr
                  WHERE pr.rfp_id = r.id AND pr.package_version = r.package_version) AS task_count,
                (CASE WHEN r.model_document_id IS NULL THEN 0 ELSE 1 END) AS file_count,
                p.id AS proposal_id, p.status AS proposal_status
           FROM tendering.rfp_recipient rec
           JOIN tendering.rfp r ON r.id = rec.rfp_id
           LEFT JOIN tendering.proposal p ON p.recipient_id = rec.id
          WHERE rec.rfp_id = $1 AND rec.org_id = $2 AND rec.revoked_at IS NULL`,
        [rfpId, orgId],
      );
      return rows[0] ?? null;
    },

    /** The company says it will not bid: only while its lane is untouched. */
    async declineInvitation({ rfpId, recipientId, projectId, actor }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.rfp_recipient rec SET status = 'declined'
            WHERE rec.id = $1 AND rec.rfp_id = $2 AND rec.status <> 'declined'
              AND EXISTS (SELECT 1 FROM tendering.proposal p
                           WHERE p.recipient_id = rec.id AND p.status IN ('invited', 'draft'))
            RETURNING id`,
          [recipientId, rfpId],
        );
        if (!rows.length) return false;
        await appendAuditEvent(client, {
          projectId, actor,
          category: 'tendering',
          type: 'tendering.rfp.invitation_declined',
          scope: { type: 'project', id: projectId },
          object: { type: 'rfp', id: rfpId },
          // Who declined stays in tendering.* (D-29): the record notes that one did.
          payload: {},
          channel: actor.channel,
        });
        return true;
      });
    },

    // ── the directory links (X-2, PRD-04 §6 criterion 3) ────────────────────

    /** Address-only invitees of a sent RFP (the directory seeds their unclaimed profiles). */
    async emailInvitees(rfpId) {
      const { rows } = await pool.query(
        `SELECT DISTINCT lower(rec.email) AS email
           FROM tendering.rfp_recipient rec JOIN tendering.rfp r ON r.id = rec.rfp_id
          WHERE rec.rfp_id = $1 AND rec.org_id IS NULL AND rec.revoked_at IS NULL AND r.status <> 'draft'
          ORDER BY 1`,
        [rfpId],
      );
      const { rows: rfp } = await pool.query('SELECT specialty_codes FROM tendering.rfp WHERE id = $1', [rfpId]);
      return { emails: rows.map((r) => r.email), specialty_codes: rfp[0]?.specialty_codes ?? [] };
    },

    /**
     * The address's unclaimed profile was claimed by `orgId`: every past
     * invite to that address with no organisation gains it, and so do their
     * lanes. Never the claimant's own RFPs. Idempotent (only NULLs are filled).
     */
    async adoptClaimedAddress({ orgId, email }) {
      return tx(async (client) => {
        const { rows } = await client.query(
          `UPDATE tendering.rfp_recipient rec SET org_id = $1
             FROM tendering.rfp r
            WHERE r.id = rec.rfp_id AND rec.org_id IS NULL AND lower(rec.email) = lower($2)
              AND r.issuer_org_id <> $1
            RETURNING rec.id`,
          [orgId, email],
        );
        const ids = rows.map((r) => r.id);
        if (ids.length) {
          await client.query(
            'UPDATE tendering.proposal SET bidder_org_id = $1 WHERE recipient_id = ANY($2::uuid[]) AND bidder_org_id IS NULL',
            [orgId, ids],
          );
        }
        return ids.length;
      });
    },
  };
}

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}
