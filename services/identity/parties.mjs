// Party lookup/creation — the `identity.party` half of the Identity service
// (schema `identity`, migrations/0001_identity.sql; LINA-56).
//
// The record is keyed on a party UUID; something has to turn a real-world
// identifier — in R0, an email — into that UUID. That mapping is Identity's to
// own (the table comment calls it "the authoritative mapping"), so it lives here
// rather than in a route handler.
//
// Since LINA-124 the caller is the Clerk bridge (app/src/server/session.ts): it
// hands over the address CLERK verified, after the ADR-0008 seat gate has said
// that address may come in. The email is still the join key it always was, which
// is why the cutover kept every existing party's attribution intact.
//
// `findOrCreateByEmail` is deliberately an upsert on the UNIQUE(email) index and
// not a read-then-write: two concurrent sign-ins with the same email must settle
// on ONE party, never two. Email is lower-cased so `Ana@x.com` and `ana@x.com`
// are the same person.
import { getPool } from '../ledger/db.mjs';
import { badRequest } from './errors.mjs';

const mapParty = (r) => r && {
  id: r.id,
  displayName: r.display_name,
  email: r.email,
  role: r.role,
  // Whether this party has been through account setup (LINA-189). Exposed
  // because it is the ONLY way a surface can tell a finished profile from the
  // placeholder `findOrCreateByEmail` leaves behind — a name guessed off Clerk
  // and the default `contractor` role, neither of which the person chose. The
  // portal root reads it to send an unfinished profile back to setup.
  setupComplete: r.setup_complete === true,
};

const PARTY_ROLES = new Set(['owner', 'contractor', 'viewer']);

export function createPartyStore({ pool = getPool() } = {}) {
  async function getById(id) {
    const { rows } = await pool.query('select * from identity.party where id = $1', [id]);
    return mapParty(rows[0] ?? null);
  }

  async function findOrCreateByEmail({ email, displayName, role = 'contractor' }) {
    const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
    // Deliberately shallow validation: an address is only a lookup key in R0, and
    // this is not the place to litigate RFC 5322.
    if (!clean || !clean.includes('@')) throw badRequest('a valid email is required');
    const name = (typeof displayName === 'string' && displayName.trim()) || clean.split('@')[0];
    if (!PARTY_ROLES.has(role)) throw badRequest(`role must be one of ${[...PARTY_ROLES].join(', ')}`);

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
  }

  return { getById, findOrCreateByEmail };
}
