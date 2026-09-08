// The seat allowlist gate (ADR-0008), carried across the Clerk cutover.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
// The gate used to live inside the magic-link sign-in service: it declined to
// mint and mail a link to an address holding no active seat. LINA-124 deleted
// that service — Clerk owns authentication now — and the gate would have gone
// with it. It must not. `0004_identity.sql` states the reason plainly: the party
// path ends in `findOrCreateByEmail`, so WITHOUT a seat check, anyone who can
// prove control of any address on the internet becomes a party on a trust
// product. That was open registration before Clerk and it is open registration
// after; the only thing that changed is who verifies the address.
//
// So the gate MOVED rather than died. It now sits in the one place the portal
// turns a verified identity into a party (app/src/server/session.ts): a Clerk
// user with no active seat is authenticated but not admitted, and no party row
// is created for them.
//
// The privilege boundary from 0004 is unchanged and is the reason this is a
// read-only store: identity_app holds SELECT and nothing else on identity.seat,
// so the request path can never seat anybody. Seats are issued out of band
// (scripts/grant-seat.mjs, as migrator) and later by the billing webhook under
// its own role.
import { getPool } from '../ledger/db.mjs';
import { normalizeEmail } from './email-normalize.mjs';

export function createSeatStore({ pool = getPool() } = {}) {
  /**
   * Is there an active seat for this address? Normalises the same way seats are
   * granted, so `Ana@x.com` matches the seat granted to `ana@x.com`.
   * @param {unknown} email
   * @returns {Promise<boolean>}
   */
  async function hasActiveSeat(email) {
    const clean = normalizeEmail(email);
    if (!clean) return false;
    const { rowCount } = await pool.query(
      "select 1 from identity.seat where email = $1 and status = 'active' limit 1",
      [clean],
    );
    return rowCount > 0;
  }

  /**
   * The active seat for this address, or null. Carries `plan` — the entitlement
   * leg of ADR-0008 (LINA-189 / ADR-0013): what this person bought, which
   * decides how many builds they may RUN. `plans.mjs` turns it into an
   * allowance; this store never interprets it.
   *
   * Separate from `hasActiveSeat` on purpose. That one is the sign-in gate and
   * runs on every request that mints a party; it must stay a single existence
   * probe. This one runs only on the build-creation path.
   *
   * @param {unknown} email
   * @returns {Promise<{ email: string, source: string, plan: string|null }|null>}
   */
  async function activeSeat(email) {
    const clean = normalizeEmail(email);
    if (!clean) return null;
    const { rows } = await pool.query(
      "select email, source, plan from identity.seat where email = $1 and status = 'active' limit 1",
      [clean],
    );
    return rows[0] ? { email: rows[0].email, source: rows[0].source, plan: rows[0].plan ?? null } : null;
  }

  return { hasActiveSeat, activeSeat };
}

/**
 * An in-memory seat store for tests and for any composition that has no
 * database. Mirrors `identity.seat WHERE status='active'`.
 * @param {{ seats?: string[] }} [opts]
 */
export function createMemorySeatStore({ seats = [] } = {}) {
  // email -> { source, plan }. Accepts a bare address (no plan, like a beta or
  // invite seat) or `{ email, plan, source }` so a test can seat somebody on a
  // specific entitlement.
  const seated = new Map();
  const put = (entry) => {
    const raw = typeof entry === 'string' ? { email: entry } : entry ?? {};
    const clean = normalizeEmail(raw.email);
    if (clean) seated.set(clean, { source: raw.source ?? 'beta', plan: raw.plan ?? null });
  };
  seats.forEach(put);

  return {
    async hasActiveSeat(email) {
      const clean = normalizeEmail(email);
      return Boolean(clean && seated.has(clean));
    },
    async activeSeat(email) {
      const clean = normalizeEmail(email);
      const row = clean ? seated.get(clean) : null;
      return row ? { email: clean, source: row.source, plan: row.plan } : null;
    },
    // Test affordance only — production seats are granted out of band, and
    // identity_app holds no INSERT on identity.seat precisely so the request
    // path cannot seat anybody (0004_identity.sql).
    grant(email, { plan = null, source = 'beta' } = {}) {
      put({ email, plan, source });
    },
  };
}
