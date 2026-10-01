// The retained v1 auth bridge, on @modules (LINA-401).
//
// After the v2 cutover (Phase 11/12) the ONLY thing an authenticated request
// still needs from the old identity service is two reads on the `identity`
// schema — the seat gate and the email → party mapping:
//
//   • the ADR-0008 SEAT GATE  — "may this verified address come in at all"
//   • the email → PARTY mapping — the id-space join that preserves every
//     existing party's attribution history across the Clerk cutover (LINA-124)
//
// These lived in services/identity/{seats,parties}.mjs, reached from the app
// through `@services`. LINA-387/398 deleted the rest of the v1 surface, leaving
// `app/src/server/session.ts` (via seat-gate.ts) as the last executable
// `@services` importer and the sole entry on the CI v1-deprecation whitelist.
// This module relocates those two reads onto @modules so the app resolves them
// the same way the v2 viewer resolves person/org — over the shared v2 pool
// (`createIdentityStore(getPool())` in viewer.ts) — and the gate can run
// whitelist-free.
//
// Both tables are retained: waitlist/0004 dropped the data-orphaned v1 schemas
// (ledger, decision, change_order, schedule) but KEPT `identity` precisely for
// the seat gate and email→party map. The SQL below is copied verbatim from the
// files it replaces so the behaviour — normalisation, the open-registration
// guard, the upsert-not-read-then-write race safety — is unchanged.
//
// PRIVILEGE NOTE (ADR-0006 §1 / ADR-0026). The v1 store ran these over a
// dedicated pool that `SET ROLE identity_app` (SELECT on identity.seat, DML on
// identity.party and nothing else), so Postgres itself forbade the request path
// from seating anybody. On the shared v2 pool that boundary is now CODE-enforced
// rather than role-enforced: this store only ever SELECTs `identity.seat` (no
// INSERT path exists here), and the v2 identity mirror — more sensitive, and the
// authoritative person/org source — already runs on exactly this pool. Keeping a
// bespoke role-separated pool for just these two reads while the mirror does not
// would be inconsistent, not safer. Seats are still issued only out of band
// (scripts/grant-seat.mjs as migrator); the request path has no code that writes
// a seat.
import { normalizeEmail } from '../domain/email.mjs';

const PARTY_ROLES = new Set(['owner', 'contractor', 'viewer']);

const mapParty = (r) =>
  r && {
    id: r.id,
    displayName: r.display_name,
    email: r.email,
    role: r.role,
    // Whether this party has been through account setup (LINA-189). The portal
    // root reads it to send an unfinished profile (name guessed off Clerk, the
    // default `contractor` role) back to /onboarding/setup.
    setupComplete: r.setup_complete === true,
  };

/**
 * @param {{ query: Function }} pool node-postgres Pool (or any { query })
 */
export function createAuthBridgeStore(pool) {
  return {
    /**
     * Is there an active seat for this address? Normalises the same way seats
     * are granted, so `Ana@x.com` matches the seat granted to `ana@x.com`. A
     * single existence probe — it runs on every request that mints a party.
     * @param {unknown} email
     * @returns {Promise<boolean>}
     */
    async hasActiveSeat(email) {
      const clean = normalizeEmail(email);
      if (!clean) return false;
      const { rowCount } = await pool.query(
        "select 1 from identity.seat where email = $1 and status = 'active' limit 1",
        [clean],
      );
      return rowCount > 0;
    },

    /**
     * Turn the verified address into its party UUID, creating the row on first
     * sight. Deliberately an upsert on the UNIQUE(email) index, not a
     * read-then-write: two concurrent sign-ins with the same email must settle
     * on ONE party, never two.
     * @param {{ email: unknown, displayName?: string }} args
     */
    async findOrCreateByEmail({ email, displayName } = {}) {
      const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
      // Shallow validation: an address is only a lookup key in R0. The seat gate
      // (normalizeEmail, above) runs first, so anything reaching here is already
      // a well-formed address.
      if (!clean || !clean.includes('@')) {
        throw new Error('a valid email is required');
      }
      const name = (typeof displayName === 'string' && displayName.trim()) || clean.split('@')[0];
      const role = 'contractor';
      if (!PARTY_ROLES.has(role)) throw new Error(`role must be one of ${[...PARTY_ROLES].join(', ')}`);

      // ON CONFLICT makes a concurrent double sign-in converge on one row. The
      // no-op UPDATE (email = excluded.email) is what makes RETURNING yield the
      // existing row instead of nothing on conflict.
      const { rows } = await pool.query(
        `insert into identity.party (display_name, email, role)
         values ($1, $2, $3)
         on conflict (email) do update set email = excluded.email
         returning *`,
        [name, clean, role],
      );
      return mapParty(rows[0]);
    },
  };
}

/**
 * An in-memory auth bridge for tests and any composition with no database.
 * Mirrors `identity.seat WHERE status='active'` and `identity.party`.
 * @param {{ seats?: string[], parties?: Array<{ email: string, setupComplete?: boolean }> }} [opts]
 */
export function createMemoryAuthBridge({ seats = [], parties = [] } = {}) {
  const seated = new Set();
  for (const s of seats) {
    const clean = normalizeEmail(s);
    if (clean) seated.add(clean);
  }
  // email -> party row. Pre-seeded parties keep their setupComplete; a party
  // minted by findOrCreateByEmail defaults to the placeholder (false).
  const partyByEmail = new Map();
  let nextId = 1;
  for (const p of parties) {
    const clean = normalizeEmail(p.email);
    if (clean) {
      partyByEmail.set(clean, {
        id: `party-${nextId++}`,
        display_name: clean.split('@')[0],
        email: clean,
        role: 'contractor',
        setup_complete: p.setupComplete === true,
      });
    }
  }

  return {
    async hasActiveSeat(email) {
      const clean = normalizeEmail(email);
      return Boolean(clean && seated.has(clean));
    },
    async findOrCreateByEmail({ email, displayName } = {}) {
      const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!clean || !clean.includes('@')) throw new Error('a valid email is required');
      let row = partyByEmail.get(clean);
      if (!row) {
        const name = (typeof displayName === 'string' && displayName.trim()) || clean.split('@')[0];
        row = { id: `party-${nextId++}`, display_name: name, email: clean, role: 'contractor', setup_complete: false };
        partyByEmail.set(clean, row);
      }
      return mapParty(row);
    },
    // Test affordance only — production seats are granted out of band.
    grant(email) {
      const clean = normalizeEmail(email);
      if (clean) seated.add(clean);
    },
  };
}
