/**
 * Founding seats — counting them, and granting one (LINA-189).
 *
 * This is the ONE definition of "how many of the fifty are gone". The landing
 * page prints it, `/api/seats` serves it, and `/api/checkout` decides whether
 * paid CTAs go to the waitlist or to Stripe by it. They must never disagree:
 * a visitor who is told "31 / 50 claimed" and then hits a Stripe checkout page
 * has been lied to by one of the two.
 *
 * ── WHAT COUNTS AS CLAIMED ───────────────────────────────────────────────────
 * The number of `identity.seat` rows with `source='founding'` — that is, seats
 * actually GRANTED, not signups that expressed interest. This is deliberate and
 * it is the strict definition:
 *
 *   • It matches the hard cap. The database refuses founding seat 51
 *     (0010_identity.sql), so counting the same rows the cap counts means the
 *     counter can never promise a seat the database will then refuse.
 *   • An unconfirmed signup is not a claim. Anyone can type an address into a
 *     form; only clicking the link in that address's inbox proves anything. If
 *     mere signups burned seats, fifty submissions from one script would close
 *     the founding programme in a second.
 *
 * The cost is that the counter moves on confirmation rather than on submission,
 * so two people can both be told "49 / 50" and one of them will lose the race.
 * That is the honest failure: the loser is told the seats are gone and is left
 * on the waitlist, rather than being handed a seat that does not exist.
 */
import { sql } from 'drizzle-orm';

import { getDb, isDbConfigured } from '@/lib/db';
import { FOUNDING_SEATS_TOTAL } from '@/lib/pricing';

export type SeatCount = {
  claimed: number;
  total: number;
  remaining: number;
};

/** The seat source value the founding-50 programme grants under. */
const FOUNDING_SOURCE = 'founding';

/**
 * Postgres raises this when the cap trigger rejects seat 51. It is a normal,
 * expected outcome — "you were a moment too late" — and must be told apart from
 * a genuine database failure, which is not the user's fault and must not be
 * reported to them as a full house.
 */
const SEATS_EXHAUSTED = '23001'; // restrict_violation

function seatCount(claimed: number): SeatCount {
  const capped = Math.max(0, Math.min(claimed, FOUNDING_SEATS_TOTAL));
  return {
    claimed: capped,
    total: FOUNDING_SEATS_TOTAL,
    remaining: FOUNDING_SEATS_TOTAL - capped
  };
}

/**
 * How many founding seats are gone.
 *
 * Fails SOFT, to zero claimed. This number is rendered on the landing page and
 * gates the checkout flow, and neither has a sane "unknown" state to show. If
 * the database is unreachable the honest options are to break the page or to
 * assume seats remain; assuming seats remain keeps the visitor in the waitlist
 * funnel, where a human sees them, and the hard cap in the database means a
 * wrong optimistic count can still never over-issue a seat.
 */
export async function foundingSeats(): Promise<SeatCount> {
  if (!isDbConfigured()) return seatCount(0);
  try {
    const rows = await getDb().execute<{ cnt: number }>(
      sql`SELECT count(*)::int AS cnt FROM identity.seat WHERE source = ${FOUNDING_SOURCE}`
    );
    return seatCount(rows.rows?.[0]?.cnt ?? 0);
  } catch (err) {
    console.error('[seats] founding-seat count failed:', err);
    return seatCount(0);
  }
}

export type GrantResult =
  | { ok: true; alreadySeated: boolean }
  | { ok: false; reason: 'exhausted' | 'not_configured' | 'error' };

/**
 * Grant one founding seat to a confirmed address.
 *
 * `email` MUST already be normalised the way the seat gate normalises it
 * (`normalizeSeatEmail` below) or the seat will not match at sign-in and the
 * person will be bounced to /no-access holding a seat that exists.
 *
 * Idempotent: `identity.seat.email` is UNIQUE, so a replayed confirmation link
 * resolves to `alreadySeated` instead of an error or a second seat. Note that
 * `ON CONFLICT DO NOTHING` fires the BEFORE INSERT trigger first, so a repeat
 * confirmation once the fifty are gone reports 'exhausted' rather than
 * 'alreadySeated' — see the caller, which checks for an existing seat first.
 *
 * `plan` is the entitlement the seat is admitted under (LINA-189 / ADR-0013) —
 * the plan key the visitor chose on the pricing page, carried the whole way from
 * `landing.signups.plan`. It decides how many builds the portal lets them RUN;
 * `services/identity/plans.mjs` holds the allowances, and the column's CHECK
 * refuses any key the record does not know rather than seating somebody on an
 * allowance nobody can compute. Written on INSERT only: this role holds no
 * UPDATE on identity.seat, so a marketing page can never raise an entitlement —
 * upgrades are an out-of-band act under the billing webhook's own role.
 */
export async function grantFoundingSeat(
  email: string,
  note?: string,
  plan?: string | null
): Promise<GrantResult> {
  if (!isDbConfigured()) return { ok: false, reason: 'not_configured' };
  try {
    const rows = await getDb().execute<{ id: string }>(
      sql`INSERT INTO identity.seat (email, source, note, plan)
          VALUES (${email}, ${FOUNDING_SOURCE}, ${note ?? null}, ${plan ?? null})
          ON CONFLICT (email) DO NOTHING
          RETURNING id`
    );
    return { ok: true, alreadySeated: (rows.rows?.length ?? 0) === 0 };
  } catch (err) {
    if ((err as { code?: string })?.code === SEATS_EXHAUSTED) {
      return { ok: false, reason: 'exhausted' };
    }
    console.error('[seats] founding-seat grant failed:', err);
    return { ok: false, reason: 'error' };
  }
}

/** Does this address already hold a seat (of any source)? */
export async function hasSeat(email: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  try {
    const rows = await getDb().execute<{ one: number }>(
      sql`SELECT 1 AS one FROM identity.seat WHERE email = ${email} LIMIT 1`
    );
    return (rows.rows?.length ?? 0) > 0;
  } catch (err) {
    console.error('[seats] seat lookup failed:', err);
    return false;
  }
}

/**
 * The seat gate's email normalisation, duplicated on purpose.
 *
 * `services/identity/email-normalize.mjs` is the original and the portal reads
 * seats through it. The marketing site is a separate Next app that does not
 * import from `services/`, so this is a copy — and a copy of a normalisation
 * rule is a real hazard: if the two ever drift, a seat granted here silently
 * stops matching at sign-in, and the person who claimed it is told they have no
 * seat. Keep this trivial (trim + lower-case) and change both together.
 */
export function normalizeSeatEmail(email: unknown): string | null {
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : null;
}
