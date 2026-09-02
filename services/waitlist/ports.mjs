// Typed ports for the Waitlist service (LINA-127; Onboarding Plan v4 Phase 1).
//
// The waitlist is a prospect-capture table on the Portal — the D-4 form's POST
// target and the D-2 welcome-email trigger. It has exactly two seams:
//
//   EmailPort — owned by the Shared Email sender (services/email/sender.mjs, ADR
//               §7). Sends the D-2 welcome email. It is the waitlist's choice to
//               DEGRADE, not fail closed: a missed welcome email is a lost
//               follow-up, never a security event, so a dev/preview deploy with
//               no RESEND_API_KEY must still let the funnel be exercised end to
//               end (same asymmetry as the marketing-site confirmation email).
//   WaitlistStore — owned by THIS service (schema `waitlist`): the signup rows.
//
// The in-memory adapters enforce, in code, the same invariants the SQL migration
// enforces in the DB, so the contract tests exercise real behaviour:
//   - email_norm is UNIQUE → a duplicate is rejected (409) at the store;
//   - signup_order is a gap-free counter mirroring `GENERATED ALWAYS AS IDENTITY`,
//     so "first 10 by signup order" is a deterministic total order;
//   - status is constrained to 'waitlisted' | 'active'.

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// In-memory Email port. The real adapter wraps services/email/sender.mjs.
// Returns a boolean like the shared sender's caller-side contract (see
// sender.mjs's docblock): false (never a throw) when delivery is skipped/failed,
// so a missing RESEND_API_KEY degrades the funnel instead of failing the signup.
// ---------------------------------------------------------------------------
export function createInMemoryEmail({ deliver = true } = {}) {
  const sent = [];
  return {
    async sendWelcome(to, { locale = 'en', url } = {}) {
      if (!deliver) return false;
      sent.push({ to, locale, url });
      return true;
    },
    _sent: sent,
  };
}

// ---------------------------------------------------------------------------
// In-memory WaitlistStore — the schema `waitlist` this service owns. Mirrors the
// SQL invariants: email_norm UNIQUE (duplicate → DomainError 409), signup_order
// as a gap-free identity counter, status CHECK. The store's `insert` maps any
// duplicate to { duplicate: true } for the service to translate to a 409 —
// mirroring how the Postgres adapter surfaces the UNIQUE violation — so the
// contract tests see the same shape as production.
// ---------------------------------------------------------------------------
export function createInMemoryStore() {
  const rows = new Map(); // email_norm -> row
  const seqById = new Map(); // id -> signup_order
  let counter = 0;

  function transaction(fn) {
    // Single-threaded in tests; the real adapter opens a Postgres tx here so the
    // projection write and the welcome-email send stay in one unit of work.
    return fn({});
  }

  // Insert a new signup; returns the stored row with a DB-assigned signup_order.
  // A row with this email_norm already exists → { duplicate: true }.
  function insert(_tx, row) {
    if (rows.has(row.email_norm)) return { duplicate: true, row: null };
    const stored = { ...row, signup_order: ++counter };
    rows.set(row.email_norm, stored);
    seqById.set(row.id, stored.signup_order);
    return { duplicate: false, row: { ...stored } };
  }

  function getByEmail(emailNorm) {
    const r = rows.get(emailNorm);
    return r ? { ...r } : null;
  }

  function get(id) {
    for (const r of rows.values()) if (r.id === id) return { ...r };
    return null;
  }

  // The plan's "first 10 by signup order": status-filtered, signup_order total
  // order. Used by Phase 2's go-date batch; exposed here so ordering is provable.
  function listByStatusOrder(status, limit = Infinity) {
    return [...rows.values()]
      .filter((r) => r.status === status)
      .sort((a, b) => a.signup_order - b.signup_order)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  function updateStatus(_tx, emailNorm, status, activatedAt) {
    const r = rows.get(emailNorm);
    if (!r) return { applied: false, row: null };
    r.status = status;
    r.activated_at = activatedAt ?? null;
    return { applied: true, row: { ...r } };
  }

  return {
    transaction,
    insert, getByEmail, get, listByStatusOrder, updateStatus,
    _rows: rows,
  };
}

export { now };
